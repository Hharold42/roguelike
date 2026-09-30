/**
 * Софтверный voxel-space рендерер игры (CPU, один поток, без GPU).
 *
 * Мир — карта колонн (ColumnMap): кадр строится поэкранно-столбцовым проходом,
 * каждый пиксель пишется ровно один раз, глубина пикселя идёт в z-buffer.
 * Грани спанов (верх стены, подошва уступа) получают тёмную кромку — аутлайн.
 * Поверх — билборд-спрайты с попиксельным клиппингом по z-buffer'у, светящиеся
 * линии (трассеры, молнии), кольца на земле (взрывы, ауры, сектор меча),
 * вьюмодель оружия и виньетка урона.
 * Сверху всего — палитра 6 уровней с дизерингом Байера 4×4, инлайн при записи.
 *
 * Наклон камеры (pitch) — истинный: каждый столбец экрана марширует по
 * горизонтальному следу своей лучевой плоскости, а высоты проецируются через
 * настоящие fd/ud пинхол-камеры — мир поворачивается, а не «сползает».
 * Прицеливание согласовано (см. aimDir в game.ts — тот же базис камеры).
 *
 * Трава — отдельный слой (grass.ts): поле колосков, детерминированных от
 * мировых координат; рисуется после мира с попиксельным z-test, кончики
 * качаются ветром (бегущая волна + порывы), колоски отклоняются от
 * проходящих акторов (trample) и распрямляются за пару секунд.
 */

import { ColumnMap, FOG_COL, SKY_TOP, STRUCT_COL, SUN_X, SUN_Z, WALL_COL } from "./columnMap";
import type { GroundSample } from "./columnMap";
import { GrassField } from "./grass";
import { BAYER, FOG_LUT, LEVELS, Z_FAR } from "./gfx";
import type { Sprite } from "./sprites";

const Z_NEAR = 0.5;
const HFOV = (74 * Math.PI) / 180;
const TARGET_HEIGHT = 240; // внутреннее разрешение по вертикали (ширина — по пропорциям окна)

const MAX_SPRITES = 512; // очередь спрайтов на кадр
const RING_POINTS = 26; // точек в кольце на земле
const BOLT_LIFE = 0.18;
const BLAST_LIFE = 0.35;
const CORPSE_LIFE = 0.4;
const ARC_LIFE = 0.22; // сектор взмаха меча

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
const GS: GroundSample = { h: 0, ground: 0, light: 0, rgb: [0, 0, 0] };

/** Тинт спрайта — любой объект с каналами r/g/b (Color3 тоже подходит) */
export interface Tint {
  r: number;
  g: number;
  b: number;
}

interface QueuedSprite {
  spr: Sprite;
  x: number;
  yBase: number;
  z: number;
  wh: number; // мировая высота
  ww: number; // мировая ширина
  tint: Tint;
  flash: number; // 0..1 подмешивание красного (урон)
  bright: number; // 0..1 — доля «самосвечения» (слабее туман)
  fd: number; // проекция: дистанция вперёд
  ld: number; // проекция: вбок
}

interface Blast {
  x: number;
  y: number;
  z: number;
  radius: number;
  r: number;
  g: number;
  b: number;
  life: number;
}

interface Bolt {
  pts: { x: number; y: number; z: number }[];
  life: number;
}

interface Corpse {
  x: number;
  y: number;
  z: number;
  scale: number;
  tint: Tint;
  life: number;
}

interface Arc {
  x: number;
  y: number;
  z: number;
  radius: number;
  center: number; // курс середины дуги, рад
  half: number; // половина ширины дуги, рад
  life: number;
}

