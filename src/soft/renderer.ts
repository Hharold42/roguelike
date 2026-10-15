/**
 * Софтверный voxel-space рендерер (CPU, один поток, без GPU).
 *
 * Мир — карта колонн (ColumnMap): кадр строится поэкранно-столбцовым проходом,
 * каждый пиксель пишется ровно один раз, глубина пикселя идёт в z-buffer.
 * Земля рисуется гладкой: высота, свет и цвет билинейно интерполируются между
 * колоннами. Сверху всего — палитра 6 уровней с дизерингом Байера 4×4,
 * инлайн при записи пикселя.
 *
 * Наклон камеры (pitch) — истинный: каждый столбец экрана марширует по
 * горизонтальному следу своей лучевой плоскости, а высоты проецируются через
 * настоящие fd/ud пинхол-камеры — мир поворачивается, а не «сползает».
 *
 * Трава — отдельный слой (grass.ts): поле колосков, детерминированных от
 * мировых координат; рисуется после мира с попиксельным z-test, кончики
 * качаются ветром (бегущая волна + порывы), колоски отклоняются от
 * пролетающей камеры (trample) и распрямляются за пару секунд.
 */

import { ColumnMap, FOG_COL, SKY_TOP, SUN_X, SUN_Z } from "./columnMap";
import type { GroundSample } from "./columnMap";
import { GrassField } from "./grass";
import { EntityLayer } from "./entities";
import type { DrawBeam, DrawBolt, DrawGadget, DrawGhost, DrawPlayer, DrawSpark, DrawWave } from "./entities";
import { BAYER, FOG_LUT, LEVELS, Z_FAR } from "./gfx";

// Старт марша почти у самых глаз: при взгляде отвесно вниз нижний луч бьёт в
// землю на ~0.03 вперёд, и всё ближе старта заливается цветом первой выборки
const Z_NEAR = 0.02;
// Адаптивный шаг марша: цель — не больше STEP_PX пикселей экрана за выборку.
// Базовый шаг 0.12 + 0.02·t годится у горизонта, но вблизи/при взгляде вниз
// даёт полосы по 15–20 px одного цвета, ползущие по земле вместе с камерой
const STEP_PX = 2; // 1 px даёт тот же вид, но в 2 раза дороже по CPU (замер: ~15 против ~8 мс)
const STEP_MIN = 0.004; // нижний предел шага по t (защита от вырождения)
const STEP_MIN_DH = 0.3; // пол |dh| в оценке скорости проекции (у уровня глаз она вырождается)
/** Горизонтальный FOV камеры */
export const HFOV = (74 * Math.PI) / 180;
const TARGET_HEIGHT = 240; // внутреннее разрешение по вертикали (ширина — по пропорциям окна)

/**
 * Крапчатая текстура земли: детерминированный хеш от мировых координат,
 * две октавы (0.5 и 2 юнита) → множитель яркости 0.88..1.10.
 * Ломает однородность цвета вблизи, ассетов не требует.
 */
