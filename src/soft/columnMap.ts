/**
 * Потоковая карта колонн для софтверного рендера: мир Terrain запекается в
 * «высотные столбцы» (одна колонна на клетку 2×2 юнита): высота верха (рельеф
 * или верх стены), тип (земля/стена) и запечённое освещение — склон по нормали
 * рельефа плюс тень от стен и холмов (марш луча к солнцу по фартуку тайла).
 *
 * Хранение — тороидальное окно WINDOW×WINDOW тайлов вокруг камеры: тайл,
 * вышедший из окна, затирается новым без всяких очередей удаления. Радиуса
 * окна хватает за пределы дальности тумана, поэтому «дыр» в кадре не видно.
 */

import { CHUNK_CELLS, TILE, Terrain, chunkKey, hash2i } from "../terrain";

export const CELL = TILE; // 2 юнита на колонку
export const TILE_CELLS = CHUNK_CELLS; // 16 колонок в тайле (тайл = чанк террейна, 32 юнита)
export const WINDOW = 15; // тайлов по стороне окна (15×32 = 480 юнитов покрытия)
const VIEW_RADIUS = 7; // тайлов от камеры, которые обязаны быть запечены
const SLOT_CELLS = TILE_CELLS * TILE_CELLS;
const APRON = 8; // клеток вокруг тайла для нормалей и теней
const APRON_N = TILE_CELLS + APRON * 2;

// Солнце — то же, что в закатном свете игры: lightDir (0.7, -0.55, 0.3)
const SUN_LEN = Math.hypot(0.7, 0.55, 0.3);
export const SUN_X = -0.7 / SUN_LEN; // направление К солнцу
export const SUN_Y = 0.55 / SUN_LEN;
export const SUN_Z = -0.3 / SUN_LEN;
// Горизонтальная составляющая марша тени и подъём луча на клетку
const SUN_HLEN = Math.hypot(SUN_X, SUN_Z);
const SHADOW_DIR_X = SUN_X / SUN_HLEN;
const SHADOW_DIR_Z = SUN_Z / SUN_HLEN;
const SUN_RISE = (SUN_Y / SUN_HLEN) * CELL; // на сколько выше луч через клетку
const SHADOW_STEPS = 7; // дальше тень не достаёт (стены ≤ 5.6 юнита)
const SHADOW_LIGHT = 0.35; // доля света в тени
// Длинные тени от мегаструктур: марш с растущим шагом до 130 клеток (260 юнитов —
// хватает на тень от монолита 180 юнитов при низком солнце)
const SHADOW_REACH_CELLS = 130;
const SHADOW_REACH_UNITS = SHADOW_REACH_CELLS * CELL;

// Цвета (как в ретро-пайплайне игры)
export const FOG_COL: [number, number, number] = [0.66, 0.58, 0.62];
export const SKY_TOP: [number, number, number] = [0.3, 0.27, 0.45];
export const WALL_COL: [number, number, number] = [0.49, 0.47, 0.55];
/** Мегаструктуры — холоднее и темнее валунов: мёртвый бетон гигантов */
export const STRUCT_COL: [number, number, number] = [0.4, 0.41, 0.5];
/** Палитра земли — полосы высот из terrainMesh.ts */
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
 * и снег на вершинах. Пишет RGB 0..1 в out по смещению o.
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

// Общие scratch-буферы запекания (переиспользуются между тайлами, без GC)
const apronH = new Float32Array(APRON_N * APRON_N);
const apronKind = new Uint8Array(APRON_N * APRON_N);

/** Результат билинейного сэмпла рельефа (см. ColumnMap.sampleGround) */
export interface GroundSample {
  h: number; // сглаженная высота поверхности (земля + скруглённые валуны)
  ground: number; // сглаженная высота чистого рельефа (для оттенка скал)
  light: number; // 0..1
  rgb: [number, number, number]; // базовый цвет земли 0..1
}
/** Scratch для вызовов heightAt/sampleGround вне горячего цикла рендера */
const GROUND_SCRATCH: GroundSample = { h: 0, ground: 0, light: 0, rgb: [0, 0, 0] };