export class SoftRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly map: ColumnMap;

  W = 320;
  H = 240;
  focal = 0;
  private baseFocal = 0;
  /** Масштаб фокуса на кадр (FOV-кик рывка): >1 — шире угол, эффект скорости */
  fovScale = 1;
  private img!: ImageData;
  private pix!: Uint8ClampedArray;
  private zbuf!: Float32Array; // глубина ближайшего окклюдера по пикселю (Z_FAR — небо)
  private sunAdd!: Float32Array; // гало солнца по столбцу
  private edgeMask!: Uint8Array; // виньетка для вспышки урона

  // Камера кадра
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private sinY = 0;
  private cosY = 1;
  private sinP = 0; // pitch: > 0 — взгляд вверх
  private cosP = 1;
  private horizonSy = 0; // экранная строка истинного горизонта (для неба и солнца)

  /** Время кадра, с: распрямление травы. Выставлять ДО trample() и begin() */
  time = 0;
  /** Поле колосков травы (отдельный слой поверх мира, до спрайтов) */
  private readonly grass: GrassField;

  // Очереди кадра
  private sprites: QueuedSprite[] = [];
  private streaks: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; r: number; g: number; b: number }[] = [];
  private rings: { x: number; y: number; z: number; radius: number; r: number; g: number; b: number; arcCenter: number | null; arcHalf: number }[] = [];
  private view: { spr: Sprite; x: number; y: number; scale: number }[] = [];
  private flashAlpha = 0;

  // Эффекты с временем жизни
  private blasts: Blast[] = [];
  private bolts: Bolt[] = [];
  private corpses: Corpse[] = [];
  private arcs: Arc[] = [];

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
    // Виньетка: 0 в центре → 255 по краям
    this.edgeMask = new Uint8Array(this.W * this.H);
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const nx = (x / this.W - 0.5) * 2;
        const ny = (y / this.H - 0.5) * 2;
        const d = Math.min(1, Math.sqrt(nx * nx + ny * ny) / 1.3);
        this.edgeMask[y * this.W + x] = (d * d * 255) | 0;
      }
    }
  }

  // ---------- Кадр ----------

  /** Начать кадр: небо + мир. pitch — радианы, > 0 — взгляд вверх */
  begin(camX: number, camY: number, camZ: number, yaw: number, pitch: number): void {
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    this.sinY = Math.sin(yaw);
    this.cosY = Math.cos(yaw);
    this.sinP = Math.sin(pitch);
    this.cosP = Math.cos(pitch);
    this.focal = this.baseFocal * this.fovScale;
    // Строка истинного горизонта; может уходить далеко за край экрана — нормально
    this.horizonSy = this.H / 2 + (this.sinP / this.cosP) * this.focal;
    this.sprites.length = 0;
    this.streaks.length = 0;
    this.rings.length = 0;
    this.view.length = 0;
    this.flashAlpha = 0;
    this.renderSky();
    this.renderWorld();
    // Трава — поверх мира с попиксельным z-test, до спрайтов (они тонут в ней)
    this.grass.time = this.time;
    this.grass.render(this.pix, this.zbuf, this.W, this.H, this.focal, camX, camY, camZ, this.sinY, this.cosY, this.sinP, this.cosP);
  }

  /** Поставить спрайт в очередь кадра (рисуются в end, дальние первыми) */
  sprite(spr: Sprite, x: number, yBase: number, z: number, worldH: number, worldW: number, tint: Tint, flash = 0, bright = 0): void {
    const dx = x - this.camX;
    const dz = z - this.camZ;
    const fd = dx * this.sinY + dz * this.cosY;
    if (fd < 0.4 || fd > Z_FAR || this.sprites.length >= MAX_SPRITES) return;
    const ld = dx * this.cosY - dz * this.sinY;
    this.sprites.push({ spr, x, yBase, z, wh: worldH, ww: worldW, tint, flash, bright, fd, ld });
  }

  /** Светящаяся линия в мире (трассер, сегмент молнии) */
  streak(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, r: number, g: number, b: number): void {
    this.streaks.push({ x1, y1, z1, x2, y2, z2, r, g, b });
  }

  /** Кольцо на земле; arcCenter/arcHalf (рад) — только дуга (сектор меча) */
  ring(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, arcCenter: number | null = null, arcHalf = Math.PI): void {
    this.rings.push({ x, y, z, radius, r, g, b, arcCenter, arcHalf });
  }

  /** Вьюмодель поверх кадра (координаты — экранные); вызовы складываются (оружие + вспышка) */
  viewmodel(spr: Sprite, x: number, y: number, scale: number): void {
    this.view.push({ spr, x, y, scale });
  }

  /** Красная виньетка урона, alpha 0..1 на этот кадр */
  damageFlash(alpha: number): void {
    this.flashAlpha = alpha;
  }

  /**
   * Отпечаток актора в траве: колоски кругом радиуса r отклоняются от точки
   * (x, z) и распрямляются за ~1–2 с. Вызывать каждый кадр для каждого
   * существа рядом с камерой. См. grass.ts.
   */
  trample(x: number, z: number, r: number): void {
    this.grass.trample(x, z, r);
  }

  // --- Эффекты с временем жизни ---

  addBlast(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void {
    this.blasts.push({ x, y, z, radius, r, g, b, life: BLAST_LIFE });
  }

  addBolt(pts: { x: number; y: number; z: number }[]): void {
    this.bolts.push({ pts, life: BOLT_LIFE });
  }

  addCorpse(x: number, y: number, z: number, scale: number, tint: Tint): void {
    if (this.corpses.length > 96) this.corpses.shift();
    this.corpses.push({ x, y, z, scale, tint, life: CORPSE_LIFE });
  }

  /** Сектор взмаха меча: дуга на земле, гаснет за ARC_LIFE */
  addArc(x: number, y: number, z: number, radius: number, center: number, half: number): void {
    this.arcs.push({ x, y, z, radius, center, half, life: ARC_LIFE });
  }

  /** Дорисовать спрайты, эффекты, вьюмодель и вывести кадр; dt — для старения эффектов */
  end(dt: number): void {
    this.drawSprites();
    this.drawEffects(dt);
    this.drawStreaks();
    this.drawRings();
    for (const v of this.view) this.drawViewmodel(v);
    if (this.flashAlpha > 0.01) this.drawFlash();
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
    const colH = map.colH;
    const colKind = map.colKind;
    const colLight = map.colLight;
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
      let yb = H;
      let t = Z_NEAR;
      const brow = x & 3;
      while (t < Z_FAR && yb > 0) {
        let wx = this.camX + dirX * t;
        let wz = this.camZ + dirZ * t;
        let ci = map.columnIndexAt(wx, wz);
        // Блоками рисуются только мегаструктуры (брутализм — стиль); земля и
        // валуны — билинейно сглажены: плавные холмы и скруглённые скалы.
        let solid = ci >= 0 && colKind[ci] >= 2;
        let h: number;
        if (solid) {
          h = colH[ci];
        } else {
          if (!map.sampleGround(wx, wz, GS)) {
            t += 0.12 + t * 0.02;
            continue;
          }
          h = GS.h;
        }
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
          ci = map.columnIndexAt(wx, wz);
          if (ci >= 0 && colKind[ci] >= 2) {
            solid = true;
            h = colH[ci];
          } else if (map.sampleGround(wx, wz, GS)) {
            solid = false;
            h = GS.h;
          } // незапечённое — остаёмся на нескорректированной высоте
          dh = h - this.camY;
        }
        // Истинная проекция пинхол-камеры с наклоном: fd — дальность вперёд,
        // ud — высота над плоскостью взгляда (см. project — тот же базис)
        const fd = t * cosP + dh * sinP;
        if (fd < 0.05) {
          t += 0.12 + t * 0.02;
          continue; // точка за плоскостью кадра (крутой взгляд вверх)
        }
        const sy = halfH - ((dh * cosP - t * sinP) * focal) / fd;
        if (sy < yb) {
          const y0 = sy < 0 ? 0 : Math.ceil(sy);
          let r: number, g: number, b: number;
          let fogScale = 1;
          if (solid) {
            // Мегаструктуры: мёртвый бетон, сквозь дымку читаются силуэтом (мегалофобия)
            const s = (0.55 + 0.45 * (colLight[ci] / 255)) * 0.9;
            r = STRUCT_COL[0] * s;
            g = STRUCT_COL[1] * s;
            b = STRUCT_COL[2] * s;
            fogScale = 0.55;
          } else {
            // Земля и валуны: билинейный цвет (палитра + биом + снег) × сглаженный
            // свет; скала — подмешивание WALL_COL по превышению над рельефом
            // (подошва склона землистая, гребень — каменный); вблизи — крап
            const s = 0.45 + 0.55 * GS.light;
            let k = s;
            if (t < 35) k *= 1 + (speckle(wx, wz) - 1) * (1 - t / 35);
            let rock = (GS.h - GS.ground) / 1.1;
            rock = rock <= 0 ? 0 : rock >= 1 ? 1 : rock;
            r = (GS.rgb[0] + (WALL_COL[0] - GS.rgb[0]) * rock) * k;
            g = (GS.rgb[1] + (WALL_COL[1] - GS.rgb[1]) * rock) * k;
            b = (GS.rgb[2] + (WALL_COL[2] - GS.rgb[2]) * rock) * k;
          }
          const fz = (fd / Z_FAR) * 511;
          const f = FOG_LUT[fz > 511 ? 511 : fz | 0] * fogScale;
          r += (FOG_COL[0] - r) * f;
          g += (FOG_COL[1] - g) * f;
          b += (FOG_COL[2] - b) * f;
          const rL = r * LEVELS;
          const gL = g * LEVELS;
          const bL = b * LEVELS;
          // Аутлайн: верхняя кромка спана (силуэт против неба/дали) и нижняя
          // (подошва уступа) затемняются — только у сооружений; земля и скалы
          // гладкие, тёмные кромки превратили бы их в полосы.
          const spanH = yb - y0;
          const topEdge = solid ? (spanH >= 18 ? 2 : spanH >= 3 ? 1 : 0) : 0;
          const botEdge = solid && spanH >= 10 ? 1 : 0;
          for (let y = y0; y < yb; y++) {
            const k = y - y0 < topEdge || yb - y <= botEdge ? 0.38 : 1;
            const pi = y * W + x;
            zbuf[pi] = fd;
            const d = BAYER[((y & 3) << 2) | brow];
            const i = pi * 4;
            pix[i] = 255 * Math.min(1, Math.floor(rL * k + d) / LEVELS);
            pix[i + 1] = 255 * Math.min(1, Math.floor(gL * k + d) / LEVELS);
            pix[i + 2] = 255 * Math.min(1, Math.floor(bL * k + d) / LEVELS);
            pix[i + 3] = 255;
          }
          yb = y0;
          if (y0 === 0) break;
        }
        t += 0.12 + t * 0.02;
      }
    }
  }

  // ---------- Спрайты ----------

  private drawSprites(): void {
    const list = this.sprites;
    list.sort((a, b) => b.fd - a.fd);
    for (const s of list) this.drawSprite(s);
  }

  private drawSprite(s: QueuedSprite): void {
    const { W, H, focal, pix, zbuf } = this;
    // Истинная проекция подошвы и макушки (учитывает pitch камеры)
    const pb = this.project(s.x, s.yBase, s.z);
    if (!pb) return;
    const pt = this.project(s.x, s.yBase + s.wh, s.z);
    if (!pt) return;
    const fd = pb.fd;
    const cx = pb.sx;
    const yBot = pb.sy;
    const yTop = pt.sy;
    const halfW = ((s.ww * focal) / fd) * 0.5;
    const x0 = Math.max(0, Math.ceil(cx - halfW));
    const x1 = Math.min(W - 1, Math.floor(cx + halfW));
    if (x1 < x0) return;
    const yA = Math.max(0, Math.ceil(yTop));
    const yB = Math.min(H, Math.ceil(yBot));
    if (yB <= yA) return;

    const fz = (fd / Z_FAR) * 511;
    const f = FOG_LUT[fz > 511 ? 511 : fz | 0] * (1 - s.bright * 0.7);
    const sh = yBot - yTop;
    const sw = halfW * 2;

    // Совсем мелкий спрайт — пятном тинта без сэмплирования текстуры
    if (sh < 5) {
      const r = s.tint.r + (FOG_COL[0] - s.tint.r) * f;
      const g = s.tint.g + (FOG_COL[1] - s.tint.g) * f;
      const b = s.tint.b + (FOG_COL[2] - s.tint.b) * f;
      const rL = r * LEVELS;
      const gL = g * LEVELS;
      const bL = b * LEVELS;
      for (let x = x0; x <= x1; x++) {
        const brow = x & 3;
        for (let y = yA; y < yB; y++) {
          const pi = y * W + x;
          if (fd >= zbuf[pi]) continue;
          const d = BAYER[((y & 3) << 2) | brow];
          const i = pi * 4;
          pix[i] = 255 * Math.min(1, Math.floor(rL + d) / LEVELS);
          pix[i + 1] = 255 * Math.min(1, Math.floor(gL + d) / LEVELS);
          pix[i + 2] = 255 * Math.min(1, Math.floor(bL + d) / LEVELS);
          pix[i + 3] = 255;
        }
      }
      return;
    }

    const spr = s.spr;
    const lum = spr.lum;
    const alpha = spr.alpha;
    const sw2 = spr.w;
    const sh2 = spr.h;
    const fl = s.flash;
    const tr = s.tint.r;
    const tg = s.tint.g;
    const tb = s.tint.b;
    for (let x = x0; x <= x1; x++) {
      let u = (((x - (cx - halfW)) / sw) * sw2) | 0;
      if (u < 0) u = 0;
      else if (u >= sw2) u = sw2 - 1;
      const brow = x & 3;
      for (let y = yA; y < yB; y++) {
        const pi = y * W + x;
        if (fd >= zbuf[pi]) continue;
        let v = (((y - yTop) / sh) * sh2) | 0;
        if (v < 0) v = 0;
        else if (v >= sh2) v = sh2 - 1;
        const ti = v * sw2 + u;
        if (alpha[ti] < 128) continue;
        const k = lum[ti] / 255;
        let r = tr * k;
        let g = tg * k;
        let b = tb * k;
        if (fl > 0) {
          r += (1 - r) * fl;
          g += (0.08 - g) * fl;
          b += (0.05 - b) * fl;
        }
        r += (FOG_COL[0] - r) * f;
        g += (FOG_COL[1] - g) * f;
        b += (FOG_COL[2] - b) * f;
        const d = BAYER[((y & 3) << 2) | brow];
        const i = (y * W + x) * 4;
        pix[i] = 255 * Math.min(1, Math.floor(r * LEVELS + d) / LEVELS);
        pix[i + 1] = 255 * Math.min(1, Math.floor(g * LEVELS + d) / LEVELS);
        pix[i + 2] = 255 * Math.min(1, Math.floor(b * LEVELS + d) / LEVELS);
        pix[i + 3] = 255;
      }
    }
  }

  // ---------- Эффекты ----------

  private drawEffects(dt: number): void {
    // Взрывы — расходящиеся кольца
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const bl = this.blasts[i];
      bl.life -= dt;
      if (bl.life <= 0) {
        this.blasts.splice(i, 1);
        continue;
      }
      const t = 1 - bl.life / BLAST_LIFE;
      this.drawRingNow(bl.x, bl.y, bl.z, bl.radius * (0.3 + 0.7 * Math.sqrt(t)), bl.r, bl.g, bl.b, null, Math.PI);
    }
    // Молнии — ломаные линии
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bo = this.bolts[i];
      bo.life -= dt;
      if (bo.life <= 0) {
        this.bolts.splice(i, 1);
        continue;
      }
      for (let s = 0; s < bo.pts.length - 1; s++) {
        const a = bo.pts[s];
        const b = bo.pts[s + 1];
        this.drawStreakNow(a.x, a.y, a.z, b.x, b.y, b.z, 0.6, 0.9, 1);
      }
    }
    // Сектора взмахов меча — дуги на земле
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.life -= dt;
      if (a.life <= 0) {
        this.arcs.splice(i, 1);
        continue;
      }
      const k = 0.4 + 0.6 * (a.life / ARC_LIFE);
      this.drawRingNow(a.x, a.y, a.z, a.radius, 0.75 * k, 0.9 * k, 1 * k, a.center, a.half);
    }
    // Трупы: спрайт оседает и темнеет
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.corpses.splice(i, 1);
        continue;
      }
      const t = c.life / CORPSE_LIFE; // 1 → 0
      const k = 0.25 + 0.75 * t;
      const dark: Tint = { r: c.tint.r * 0.6 * t, g: c.tint.g * 0.6 * t, b: c.tint.b * 0.6 * t };
      const dx = c.x - this.camX;
      const dz = c.z - this.camZ;
      const fd = dx * this.sinY + dz * this.cosY;
      if (fd < 0.4 || fd > Z_FAR) continue;
      const ld = dx * this.cosY - dz * this.sinY;
      this.drawSprite({
        spr: corpseSprite(c),
        x: c.x,
        yBase: c.y,
        z: c.z,
        wh: 2 * c.scale * k,
        ww: 1.1 * c.scale,
        tint: dark,
        flash: 0,
        bright: 0,
        fd,
        ld,
      });
    }
  }

  private drawStreaks(): void {
    for (const s of this.streaks) this.drawStreakNow(s.x1, s.y1, s.z1, s.x2, s.y2, s.z2, s.r, s.g, s.b);
  }

  private drawRings(): void {
    for (const r of this.rings) this.drawRingNow(r.x, r.y, r.z, r.radius, r.r, r.g, r.b, r.arcCenter, r.arcHalf);
  }

  /**
   * Проекция мировой точки пинхол-камерой с yaw и pitch; null — за камерой.
   * Базис: forward = (sinY·cosP, sinP, cosY·cosP), right = (cosY, 0, −sinY),
   * up = (−sinY·sinP, cosP, −cosY·sinP) — тот же, что в renderWorld.
   */
  private project(x: number, y: number, z: number): { sx: number; sy: number; fd: number } | null {
    const dx = x - this.camX;
    const dy = y - this.camY;
    const dz = z - this.camZ;
    const fd = (dx * this.sinY + dz * this.cosY) * this.cosP + dy * this.sinP;
    if (fd < 0.4) return null;
    const ld = dx * this.cosY - dz * this.sinY;
    const ud = dy * this.cosP - (dx * this.sinY + dz * this.cosY) * this.sinP;
    return { sx: this.W / 2 + (ld * this.focal) / fd, sy: this.H / 2 - (ud * this.focal) / fd, fd };
  }

  private drawStreakNow(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, r: number, g: number, b: number): void {
    const a = this.project(x1, y1, z1);
    const bb = this.project(x2, y2, z2);
    if (!a || !bb) return;
    const steps = Math.max(Math.abs(bb.sx - a.sx), Math.abs(bb.sy - a.sy), 1) | 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const sx = a.sx + (bb.sx - a.sx) * t;
      const sy = a.sy + (bb.sy - a.sy) * t;
      const fd = a.fd + (bb.fd - a.fd) * t;
      const x = sx | 0;
      const y = sy | 0;
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
      if (fd >= this.zbuf[y * this.W + x]) continue;
      const d = BAYER[((y & 3) << 2) | (x & 3)];
      const i = (y * this.W + x) * 4;
      this.pix[i] = 255 * Math.min(1, Math.floor(r * LEVELS + d) / LEVELS);
      this.pix[i + 1] = 255 * Math.min(1, Math.floor(g * LEVELS + d) / LEVELS);
      this.pix[i + 2] = 255 * Math.min(1, Math.floor(b * LEVELS + d) / LEVELS);
      this.pix[i + 3] = 255;
    }
  }

  private drawRingNow(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, arcCenter: number | null, arcHalf: number): void {
    for (let k = 0; k < RING_POINTS; k++) {
      const a = (k / RING_POINTS) * Math.PI * 2;
      if (arcCenter !== null) {
        let rel = a - arcCenter;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        if (Math.abs(rel) > arcHalf) continue;
      }
      const p = this.project(x + Math.sin(a) * radius, y, z + Math.cos(a) * radius);
      if (!p) continue;
      const sx = p.sx | 0;
      const sy = p.sy | 0;
      if (sx < 0 || sy < 0 || sx >= this.W || sy >= this.H) continue;
      // Точка кольца — 2×2 пикселя
      const size = Math.max(1, Math.min(3, (0.6 * this.focal) / p.fd)) | 0;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const px = sx + dx;
          const py = sy + dy;
          if (px >= this.W || py >= this.H) continue;
          if (p.fd >= this.zbuf[py * this.W + px]) continue;
          const d = BAYER[((py & 3) << 2) | (px & 3)];
          const i = (py * this.W + px) * 4;
          this.pix[i] = 255 * Math.min(1, Math.floor(r * LEVELS + d) / LEVELS);
          this.pix[i + 1] = 255 * Math.min(1, Math.floor(g * LEVELS + d) / LEVELS);
          this.pix[i + 2] = 255 * Math.min(1, Math.floor(b * LEVELS + d) / LEVELS);
          this.pix[i + 3] = 255;
        }
      }
    }
  }

  // ---------- Вьюмодель и вспышка ----------

  private drawViewmodel(v: { spr: Sprite; x: number; y: number; scale: number }): void {
    const { spr, scale } = v;
    const x0 = v.x | 0;
    const y0 = v.y | 0;
    for (let sy = 0; sy < spr.h; sy++) {
      for (let sx = 0; sx < spr.w; sx++) {
        const ti = sy * spr.w + sx;
        if (spr.alpha[ti] < 128) continue;
        const k = spr.lum[ti] / 255;
        for (let dy = 0; dy < scale; dy++) {
          const py = y0 + sy * scale + dy;
          if (py < 0 || py >= this.H) continue;
          const brow = (py & 3) << 2;
          for (let dx = 0; dx < scale; dx++) {
            const px = x0 + sx * scale + dx;
            if (px < 0 || px >= this.W) continue;
            const d = BAYER[brow | (px & 3)];
            const i = (py * this.W + px) * 4;
            this.pix[i] = 255 * Math.min(1, Math.floor(k * LEVELS + d) / LEVELS);
            this.pix[i + 1] = 255 * Math.min(1, Math.floor(k * LEVELS + d) / LEVELS);
            this.pix[i + 2] = 255 * Math.min(1, Math.floor(k * LEVELS + d) / LEVELS);
            this.pix[i + 3] = 255;
          }
        }
      }
    }
  }

  private drawFlash(): void {
    const a0 = this.flashAlpha * 0.55;
    const { W, H, pix, edgeMask } = this;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const a = a0 * (0.25 + 0.75 * (edgeMask[i] / 255));
      pix[p] = pix[p] + (255 - pix[p]) * a;
      pix[p + 1] = pix[p + 1] * (1 - a * 0.85);
      pix[p + 2] = pix[p + 2] * (1 - a * 0.85);
    }
  }

  // ---------- Рейкаст (прицеливание) ----------

  /**
   * Ближайшее попадание луча в мир (рельеф/стены как единое поле высот).
   * Возвращает параметр t вдоль луча или Infinity.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
    let t = 0.4;
    while (t < maxDist) {
      const h = this.map.heightAt(ox + dx * t, oz + dz * t);
      if (oy + dy * t <= h) return t;
      t += 0.12 + t * 0.02;
    }
    return Infinity;
  }
}

// Спрайт трупа переиспользуем — импорт здесь, чтобы не тянуть в шапку
import { ENEMY_WALK0 } from "./sprites";
function corpseSprite(_c: Corpse): Sprite {
  return ENEMY_WALK0;
}
