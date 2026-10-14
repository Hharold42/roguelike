/**
 * Карта колонн для софтверного рендера: рельеф Terrain запекается в «высотные
 * столбцы» (одна колонна на клетку 2×2 юнита): высота, запечённое освещение
 * (склон по нормали рельефа плюс тени от холмов — марш луча к низкому закатному
 * солнцу по фартуку тайла) и базовый цвет земли (палитра высот + биом + снег).
 *
 * Мир фиксированный: WORLD_TILES×WORLD_TILES чанков (8×8 = 256×256 юнитов),
 * центр — точка спавна (0, 0). Все тайлы запекаются один раз на старте
 * (bakeWorld), потоковой подгрузки нет. За границей мира колонн нет —
 * рендер оставляет там дымку в цвете тумана (мир-остров в молоке).
 */

import { CHUNK_CELLS, TILE, Terrain } from "../terrain";
import { Structures } from "../structures";

export const CELL = TILE; // 2 юнита на колонну
export const TILE_CELLS = CHUNK_CELLS; // 16 колонок в тайле (тайл = чанк террейна, 32 юнита)
export const WORLD_TILES = 8; // чанков по стороне мира
const WORLD_HALF = WORLD_TILES / 2; // тайлы: -4..3
export const WORLD_SIZE = WORLD_TILES * TILE_CELLS * CELL; // 256 юнитов
const SLOT_CELLS = TILE_CELLS * TILE_CELLS;
const APRON = 8; // клеток вокруг тайла для нормалей и теней
const APRON_N = TILE_CELLS + APRON * 2;

// Солнце — низкое закатное: направление К солнцу
const SUN_LEN = Math.hypot(0.7, 0.55, 0.3);
export const SUN_X = -0.7 / SUN_LEN;
export const SUN_Y = 0.55 / SUN_LEN;
export const SUN_Z = -0.3 / SUN_LEN;
// Горизонтальная составляющая марша тени и подъём луча на клетку
const SUN_HLEN = Math.hypot(SUN_X, SUN_Z);
const SHADOW_DIR_X = SUN_X / SUN_HLEN;
const SHADOW_DIR_Z = SUN_Z / SUN_HLEN;
const SUN_RISE = (SUN_Y / SUN_HLEN) * CELL; // на сколько выше луч через клетку
const SHADOW_STEPS = 7; // дальше тень от холма не достаёт
const SHADOW_LIGHT = 0.35; // доля света в тени

// Цвета
export const FOG_COL: [number, number, number] = [0.66, 0.58, 0.62];
export const SKY_TOP: [number, number, number] = [0.3, 0.27, 0.45];
/** Палитра земли — полосы по высоте */
export const GROUND_PALETTE: { upTo: number; c: [number, number, number] }[] = [
  { upTo: -1.6, c: [0.12, 0.27, 0.17] },
  { upTo: 0.3, c: [0.2, 0.42, 0.19] },
  { upTo: 1.6, c: [0.36, 0.44, 0.19] },
  { upTo: 2.8, c: [0.47, 0.37, 0.25] },
  { upTo: Infinity, c: [0.56, 0.54, 0.56] },
];
// Ширина плавного перехода между полосами палитры (юниты высоты)
const BAND_SOFT = 0.7;
// Биомы: выжженная земля ↔ сырая низина (тонировка поверх палитры)
const BIOME_DRY: [number, number, number] = [0.5, 0.46, 0.24];
const BIOME_WET: [number, number, number] = [0.13, 0.33, 0.16];
const BIOME_STRENGTH = 0.38;
// Снег на вершинах: плавно от SNOW_FROM до SNOW_TO
const SNOW_COL: [number, number, number] = [0.78, 0.8, 0.85];
const SNOW_FROM = 3.6;
const SNOW_TO = 5.2;

/**
 * Цвет земли в точке: полосы палитры с плавными переходами, тонировка биомом
 * и снег на вершинах. Пишет RGB 0..255 в out по смещению o.
 */
