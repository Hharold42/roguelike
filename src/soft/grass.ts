/**
 * Воксельная трава — поле отдельных статичных колосков, а не полотно.
 *
 * Поле детерминировано от мировых координат: каждая клетка 1×1 юнит порождает
 * фиксированный набор колосков (позиция в клетке, высота, яркость — хеш от
 * координат), поэтому трава не «ползёт» за камерой. Колосок — короткая линия
 * от земли (основание в тени, кончик светлый, к кончику сужается), ширина по
 * дальности. Отрисовка после мира с попиксельным z-test: колоски прячутся за
 * холмами и стенами, враги и монеты тонут в них.
 *
 * Ветер — бегущая волна вдоль направления ветра + поперечная рябь + медленные
 * порывы; фаза каждого колоска своя (из хеша), поэтому поле переливается, а не
 * ходит синхронной волной. Качается только кончик (изгиб), основание стоит.
 *
 * Интерактивность: тороидальная сетка приминания хранит силу и НАПРАВЛЕНИЕ —
 * колоски отклоняются ОТ проходящего актора (trample) и плавно распрямляются
 * за пару секунд (exp-затухание при следующих обращениях к клетке).
 */

import { FOG_COL } from "./columnMap";
import type { ColumnMap, GroundSample } from "./columnMap";
import { BAYER, FOG_LUT, LEVELS, Z_FAR } from "./gfx";

const GRASS_RADIUS = 26; // радиус поля вокруг камеры, юниты
const BLADES_PER_CELL = 5; // колосков на клетку 1×1 юнит
const BLADE_H = 0.85; // базовая высота колоска, юниты
const BLADE_W = 0.075; // ширина основания колоска, юниты
const BEND_MAX = 1.0; // макс. горизонтальный изгиб (доля высоты колоска)
const TRAMP_WIN = 64; // сетка приминания: тороидальное окно 64×64 клетки
const TRAMP_DECAY = 1.6; // скорость распрямления (exp-затухание, 1/с)
const GRASS_COL: [number, number, number] = [0.34, 0.52, 0.2];
// --- Ветер ---
const WIND_DIR_X = 0.8; // направление ветра (нормируется при использовании)
const WIND_DIR_Z = 0.6;
const WIND_SWAY = 0.22; // макс. отклонение кончика от ветра (доля высоты)

/** Детерминированный белый шум 0..1 от координат клетки и соли */
function hash2i(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 2246822519) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Scratch билинейного сэмпла земли (без GC в горячем цикле)
const GS: GroundSample = { h: 0, ground: 0, light: 0, rgb: [0, 0, 0] };

export class GrassField {
  /** Время кадра, с — ветер и затухание приминания */
  time = 0;

  private readonly map: ColumnMap;

  // Сетка приминания: сила + направление изгиба; тег — мировые координаты
  // клетки, значение затухает лениво при чтении/записи
  private readonly trampVal = new Float32Array(TRAMP_WIN * TRAMP_WIN);
  private readonly trampDX = new Float32Array(TRAMP_WIN * TRAMP_WIN);
  private readonly trampDZ = new Float32Array(TRAMP_WIN * TRAMP_WIN);
  private readonly trampTag = new Int32Array(TRAMP_WIN * TRAMP_WIN).fill(-1);
  private readonly trampT = new Float32Array(TRAMP_WIN * TRAMP_WIN);
  /** Scratch ответа bendAt (без GC) */
  private readonly bq = { press: 0, dx: 0, dz: 0 };

  // Контекст кадра (заполняет render)
  private pix!: Uint8ClampedArray;
  private zbuf!: Float32Array;
  private W = 0;
  private H = 0;
  private focal = 0;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private sinY = 0;
  private cosY = 1;
  private sinP = 0;
  private cosP = 1;

  constructor(map: ColumnMap) {
    this.map = map;
  }