export class ColumnMap {
  /** Плоские массивы окна: слот × 256 колонок. Рендер читает их напрямую. */
  readonly colH = new Float32Array(WINDOW * WINDOW * SLOT_CELLS);
  readonly colKind = new Uint8Array(WINDOW * WINDOW * SLOT_CELLS);
  /** Запечённый свет 0..255 (0.35..1.0 × 255) */
  readonly colLight = new Uint8Array(WINDOW * WINDOW * SLOT_CELLS);
  /** Высота чистого рельефа (без стен) — для билинейного сглаживания земли */
  readonly colGround = new Float32Array(WINDOW * WINDOW * SLOT_CELLS);
  /** Базовый цвет земли RGB (палитра + биом + снег), 3 байта на колонну */
  readonly colColor = new Uint8Array(WINDOW * WINDOW * SLOT_CELLS * 3);
  /** Какой тайл сейчас в слоте (-1 — слот пуст) */
  private readonly slotTag = new Int32Array(WINDOW * WINDOW).fill(-1);

  constructor(private readonly terrain: Terrain) {}

  /** Слот тороидального окна для тайла */
  private slot(tx: number, tz: number): number {
    return ((tx % WINDOW) + WINDOW) % WINDOW + (((tz % WINDOW) + WINDOW) % WINDOW) * WINDOW;
  }

  /** Индекс колонны по клетке сетки; -1, если её тайл ещё не запечён */
  private cellIndex(gx: number, gz: number): number {
    const tx = gx >> 4;
    const tz = gz >> 4;
    const s = this.slot(tx, tz);
    if (this.slotTag[s] !== chunkKey(tx, tz)) return -1;
    return s * SLOT_CELLS + ((gz & 15) << 4) + (gx & 15);
  }

  /**
   * Индекс колонны в плоских массивах по мировой точке; -1, если её тайл ещё
   * не запечён (рендер такую колонну пропускает — там туман).
   */
  columnIndexAt(wx: number, wz: number): number {
    return this.cellIndex(Math.floor(wx / CELL), Math.floor(wz / CELL));
  }

  /**
   * Высота поверхности в точке: сооружения — по колонне (блоки, ярусы зиккурата
   * обязаны быть ровными), земля и валуны — билинейно сглаженные (валуны
   * скругляются в склоны; совпадает с terrain.getHeight вне стен).
   * Незапечённое — напрямую из террейна (рейкасты, спрайты).
   */
  heightAt(wx: number, wz: number): number {
    const i = this.columnIndexAt(wx, wz);
    if (i < 0) return this.terrain.floorAt(wx, wz);
    if (this.colKind[i] >= 2) return this.colH[i];
    return this.sampleGround(wx, wz, GROUND_SCRATCH) ? GROUND_SCRATCH.h : this.terrain.getHeight(wx, wz);
  }

