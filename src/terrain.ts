import { planZones, type Zone } from "./structures";

/** Размер одной клетки в мировых единицах */
export const TILE = 2;
/** Размер чанка в клетках (16 * 2 = 32 юнита) */
export const CHUNK_CELLS = 16;
/** Размер чанка в мировых единицах */
export const CHUNK_SIZE = CHUNK_CELLS * TILE;

// ---------- Детерминированный шум ----------

/** Хеш целых координат -> [0, 1). Работает и с отрицательными координатами. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 974711);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise с билинейной интерполяцией */
function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fz = smooth(z - z0);

  const h00 = hash2(x0, z0, seed);
  const h10 = hash2(x0 + 1, z0, seed);
  const h01 = hash2(x0, z0 + 1, seed);
  const h11 = hash2(x0 + 1, z0 + 1, seed);

  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fz;
}

/** fBm: несколько октав value noise -> примерно [0.2, 0.8] */
function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function clamp01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

// ---------- Параметры рельефа ----------

/** Ширина плавного перехода от площадки под постройкой к рельефу, юниты */
const FLAT_BLEND = 8;

/** Мелкие холмы */
const HILL_AMPLITUDE = 2.6;
const HILL_FREQ = 0.045; // на мировой юнит
/** Крупные возвышенности */
const RIDGE_AMPLITUDE = 3.2;
const RIDGE_FREQ = 0.011;

/**
 * Террейн: высота — чистая функция от мировых координат (шум), поэтому
 * рельеф существует везде и совпадает с собой при любом порядке запросов.
 * Мир ограничен квадратом WORLD_TILES×WORLD_TILES чанков (см. columnMap),
 * но аналитическая высота доступна и за его краем.
 */
export class Terrain {
  /** Точка старта: начало координат, там всегда ровная площадка */
  readonly spawn = { x: 0, z: 0 };
  readonly seed: number;
  /** Зоны построек: под ними рельеф выровнен до уровня земли в центре зоны */
  readonly zones: Zone[];

  constructor(seed = Math.floor(Math.random() * 1e9)) {
    this.seed = seed;
    this.zones = planZones(seed).map((z) => ({ ...z, level: this.rawHeight(z.x, z.z) }));
  }

  /** Высота вершины без выравнивания под постройки */
  private rawVertex(ix: number, iz: number): number {
    const wx = ix * TILE;
    const wz = iz * TILE;
    let h = (fbm(wx * HILL_FREQ, wz * HILL_FREQ, this.seed) - 0.5) * 2 * HILL_AMPLITUDE;
    h += (valueNoise(wx * RIDGE_FREQ, wz * RIDGE_FREQ, this.seed + 7777) - 0.5) * 2 * RIDGE_AMPLITUDE;

    // Плавно сглаживаем к спавну, чтобы старт был на ровном месте
    const d = Math.hypot(wx - this.spawn.x, wz - this.spawn.z);
    h *= smooth(clamp01((d - 5) / 12));
    return h;
  }

  /** Высота вершины сетки (ix, iz) — узлы сетки идут с шагом TILE */
  vertexHeight(ix: number, iz: number): number {
    let h = this.rawVertex(ix, iz);
    // Под постройками — ровная площадка, дальше плавно к природному рельефу
    const wx = ix * TILE;
    const wz = iz * TILE;
    for (const z of this.zones) {
      const cheb = Math.max(Math.abs(wx - z.x), Math.abs(wz - z.z));
      const inner = z.half + 2;
      if (cheb >= inner + FLAT_BLEND) continue;
      const w = 1 - smooth(clamp01((cheb - inner) / FLAT_BLEND));
      h += (z.level - h) * w;
    }
    return h;
  }

  /** Природная высота в точке (билинейно по сырым вершинам) — по ней берётся уровень площадок */
  private rawHeight(wx: number, wz: number): number {
    const gx = wx / TILE;
    const gz = wz / TILE;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const top = this.rawVertex(x0, z0) + (this.rawVertex(x0 + 1, z0) - this.rawVertex(x0, z0)) * fx;
    const bottom = this.rawVertex(x0, z0 + 1) + (this.rawVertex(x0 + 1, z0 + 1) - this.rawVertex(x0, z0 + 1)) * fx;
    return top + (bottom - top) * fz;
  }

  /** Высота рельефа в мировой точке (билинейная интерполяция между узлами) */
  getHeight(wx: number, wz: number): number {
    const gx = wx / TILE;
    const gz = wz / TILE;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;

    const h00 = this.vertexHeight(x0, z0);
    const h10 = this.vertexHeight(x0 + 1, z0);
    const h01 = this.vertexHeight(x0, z0 + 1);
    const h11 = this.vertexHeight(x0 + 1, z0 + 1);

    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fz;
  }

  /**
   * Биом «влажности» в точке, 0..1 — низкочастотный шум масштабом ~90 юнитов.
   * Используется рендером для плавной тонировки земли (выжженное ↔ сырое).
   */
  biomeAt(wx: number, wz: number): number {
    return fbm(wx * 0.011, wz * 0.011, this.seed ^ 0x5b10, 3);
  }
}