function speckle(wx: number, wz: number): number {
  let h = Math.imul(Math.floor(wx * 2), 374761393) ^ Math.imul(Math.floor(wz * 2), 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  let h2 = Math.imul(Math.floor(wx * 0.5), 374761393) ^ Math.imul(Math.floor(wz * 0.5), 668265263) ^ 0x51f07a3d;
  h2 = Math.imul(h2 ^ (h2 >>> 13), 1274126177);
  h2 ^= h2 >>> 16;
  return 0.88 + 0.14 * ((h >>> 0) / 4294967296) + 0.08 * ((h2 >>> 0) / 4294967296);
}

// Scratch билинейного сэмпла земли для горячего цикла renderWorld (без GC)
const GS: GroundSample = { h: 0, light: 0, rgb: [0, 0, 0] };

export class SoftRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly map: ColumnMap;

  W = 320;
  H = 240;
  private focal = 0;
  /** Фокус при обычном FOV; зум умножает его (setZoom) */
  private baseFocal = 0;
  private img!: ImageData;
  private pix!: Uint8ClampedArray;
  private zbuf!: Float32Array; // глубина ближайшего окклюдера по пикселю (Z_FAR — небо)
  private sunAdd!: Float32Array; // гало солнца по столбцу

  // Камера кадра
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private sinY = 0;
  private cosY = 1;
  private sinP = 0; // pitch: > 0 — взгляд вверх
  private cosP = 1;
  private horizonSy = 0; // экранная строка истинного горизонта (для неба и солнца)

  /** Время кадра, с: ветер и распрямление травы. Выставлять ДО trample() и begin() */
  time = 0;
  /** Отладка: мировая сетка 1×1 поверх земли (клавиша G) — проверка геометрии/растяжения */
  debugGrid = false;
  /** Поле колосков травы (отдельный слой поверх мира) */
  private readonly grass: GrassField;
  /** Игроки, заряды, искры, палочка (entities.ts) */
  private readonly entities = new EntityLayer();

  constructor(canvas: HTMLCanvasElement, map: ColumnMap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.map = map;
    this.grass = new GrassField(map);
    this.resize();
  }

  /** Пересчитать внутреннее разрешение под пропорции окна */
  resize(): void {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.H = TARGET_HEIGHT;
    this.W = Math.round((TARGET_HEIGHT * aspect) / 2) * 2;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.img = this.ctx.createImageData(this.W, this.H);
    this.pix = this.img.data;
    this.zbuf = new Float32Array(this.W * this.H);
    this.sunAdd = new Float32Array(this.W);
    this.baseFocal = this.W / 2 / Math.tan(HFOV / 2);
    this.focal = this.baseFocal;
  }

  /** Приближение камеры: 1 — обычный FOV, 2 — вдвое уже (вызывать до begin каждый кадр) */
  setZoom(zoom: number): void {
    this.focal = this.baseFocal * zoom;
  }

  /**
   * Проекция мировой точки на экран текущей камеры (после begin): доли экрана
   * 0..1 по x и y и расстояние вдоль взгляда; null — точка за спиной.
   */
  project(x: number, y: number, z: number): { sx: number; sy: number; depth: number } | null {
    const dx = x - this.camX;
    const dy = y - this.camY;
    const dz = z - this.camZ;
    const { sinY, cosY, sinP, cosP } = this;
    const depth = dx * sinY * cosP + dy * sinP + dz * cosY * cosP;
    if (depth < 0.3) return null;
    const right = dx * cosY - dz * sinY;
    const up = -dx * sinY * sinP + dy * cosP - dz * cosY * sinP;
    return {
      sx: (this.W / 2 + (right / depth) * this.focal) / this.W,
      sy: (this.H / 2 - (up / depth) * this.focal) / this.H,
      depth,
    };
  }

  // ---------- Кадр ----------

  /** Начать кадр: небо + мир + трава. pitch — радианы, > 0 — взгляд вверх */
  begin(camX: number, camY: number, camZ: number, yaw: number, pitch: number): void {
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    this.sinY = Math.sin(yaw);
    this.cosY = Math.cos(yaw);
    this.sinP = Math.sin(pitch);
    this.cosP = Math.cos(pitch);
    // Строка истинного горизонта; может уходить далеко за край экрана — нормально
    this.horizonSy = this.H / 2 + (this.sinP / this.cosP) * this.focal;
    this.renderSky();
    this.renderWorld();
    // Трава — поверх мира с попиксельным z-test
    if (this.debugGrid) return; // сетку не закрываем травой
    this.grass.time = this.time;
    this.grass.render(this.pix, this.zbuf, this.W, this.H, this.focal, camX, camY, camZ, this.sinY, this.cosY, this.sinP, this.cosP);
  }

  /**
   * Отпечаток в траве: колоски кругом радиуса r отклоняются от точки (x, z)
   * и распрямляются за ~1–2 с. Вызывать каждый кадр. См. grass.ts.
   */
  trample(x: number, z: number, r: number): void {
    this.grass.trample(x, z, r);
  }

  /** Постройки, игроки, заряды, искры и эхолокация поверх мира (вызывать после begin, до end) */
  drawEntities(
    players: Iterable<DrawPlayer>,
    bolts: Iterable<DrawBolt>,
    sparks: Iterable<DrawSpark>,
    gadgets: Iterable<DrawGadget>,
    beams: Iterable<DrawBeam>,
    ghosts: readonly DrawGhost[],
    waves: readonly DrawWave[],
  ): void {
    this.entities.render(
      this.pix,
      this.zbuf,
      { W: this.W, H: this.H, focal: this.focal, x: this.camX, y: this.camY, z: this.camZ, sinY: this.sinY, cosY: this.cosY, sinP: this.sinP, cosP: this.cosP },
      players,
      bolts,
      sparks,
      gadgets,
      beams,
      this.time,
      { boxes: this.map.structures.boxes, ghosts, waves, groundAt: this.groundAt },
    );
  }

  private readonly groundAt = (x: number, z: number): number => this.map.heightAt(x, z);

  /** Палочка в руке поверх всего кадра (после drawEntities, до end) */
  drawWand(color: number, kick: number, t: number, move: number, charge = 0): void {
    this.entities.drawWand(this.pix, this.W, this.H, color, kick, t, move, charge);
  }

  /** Вывести кадр на канвас */
  end(): void {
    this.ctx.putImageData(this.img, 0, 0);
  }

  // ---------- Небо и мир ----------

  private renderSky(): void {
    const { W, H, focal, pix, sunAdd } = this;
    this.zbuf.fill(Z_FAR); // небо — бесконечность, мир перезапишет свои пиксели
    for (let x = 0; x < W; x++) {
      const u = (x - W / 2) / focal;
      const dx = this.sinY + u * this.cosY;
      const dz = this.cosY - u * this.sinY;
      const inv = 1 / Math.hypot(dx, dz);
      const dot = Math.max(0, (dx * SUN_X + dz * SUN_Z) * inv);
      sunAdd[x] = Math.pow(dot, 24) * 0.9;
    }
    // Градиент привязан к истинному горизонту: выше horizonSy — небо,
    // ниже — дымка в цвет тумана (её перекроет мир). horizonSy может быть
    // за пределами экрана — тогда весь фон небо или дымка целиком.
    const hs = this.horizonSy;
    for (let y = 0; y < H; y++) {
      const t = hs > 0 ? Math.min(1, y / hs) : 1;
      const fall = hs > 0 ? Math.max(0, 1 - y / hs) : 0;
      const r0 = SKY_TOP[0] + (FOG_COL[0] - SKY_TOP[0]) * t;
      const g0 = SKY_TOP[1] + (FOG_COL[1] - SKY_TOP[1]) * t;
      const b0 = SKY_TOP[2] + (FOG_COL[2] - SKY_TOP[2]) * t;
      let i = y * W * 4;
      const brow = (y & 3) << 2;
      for (let x = 0; x < W; x++) {
        const s = sunAdd[x] * fall;
        const d = BAYER[brow | (x & 3)];
        pix[i] = 255 * Math.min(1, Math.floor((r0 + s) * LEVELS + d) / LEVELS);
        pix[i + 1] = 255 * Math.min(1, Math.floor((g0 + s * 0.85) * LEVELS + d) / LEVELS);
        pix[i + 2] = 255 * Math.min(1, Math.floor((b0 + s * 0.6) * LEVELS + d) / LEVELS);
        pix[i + 3] = 255;
        i += 4;
      }
    }
  }

  private renderWorld(): void {
    const { W, H, focal, pix, zbuf, map } = this;
    const sinP = this.sinP;
    const cosP = this.cosP;
    const halfH = H / 2;
    // Вектор right камеры (горизонтален): сдвиг вдоль него меняет только
    // латеральную координату точки — основа ньютоновской поправки ниже
    const rightX = this.cosY;
    const rightZ = -this.sinY;
    for (let x = 0; x < W; x++) {
      const u = (x - W / 2) / focal;
      // Направление марша — горизонтальный след лучевой плоскости столбца;
      // при наклоне камеры шаг по земле сжимается на cosP (истинный pitch)
      const dirX = this.sinY + u * this.cosY * cosP;
      const dirZ = this.cosY - u * this.sinY * cosP;
      const uSinP = u * sinP;
      const brow = x & 3; // столбец матрицы Байера
      let yb = H;
      let t = Z_NEAR;
      while (t < Z_FAR && yb > 0) {
        let wx = this.camX + dirX * t;
        let wz = this.camZ + dirZ * t;
        // Земля билинейно сглажена: плавные холмы без сетки колонн
        if (!map.sampleGround(wx, wz, GS)) {
          t += 0.12 + t * 0.02;
          continue; // вне мира — остаётся дымка
        }
        let h = GS.h;
        let dh = h - this.camY;
        // Ньютоновская поправка: при pitch ≠ 0 точка горизонтального следа не
        // лежит в наклонной лучевой плоскости столбца (боковая ошибка
        // δ = u·Δh·sinP — мир «плывёт» к краям). Досдвигаем точку вдоль right
        // на δ — она оказывается точно в своей плоскости: пиксель-в-пиксель
        // пинхол-камера при любом наклоне. При ровном взгляде поправка нулевая.
        const corr = uSinP * dh;
        if (corr > 0.02 || corr < -0.02) {
          wx += rightX * corr;
          wz += rightZ * corr;
          if (map.sampleGround(wx, wz, GS)) h = GS.h; // вне мира — старая высота
          dh = h - this.camY;
        }
        // Истинная проекция пинхол-камеры с наклоном: fd — дальность вперёд,
        // ud — высота над плоскостью взгляда
        const fd = t * cosP + dh * sinP;
        if (fd < 0.05) {
          t += 0.12 + t * 0.02;
          continue; // точка за плоскостью кадра (крутой взгляд вверх)
        }
        const sy = halfH - ((dh * cosP - t * sinP) * focal) / fd;
        if (sy < yb) {
          const y0 = sy < 0 ? 0 : Math.ceil(sy);
          // Билинейный цвет (палитра + биом + снег) × сглаженный свет; вблизи — крап
          let k = 0.45 + 0.55 * GS.light;
          if (t < 35) k *= 1 + (speckle(wx, wz) - 1) * (1 - t / 35);
          let r = GS.rgb[0] * k;
          let g = GS.rgb[1] * k;
          let b = GS.rgb[2] * k;
          if (this.debugGrid) {
            // Мировая сетка 1×1: линии x=const красные, z=const синие, каждая 8-я
            // жёлтая. Толщина растёт с дальностью, чтобы линия была ~2 px на экране
            const th = 0.02 + 0.007 * fd;
            const gx = wx - Math.floor(wx);
            const gz = wz - Math.floor(wz);
            const onX = gx < th || gx > 1 - th;
            const onZ = gz < th || gz > 1 - th;
            if (onX || onZ) {
              const major = onX ? (Math.round(wx) & 7) === 0 : (Math.round(wz) & 7) === 0;
              r = major ? 1 : onX ? 0.95 : 0.1;
              g = major ? 0.9 : onX ? 0.1 : 0.3;
              b = major ? 0.1 : onX ? 0.1 : 1;
            }
          }
          const fz = (fd / Z_FAR) * 511;
          const f = FOG_LUT[fz > 511 ? 511 : fz | 0];
          r += (FOG_COL[0] - r) * f;
          g += (FOG_COL[1] - g) * f;
          b += (FOG_COL[2] - b) * f;
          const rL = r * LEVELS;
          const gL = g * LEVELS;
          const bL = b * LEVELS;
          for (let y = y0; y < yb; y++) {
            const pi = y * W + x;
            zbuf[pi] = fd;
            const d = BAYER[((y & 3) << 2) | brow];
            const i = pi * 4;
            pix[i] = 255 * Math.min(1, Math.floor(rL + d) / LEVELS);
            pix[i + 1] = 255 * Math.min(1, Math.floor(gL + d) / LEVELS);
            pix[i + 2] = 255 * Math.min(1, Math.floor(bL + d) / LEVELS);
            pix[i + 3] = 255;
          }
          yb = y0;
          if (y0 === 0) break;
        }
        // Шаг по экрану: у плоской земли sy меняется на focal·|dh|/fd² пикселей
        // на единицу t (sy' = focal·(dh − s·t)/fd², наклоном s пренебрегаем).
        // Пока точка видна — шагаем ~STEP_PX; пока она ниже/за уже закрытой
        // частью столбца — можно прыгать на половину расстояния до yb (сходится
        // за log шагов). Сверху ограничено прежним шагом — дальний план не дороже.
        const adh = dh < 0 ? -dh : dh;
        const rate = (focal * (adh > STEP_MIN_DH ? adh : STEP_MIN_DH)) / (fd * fd);
        let px = (sy - yb) * 0.5;
        if (px < STEP_PX) px = STEP_PX;
        let step = px / rate;
        const base = 0.12 + t * 0.02;
        if (step > base) step = base;
        else if (step < STEP_MIN) step = STEP_MIN;
        t += step;
      }
    }
  }
}