  /**
   * Билинейный сэмпл поверхности: высота, свет и базовый цвет интерполируются
   * между центрами 4 соседних колонн — земля рисуется плавной, без сетки 2×2,
   * а валуны (kind 1) скругляются: их верх входит в поле высот, и грани
   * превращаются в склоны. Сооружения (kind ≥ 2) в поле не участвуют — они
   * рисуются блоками поверх. (colGround — getHeight в узлах той же сетки,
   * поэтому вне стен интерполяция воспроизводит аналитический рельеф точно.)
   * false — хоть одна из 4 колонн не запечена.
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
    const g = this.colGround;
    const l = this.colLight;
    const c = this.colColor;
    const k = this.colKind;
    const hh = this.colH;
    // Поле поверхности: валун — его верх (с джиттером), иначе — рельеф
    const f00 = k[i00] === 1 ? hh[i00] : g[i00];
    const f10 = k[i10] === 1 ? hh[i10] : g[i10];
    const f01 = k[i01] === 1 ? hh[i01] : g[i01];
    const f11 = k[i11] === 1 ? hh[i11] : g[i11];
    const h0 = f00 + (f10 - f00) * u;
    const h1 = f01 + (f11 - f01) * u;
    const g0 = g[i00] + (g[i10] - g[i00]) * u;
    const g1 = g[i01] + (g[i11] - g[i01]) * u;
    const l0 = l[i00] + (l[i10] - l[i00]) * u;
    const l1 = l[i01] + (l[i11] - l[i01]) * u;
    out.h = h0 + (h1 - h0) * v;
    out.ground = g0 + (g1 - g0) * v;
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

  /**
   * Верх твёрдой поверхности в точке строго по отрисованным колоннам
   * (kind ≥ 1: стена, сооружение, пандус), null — голый рельеф.
   * Опора игрока идёт по этой функции, чтобы «что видно, то и твёрдое»:
   * аналитические hex-стены террейна с отрисованными блоками 2×2 не совпадают.
   */
  wallTopAt(wx: number, wz: number): number | null {
    const i = this.columnIndexAt(wx, wz);
    if (i < 0) return this.terrain.wallTopAt(wx, wz); // вне окна — аналитика (запасной путь)
    return this.colKind[i] >= 1 ? this.colH[i] : null;
  }