function groundBaseColor(h: number, biome: number, out: Uint8Array, o: number): void {
  // Плавные полосы: каждая граница — лерп шириной BAND_SOFT
  let r = GROUND_PALETTE[0].c[0];
  let g = GROUND_PALETTE[0].c[1];
  let b = GROUND_PALETTE[0].c[2];
  for (let i = 1; i < GROUND_PALETTE.length; i++) {
    const edge = GROUND_PALETTE[i - 1].upTo;
    let t = (h - edge) / BAND_SOFT + 0.5;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    r += (GROUND_PALETTE[i].c[0] - r) * t;
    g += (GROUND_PALETTE[i].c[1] - g) * t;
    b += (GROUND_PALETTE[i].c[2] - b) * t;
  }
  // Биом: 0 — сухо (оливковое), 1 — сыро (глубокая зелень)
  const m = (biome - 0.5) * 2; // -1..1
  const tc = m < 0 ? BIOME_DRY : BIOME_WET;
  const k = Math.abs(m) * BIOME_STRENGTH;
  r += (tc[0] - r) * k;
  g += (tc[1] - g) * k;
  b += (tc[2] - b) * k;
  // Снег
  let s = (h - SNOW_FROM) / (SNOW_TO - SNOW_FROM);
  s = s <= 0 ? 0 : s >= 1 ? 1 : s;
  r += (SNOW_COL[0] - r) * s;
  g += (SNOW_COL[1] - g) * s;
  b += (SNOW_COL[2] - b) * s;
  out[o] = (r * 255) | 0;
  out[o + 1] = (g * 255) | 0;
  out[o + 2] = (b * 255) | 0;
}

// Общий scratch-буфер запекания (переиспользуется между тайлами, без GC)
const apronH = new Float32Array(APRON_N * APRON_N);

/** Результат билинейного сэмпла рельефа (см. ColumnMap.sampleGround) */
export interface GroundSample {
  h: number; // сглаженная высота поверхности
  light: number; // 0..1
  rgb: [number, number, number]; // базовый цвет земли 0..1
}
/** Scratch для вызовов sampleGround вне горячего цикла рендера */
const GROUND_SCRATCH: GroundSample = { h: 0, light: 0, rgb: [0, 0, 0] };

export class ColumnMap {
  /** Плоские массивы мира: тайл × 256 колонок. Рендер читает их напрямую. */
  readonly colH = new Float32Array(WORLD_TILES * WORLD_TILES * SLOT_CELLS);
  /** Запечённый свет 0..255 (0.35..1.0 × 255) */
  readonly colLight = new Uint8Array(WORLD_TILES * WORLD_TILES * SLOT_CELLS);
  /** Базовый цвет земли RGB (палитра + биом + снег), 3 байта на колонну */
  readonly colColor = new Uint8Array(WORLD_TILES * WORLD_TILES * SLOT_CELLS * 3);
  /** Запечён ли тайл в слоте */
  private readonly slotBaked = new Uint8Array(WORLD_TILES * WORLD_TILES);

  /** Платформы, стены и лестницы (рисуются отдельным слоем, но участвуют в heightAt) */
  readonly structures: Structures;

  constructor(private readonly terrain: Terrain) {
    this.structures = new Structures(terrain.zones, terrain.seed);
  }

  /** Слот тайла; -1 — тайл за границей мира */
  private slot(tx: number, tz: number): number {
    if (tx < -WORLD_HALF || tx >= WORLD_HALF || tz < -WORLD_HALF || tz >= WORLD_HALF) return -1;
    return tx + WORLD_HALF + (tz + WORLD_HALF) * WORLD_TILES;
  }

  /** Индекс колонны по клетке сетки; -1 — вне мира или тайл ещё не запечён */
  private cellIndex(gx: number, gz: number): number {
    const s = this.slot(gx >> 4, gz >> 4);
    if (s < 0 || this.slotBaked[s] === 0) return -1;
    return s * SLOT_CELLS + ((gz & 15) << 4) + (gx & 15);
  }

  /**
   * Индекс колонны в плоских массивах по мировой точке; -1 — вне мира
   * (рендер такую колонну пропускает — там дымка тумана).
   */
  columnIndexAt(wx: number, wz: number): number {
    return this.cellIndex(Math.floor(wx / CELL), Math.floor(wz / CELL));
  }

  /** Высота поверхности в точке: запечённая билинейка, вне мира — аналитика */
  heightAt(wx: number, wz: number): number {
    const g = this.sampleGround(wx, wz, GROUND_SCRATCH) ? GROUND_SCRATCH.h : this.terrain.getHeight(wx, wz);
    const s = this.structures.topAt(wx, wz);
    return s > g ? s : g;
  }

  /** Высота только рельефа (без построек) */
  terrainHeightAt(wx: number, wz: number): number {
    return this.sampleGround(wx, wz, GROUND_SCRATCH) ? GROUND_SCRATCH.h : this.terrain.getHeight(wx, wz);
  }