  /**
   * Отпечаток актора: примять/отогнуть траву кругом радиуса r в точке (x, z).
   * Вызывать каждый кадр для каждого существа рядом с камерой — направление
   * изгиба берётся ОТ актора, поэтому движение оставляет расходящийся след.
   */
  trample(x: number, z: number, r: number): void {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const z0 = Math.floor(z - r);
    const z1 = Math.floor(z + r);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx + 0.5 - x;
        const dz = cz + 0.5 - z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= r) continue;
        const s = (cx & (TRAMP_WIN - 1)) + ((cz & (TRAMP_WIN - 1)) << 6);
        const tag = (cx << 16) ^ (cz & 0xffff);
        let v = this.trampTag[s] === tag ? this.trampVal[s] * Math.exp(-TRAMP_DECAY * (this.time - this.trampT[s])) : 0;
        const press = 1 - d / r;
        if (press > v) {
          v = press;
          // Направление от актора; в нуле — детерминированный случайный бок
          if (d > 0.05) {
            this.trampDX[s] = dx / d;
            this.trampDZ[s] = dz / d;
          } else {
            const a = hash2i(cx, cz, 77) * Math.PI * 2;
            this.trampDX[s] = Math.sin(a);
            this.trampDZ[s] = Math.cos(a);
          }
        }
        this.trampVal[s] = v;
        this.trampTag[s] = tag;
        this.trampT[s] = this.time;
      }
    }
  }

  /** Сила и направление изгиба в точке (результат в this.bq, без аллокаций) */
  private bendAt(wx: number, wz: number): void {
    const cx = Math.floor(wx);
    const cz = Math.floor(wz);
    const s = (cx & (TRAMP_WIN - 1)) + ((cz & (TRAMP_WIN - 1)) << 6);
    const bq = this.bq;
    if (this.trampTag[s] !== ((cx << 16) ^ (cz & 0xffff))) {
      bq.press = 0;
      bq.dx = 0;
      bq.dz = 0;
      return;
    }
    const v = this.trampVal[s] * Math.exp(-TRAMP_DECAY * (this.time - this.trampT[s]));
    bq.press = v > 1 ? 1 : v;
    bq.dx = this.trampDX[s];
    bq.dz = this.trampDZ[s];
  }

  /** Отрисовка поля вокруг камеры; вызывается после мира, до спрайтов */
  render(
    pix: Uint8ClampedArray,
    zbuf: Float32Array,
    W: number,
    H: number,
    focal: number,
    camX: number,
    camY: number,
    camZ: number,
    sinY: number,
    cosY: number,
    sinP: number,
    cosP: number,
  ): void {
    this.pix = pix;
    this.zbuf = zbuf;
    this.W = W;
    this.H = H;
    this.focal = focal;
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    this.sinY = sinY;
    this.cosY = cosY;
    this.sinP = sinP;
    this.cosP = cosP;

    const R = GRASS_RADIUS;
    const x0 = Math.floor(camX - R);
    const x1 = Math.floor(camX + R);
    const z0 = Math.floor(camZ - R);
    const z1 = Math.floor(camZ + R);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const mx = cx + 0.5 - camX;
        const mz = cz + 0.5 - camZ;
        const cd2 = mx * mx + mz * mz;
        if (cd2 > R * R) continue;
        // К краю радиуса колоски плавно низеют — без резкого pop-in
        const dist = Math.sqrt(cd2);
        const distFade = dist > R * 0.75 ? (R - dist) / (R * 0.25) : 1;
        // Отсев клетки целиком: за камерой или вне угла обзора (74° + запас)
        const fh = mx * sinY + mz * cosY;
        if (fh < -1) continue;
        const ld = mx * cosY - mz * sinY;
        if (fh > 1 && (ld > fh * 0.85 + 2 || ld < -fh * 0.85 - 2)) continue;
        // Не растёт на стенах/валунах/сооружениях, скалах и снегу
        const ci = this.map.columnIndexAt(cx + 0.5, cz + 0.5);
        if (ci >= 0 && this.map.colKind[ci] >= 1) continue;
        if (!this.map.sampleGround(cx + 0.5, cz + 0.5, GS)) continue;
        if (GS.h - GS.ground > 0.25 || GS.ground > 3.4) continue;
        // Травяность по цвету земли: сырые зелёные низины — густо и высоко,
        // сухие и бурые полосы палитры — редкая короткая поросль
        const mask = (GS.rgb[1] - GS.rgb[0] + 0.05) * 4;
        if (mask < 0.15) continue;
        const maskK = mask > 1 ? 1 : mask;
        const light = 0.45 + 0.55 * GS.light;
        const gr = (GS.rgb[0] + (GRASS_COL[0] - GS.rgb[0]) * 0.8) * light;
        const gg = (GS.rgb[1] + (GRASS_COL[1] - GS.rgb[1]) * 0.8) * light;
        const gb = (GS.rgb[2] + (GRASS_COL[2] - GS.rgb[2]) * 0.8) * light;
        const baseY = GS.h - 0.1; // чуть в земле — не «плавает» на склонах
        for (let i = 0; i < BLADES_PER_CELL; i++) {
          const bx = cx + hash2i(cx, cz, i * 4 + 1);
          const bz = cz + hash2i(cx, cz, i * 4 + 2);
          const hh = BLADE_H * (0.65 + 0.7 * hash2i(cx, cz, i * 4 + 3)) * maskK * distFade;
          const bright = 0.72 + 0.5 * hash2i(cx, cz, i * 4 + 4);
          this.blade(bx, baseY, bz, hh, bright, gr, gg, gb);
        }
      }
    }
  }

  /** Один колосок: линия основание→кончик с изгибом, z-test на пиксель */
  private blade(bx: number, by: number, bz: number, hh: number, bright: number, gr: number, gg: number, gb: number): void {
    if (hh < 0.08) return; // крошечный (край радиуса / сухой биом) — не тратимся
    // Изгиб от акторов: кончик уходит в сторону от проходящего и чуть вниз
    this.bendAt(bx, bz);
    const press = this.bq.press;
    const bend = press * BEND_MAX * hh;
    // Ветер: бегущая волна вдоль направления + поперечная рябь слабее; сила
    // дышит медленными порывами. Фаза колоска — из его хеша (bright), соседи
    // не движутся синхронно. Основание стоит, качается только кончик.
    const t = this.time;
    const along = bx * WIND_DIR_X + bz * WIND_DIR_Z;
    const across = bx * WIND_DIR_Z - bz * WIND_DIR_X;
    const gust = 0.55 + 0.45 * Math.sin(t * 0.23 + Math.sin(t * 0.131) * 1.7);
    const ph = bright * 2.4; // детерминированная фаза колоска
    const sway =
      (Math.sin(t * 1.4 + along * 0.35 + ph) * 0.75 + Math.sin(t * 2.2 + across * 0.8 + ph * 1.7) * 0.25) * gust * WIND_SWAY * hh;
    const topX = bx + this.bq.dx * bend + WIND_DIR_X * sway;
    const topZ = bz + this.bq.dz * bend + WIND_DIR_Z * sway;
    const topY = by + hh * (1 - 0.35 * press);

    // Проекция основания (тот же базис пинхол-камеры, что в SoftRenderer)
    const dx = bx - this.camX;
    const dz = bz - this.camZ;
    const fh = dx * this.sinY + dz * this.cosY;
    const ld = dx * this.cosY - dz * this.sinY;
    const dy0 = by - this.camY;
    const fd0 = fh * this.cosP + dy0 * this.sinP;
    if (fd0 < 0.6) return; // за плоскостью кадра / у самого глаза
    const sx0 = this.W / 2 + (ld * this.focal) / fd0;
    if (sx0 < -8 || sx0 > this.W + 8) return;
    const sy0 = this.H / 2 - ((dy0 * this.cosP - fh * this.sinP) * this.focal) / fd0;

    // Проекция кончика (с учётом изгиба — своя горизонтальная позиция)
    const dx1 = topX - this.camX;
    const dz1 = topZ - this.camZ;
    const fh1 = dx1 * this.sinY + dz1 * this.cosY;
    const ld1 = dx1 * this.cosY - dz1 * this.sinY;
    const dy1 = topY - this.camY;
    const fd1 = fh1 * this.cosP + dy1 * this.sinP;
    if (fd1 < 0.3) return;
    const sx1 = this.W / 2 + (ld1 * this.focal) / fd1;
    const sy1 = this.H / 2 - ((dy1 * this.cosP - fh1 * this.sinP) * this.focal) / fd1;

    const yTop = sy1 < sy0 ? sy1 : sy0;
    const yBot = sy1 < sy0 ? sy0 : sy1;
    const yA = yTop < 0 ? 0 : Math.ceil(yTop);
    const yB = yBot >= this.H ? this.H - 1 : Math.floor(yBot);
    if (yA > yB) return;

    const { pix, zbuf, W, focal } = this;
    const invLen = 1 / Math.max(1e-6, sy0 - sy1);
    const wpx = (BLADE_W * focal) / fd0; // ширина основания в пикселях
    const kB = bright * (1 - 0.25 * press);
    const fz = (fd0 / Z_FAR) * 511;
    const fog = FOG_LUT[fz > 511 ? 511 : fz | 0];
    for (let y = yA; y <= yB; y++) {
      let v = (y - sy1) * invLen; // 0 — кончик, 1 — основание
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const x = sx1 + (sx0 - sx1) * v;
      const hw = wpx * (0.3 + 0.35 * v) + 0.34; // сужение к кончику
      const xA = Math.round(x - hw);
      const xB = Math.round(x + hw);
      const k = (1.15 - 0.65 * v) * kB; // кончик светлый, основание в тени
      let rr = gr * k;
      let rg = gg * k;
      let rb = gb * k;
      rr += (FOG_COL[0] - rr) * fog;
      rg += (FOG_COL[1] - rg) * fog;
      rb += (FOG_COL[2] - rb) * fog;
      const rL = rr * LEVELS;
      const gL = rg * LEVELS;
      const bL = rb * LEVELS;
      const drow = (y & 3) << 2;
      for (let xi = xA; xi <= xB; xi++) {
        if (xi < 0 || xi >= W) continue;
        const pi = y * W + xi;
        if (zbuf[pi] <= fd0) continue; // земля/стена/колосок ближе — не рисуем
        zbuf[pi] = fd0;
        const d = BAYER[drow | (xi & 3)];
        const ii = pi * 4;
        pix[ii] = 255 * Math.min(1, Math.floor(rL + d) / LEVELS);
        pix[ii + 1] = 255 * Math.min(1, Math.floor(gL + d) / LEVELS);
        pix[ii + 2] = 255 * Math.min(1, Math.floor(bL + d) / LEVELS);
        pix[ii + 3] = 255;
      }
    }
  }
}