  /**
   * Точная проверка: пересекает ли круг (x,z,r) хоть одну отрисованную колонну
   * преграды (kind 1 — стена, 2 — сооружение; kind 3 — пандус — не блокирует)
   * с верхом выше feetY + step. Клетки — квадраты CELL×CELL, проверка —
   * ближайшая точка клетки к центру круга; касание (d == r) не считается.
   */
  circleHitsWall(x: number, z: number, r: number, feetY: number, step = 0.25): boolean {
    const gx0 = Math.floor((x - r) / CELL);
    const gx1 = Math.floor((x + r) / CELL);
    const gz0 = Math.floor((z - r) / CELL);
    const gz1 = Math.floor((z + r) / CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = Math.max(gx * CELL, Math.min(x, gx * CELL + CELL));
        const cz = Math.max(gz * CELL, Math.min(z, gz * CELL + CELL));
        const ddx = cx - x;
        const ddz = cz - z;
        if (ddx * ddx + ddz * ddz >= r * r) continue;
        const wx = (gx + 0.5) * CELL;
        const wz = (gz + 0.5) * CELL;
        let top: number | null = null;
        const i = this.columnIndexAt(wx, wz);
        if (i < 0) {
          top = this.terrain.blocksAt(wx, wz); // вне окна — аналитика (запасной путь)
        } else if (this.colKind[i] === 1 || this.colKind[i] === 2) {
          top = this.colH[i];
        }
        if (top !== null && top > feetY + step) return true;
      }
    }
    return false;
  }

  /**
   * Запечь недостающие тайлы вокруг точки: ближние первыми, не больше budget
   * за вызов (запекание ~0.3 мс на тайл — размазываем по кадрам).
   */
  ensureAround(x: number, z: number, budget = 2): void {
    const ctx = Math.floor(x / (TILE_CELLS * CELL));
    const ctz = Math.floor(z / (TILE_CELLS * CELL));
    for (let ring = 0; ring <= VIEW_RADIUS && budget > 0; ring++) {
      for (let dz = -ring; dz <= ring && budget > 0; dz++) {
        for (let dx = -ring; dx <= ring && budget > 0; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue; // только кольцо
          const tx = ctx + dx;
          const tz = ctz + dz;
          const s = this.slot(tx, tz);
          if (this.slotTag[s] === chunkKey(tx, tz)) continue;
          this.bake(tx, tz, s);
          budget--;
        }
      }
    }
  }

  /** Запечь всё окно сразу (старт игры — пока висит экран выбора оружия) */
  bakeAllAround(x: number, z: number): void {
    this.ensureAround(x, z, Infinity);
  }

  /** Запекание одного тайла: высоты и типы с фартуком, затем свет и тени внутренних 16×16 */
  private bake(tx: number, tz: number, slot: number): void {
    const baseGX = tx * TILE_CELLS - APRON;
    const baseGZ = tz * TILE_CELLS - APRON;
    for (let j = 0; j < APRON_N; j++) {
      const wz = (baseGZ + j + 0.5) * CELL;
      for (let i = 0; i < APRON_N; i++) {
        const wx = (baseGX + i + 0.5) * CELL;
        const idx = j * APRON_N + i;
        // wallTopAt включает мегаструктуры; тип колонны — по сооружению
        const st = this.terrain.structureAt(wx, wz);
        const wallTop = this.terrain.wallTopAt(wx, wz);
        if (wallTop !== null) {
          apronH[idx] = wallTop;
          apronKind[idx] = st ? (st.ramp ? 3 : 2) : 1;
        } else {
          apronH[idx] = this.terrain.getHeight(wx, wz);
          apronKind[idx] = 0;
        }
      }
    }

    // Рядом с мегаструктурой тени длинные — марш далеко за пределы фартука
    const longShadows = this.terrain.structureNearTile(tx, tz, SHADOW_REACH_UNITS);

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

        // Тень: марш к солнцу; колонна выше луча — мы в тени
        if (!longShadows) {
          // Обычный тайл: короткий марш по фартуку (стены ≤ 5.6 юнита)
          for (let s = 1; s <= SHADOW_STEPS; s++) {
            const si = Math.min(APRON_N - 1, Math.max(0, Math.round(ai + SHADOW_DIR_X * s)));
            const sj = Math.min(APRON_N - 1, Math.max(0, Math.round(aj + SHADOW_DIR_Z * s)));
            if (apronH[sj * APRON_N + si] > h + SUN_RISE * s + 0.25) {
              light *= SHADOW_LIGHT;
              break;
            }
          }
        } else {
          // Мегаструктуры: марш с растущим шагом до SHADOW_REACH_CELLS;
          // в пределах фартука — быстрые сэмплы, дальше — прямые запросы к террейну
          let s = 0;
          let step = 1;
          while (s < SHADOW_REACH_CELLS) {
            s += step;
            if (s === 8) step = 2;
            else if (s === 24) step = 4;
            else if (s === 56) step = 8;
            let sh: number;
            if (s <= APRON) {
              const si = Math.min(APRON_N - 1, Math.max(0, Math.round(ai + SHADOW_DIR_X * s)));
              const sj = Math.min(APRON_N - 1, Math.max(0, Math.round(aj + SHADOW_DIR_Z * s)));
              sh = apronH[sj * APRON_N + si];
            } else {
              sh = this.terrain.floorAt(wx + SHADOW_DIR_X * s * CELL, wz + SHADOW_DIR_Z * s * CELL);
            }
            if (sh > h + SUN_RISE * s + 0.25) {
              light *= SHADOW_LIGHT;
              break;
            }
          }
        }

        const o = out + (j << 4) + i;
        const kind = apronKind[a];
        // Валунам — джиттер высоты верха (±0.2): скалы вместо ровных кубов.
        // Меньше шага подъёма (0.25), поэтому ходьба по верхам не ломается.
        // Сооружения не трогаем: ярусы зиккурата обязаны оставаться ровно 1.8.
        this.colH[o] =
          kind === 1 ? h + (((hash2i(baseGX + ai, baseGZ + aj, 0x7a11) >>> 0) / 4294967296) - 0.5) * 0.4 : h;
        this.colKind[o] = kind;
        this.colLight[o] = Math.min(255, (light * 255) | 0);
        // Чистый рельеф и его цвет — всегда (под стенами тоже: билинейная
        // интерполяция земли читает соседей, включая колонны со стенами)
        const gh = kind === 0 ? h : this.terrain.getHeight(wx, wz);
        this.colGround[o] = gh;
        groundBaseColor(gh, this.terrain.biomeAt(wx, wz), this.colColor, o * 3);
      }
    }
    this.slotTag[slot] = chunkKey(tx, tz);
  }
}