  /**
   * Билинейный сэмпл поверхности: высота, свет и базовый цвет интерполируются
   * между центрами 4 соседних колонн — земля рисуется плавной, без сетки 2×2.
   * colH — getHeight в центрах клеток, а узлы аналитического рельефа стоят в
   * углах, поэтому результат — слегка сглаженный рельеф (до ~0.2 юнита
   * отличия от getHeight). Физика обязана опираться именно на эту поверхность
   * (heightAt), иначе ступни расходятся с видимой землёй. false — хоть одна
   * из 4 колонн вне мира.
   */
  sampleGround(wx: number, wz: number, out: GroundSample): boolean {
    const fx = wx / CELL - 0.5;
    const fz = wz / CELL - 0.5;
    const gx = Math.floor(fx);
    const gz = Math.floor(fz);
    const i00 = this.cellIndex(gx, gz);
    const i10 = this.cellIndex(gx + 1, gz);
    const i01 = this.cellIndex(gx, gz + 1);
    const i11 = this.cellIndex(gx + 1, gz + 1);
    if ((i00 | i10 | i01 | i11) < 0) return false;
    const u = fx - gx;
    const v = fz - gz;
    const g = this.colH;
    const l = this.colLight;
    const c = this.colColor;
    const h0 = g[i00] + (g[i10] - g[i00]) * u;
    const h1 = g[i01] + (g[i11] - g[i01]) * u;
    const l0 = l[i00] + (l[i10] - l[i00]) * u;
    const l1 = l[i01] + (l[i11] - l[i01]) * u;
    out.h = h0 + (h1 - h0) * v;
    out.light = (l0 + (l1 - l0) * v) / 255;
    for (let ch = 0; ch < 3; ch++) {
      const o00 = i00 * 3 + ch;
      const o10 = i10 * 3 + ch;
      const o01 = i01 * 3 + ch;
      const o11 = i11 * 3 + ch;
      const c0 = c[o00] + (c[o10] - c[o00]) * u;
      const c1 = c[o01] + (c[o11] - c[o01]) * u;
      out.rgb[ch] = (c0 + (c1 - c0) * v) / 255;
    }
    return true;
  }

  /** Запечь весь мир (64 тайла, один раз на старте) */
  bakeWorld(): void {
    for (let tz = -WORLD_HALF; tz < WORLD_HALF; tz++) {
      for (let tx = -WORLD_HALF; tx < WORLD_HALF; tx++) {
        this.bake(tx, tz, this.slot(tx, tz));
      }
    }
  }

  /** Запекание одного тайла: высоты с фартуком, затем свет и тени внутренних 16×16 */
  private bake(tx: number, tz: number, slot: number): void {
    const baseGX = tx * TILE_CELLS - APRON;
    const baseGZ = tz * TILE_CELLS - APRON;
    for (let j = 0; j < APRON_N; j++) {
      const wz = (baseGZ + j + 0.5) * CELL;
      for (let i = 0; i < APRON_N; i++) {
        apronH[j * APRON_N + i] = this.terrain.getHeight((baseGX + i + 0.5) * CELL, wz);
      }
    }

    const out = slot * SLOT_CELLS;
    for (let j = 0; j < TILE_CELLS; j++) {
      const aj = j + APRON;
      for (let i = 0; i < TILE_CELLS; i++) {
        const ai = i + APRON;
        const a = aj * APRON_N + ai;
        const h = apronH[a];
        const wx = (baseGX + ai + 0.5) * CELL;
        const wz = (baseGZ + aj + 0.5) * CELL;

        // Свет склона по нормалям (центральная разность высот)
        const dhdx = (apronH[a + 1] - apronH[a - 1]) / (2 * CELL);
        const dhdz = (apronH[a + APRON_N] - apronH[a - APRON_N]) / (2 * CELL);
        const inv = 1 / Math.hypot(dhdx, 1, dhdz);
        const dot = Math.max(0, (-dhdx * SUN_X + SUN_Y + -dhdz * SUN_Z) * inv);
        let light = 0.35 + 0.65 * dot;

        // Тень: марш к солнцу по фартуку; колонна выше луча — мы в тени
        for (let s = 1; s <= SHADOW_STEPS; s++) {
          const si = Math.min(APRON_N - 1, Math.max(0, Math.round(ai + SHADOW_DIR_X * s)));
          const sj = Math.min(APRON_N - 1, Math.max(0, Math.round(aj + SHADOW_DIR_Z * s)));
          if (apronH[sj * APRON_N + si] > h + SUN_RISE * s + 0.25) {
            light *= SHADOW_LIGHT;
            break;
          }
        }

        const o = out + (j << 4) + i;
        this.colH[o] = h;
        this.colLight[o] = Math.min(255, (light * 255) | 0);
        groundBaseColor(h, this.terrain.biomeAt(wx, wz), this.colColor, o * 3);
      }
    }
    this.slotBaked[slot] = 1;
  }
}
