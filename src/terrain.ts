/** Размер одной клетки в мировых единицах */
export const TILE = 2;
/** Размер чанка в клетках (16 * 2 = 32 юнита) */
export const CHUNK_CELLS = 16;
/** Размер чанка в мировых единицах */
export const CHUNK_SIZE = CHUNK_CELLS * TILE;

// ---------- Детерминированный шум ----------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Хеш целых координат -> [0, 1). Работает и с отрицательными координатами. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 974711);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Хеш целых координат -> целое (для сидирования генератора чанка) */
export function hash2i(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 974711);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return h ^ (h >>> 16);
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

/** Мелкие холмы */
const HILL_AMPLITUDE = 2.6;
const HILL_FREQ = 0.045; // на мировой юнит
/** Крупные возвышенности */
const RIDGE_AMPLITUDE = 3.2;
const RIDGE_FREQ = 0.011;
/** Радиус (в клетках) вокруг спавна, где стены не ставятся */
const SPAWN_CLEAR_CELLS = 9;

// ---------- Шестиугольная сетка стен ----------
// Стены собраны из шестигранных призм на отдельной hex-сетке (flat-top: вершины по ±X,
// плоские стороны по ±Z). Осевые координаты (q, r).

/** Радиус описанной окружности шестиугольника (расстояние до вершины) */
export const HEX_R = 2.0;
/** Радиус вписанной окружности (расстояние до стороны) */
export const HEX_INRADIUS = (HEX_R * Math.sqrt(3)) / 2;
/** Расстояние между центрами соседних шестиугольников */
export const HEX_SPACING = HEX_INRADIUS * 2;
/** Диапазон высот блоков. Низкие берутся прыжком с земли (~2.2 + подтягивание), высокие — с соседних блоков */
export const HEX_HEIGHT_MIN = 1.8;
export const HEX_HEIGHT_MAX = 5.6;
/** Растеризация в клетки: клетка считается стеной, если её центр в шестиугольнике, расширенном на это */
const RASTER_MARGIN = 0.55;
/** Цепочек стен на чанк */
const CHAINS_MIN = 1;
const CHAINS_MAX = 3;
/** Длина цепочки (блоков) */
const CHAIN_MIN = 3;
const CHAIN_MAX = 8;

/** Шесть соседей в осевых координатах (flat-top), по кругу */
const HEX_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Центр шестиугольника (q, r) в мировых координатах */
export function hexCenter(q: number, r: number): { x: number; z: number } {
  return { x: HEX_R * 1.5 * q, z: HEX_R * Math.sqrt(3) * (r + q / 2) };
}

/** Мировая точка -> ближайший шестиугольник (осевые координаты) */
export function hexAt(wx: number, wz: number): { q: number; r: number } {
  const fq = ((2 / 3) * wx) / HEX_R;
  const fr = ((-1 / 3) * wx + (Math.sqrt(3) / 3) * wz) / HEX_R;
  // Округление через кубические координаты
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** Лежит ли точка внутри flat-top шестиугольника с центром (cx, cz) и радиусом описанной окружности rc */
export function pointInHex(px: number, pz: number, cx: number, cz: number, rc: number): boolean {
  const dx = Math.abs(px - cx);
  const dz = Math.abs(pz - cz);
  const s3 = Math.sqrt(3);
  return dz <= (s3 / 2) * rc && s3 * dx + dz <= s3 * rc;
}

function hexKey(q: number, r: number): number {
  return ((q & 0xffff) << 16) | (r & 0xffff);
}

// ---------- Мегаструктуры: макро-регионы ----------

/** Регион — квадрат 8×8 чанков (256 юнитов); в регионе стоит не больше одной мегаструктуры */
export const REGION_CHUNKS = 8;
export const REGION_SIZE = REGION_CHUNKS * CHUNK_SIZE;
const REGION_SEED_SALT = 0x51f07a;
/** Вероятность сооружения в регионе (регион спавна всегда пуст) */
const STRUCTURE_CHANCE = 0.55;
/** Отступ подошвы от границ региона */
const STRUCTURE_MARGIN = 12;

// Зиккурат: квадратные ярусы — ступени ровно в полный прыжок
const ZIG_HALF = 105; // полуширина основания (210×210)
const ZIG_TIERS = 50;
const ZIG_TIER_H = 1.8; // высота яруса — берётся полным прыжком (2.2)
const ZIG_TIER_DEPTH = 2; // глубина яруса — одна колонна карты
const ZIG_RAMP_HALF_W = 4; // пандус: полоса 8 юнитов от подошвы до вершины

// Монолит: вертикальная плита-ориентир
const MON_HX_MIN = 8;
const MON_HX_RND = 8; // полуширина 8–16
const MON_HZ_MIN = 24;
const MON_HZ_RND = 14; // полуглубина 24–38
const MON_H_MIN = 110;
const MON_H_RND = 70; // высота 110–180

export type StructureKind = "ziggurat" | "monolith";

export interface Structure {
  kind: StructureKind;
  /** Центр подошвы */
  cx: number;
  cz: number;
  /** Высота рельефа под центром — от неё отсчитываются ярусы/высота */
  baseY: number;
  /** Зиккурат: полуширина основания, число ярусов, высота и глубина яруса */
  half: number;
  tiers: number;
  tierH: number;
  tierDepth: number;
  /** Сторона пандуса: 0 → +X, 1 → −X, 2 → +Z, 3 → −Z (−1 — нет) */
  rampSide: number;
  rampHalfW: number;
  /** Монолит: полуоси и высота плиты */
  halfX: number;
  halfZ: number;
  height: number;
  /** Верх над baseY (для теней и целей) */
  topH: number;
  /** BBox подошвы (тени, поиск) */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// ---------- Данные ----------

/** Один блок стены — шестигранная призма */
export interface HexWall {
  q: number;
  r: number;
  /** Центр в мировых координатах */
  x: number;
  z: number;
  height: number;
}

/** Сгенерированные данные одного чанка (без мешей) */
export interface ChunkData {
  /** Координаты чанка */
  cx: number;
  cz: number;
  /** Блоки стен, чей центр лежит в этом чанке */
  hexes: HexWall[];
  /** Быстрый поиск блока по осевым координатам */
  hexSet: Map<number, HexWall>;
  /** Растеризованные стены: флаги по локальному индексу клетки lz * CHUNK_CELLS + lx */
  wallMask: Uint8Array;
}

/** Числовой ключ чанка (уникален для координат в диапазоне ±32767) */
export function chunkKey(cx: number, cz: number): number {
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

/** Переключатели генерации (песочница /gen и будущие биомы) */
export interface TerrainOptions {
  /** Рельеф: холмы и возвышенности (false — плоский мир) */
  hills: boolean;
  /** Hex-валуны (стены-цепочки) */
  walls: boolean;
  /** Мегаструктуры (зиккураты, монолиты) */
  structures: boolean;
}
const DEFAULT_TERRAIN_OPTIONS: TerrainOptions = { hills: true, walls: true, structures: true };

/**
 * Бесконечный террейн. Высота — чистая функция от мировых координат (шум),
 * стены — детерминированно генерируются по чанкам и кешируются лениво.
 * Меши здесь не создаются — этим занимается ChunkManager.
 */
export class Terrain {
  /** Точка спавна игрока: начало координат, там всегда ровно и без стен */
  readonly spawn = { x: 0, z: 0 };
  readonly seed: number;
  readonly opts: TerrainOptions;

  private chunks = new Map<number, ChunkData>();

  constructor(seed = Math.floor(Math.random() * 1e9), options: Partial<TerrainOptions> = {}) {
    this.seed = seed;
    this.opts = { ...DEFAULT_TERRAIN_OPTIONS, ...options };
  }

  // ----- Координаты -----

  /** Мировая координата -> индекс клетки */
  static cellOf(w: number): number {
    return Math.floor(w / TILE);
  }

  /** Индекс клетки -> индекс чанка */
  static chunkOfCell(c: number): number {
    return Math.floor(c / CHUNK_CELLS);
  }

  /** Мировая координата -> индекс чанка */
  static chunkOf(w: number): number {
    return Math.floor(w / CHUNK_SIZE);
  }

  // ----- Высоты -----

  /** Высота вершины сетки (ix, iz) — узлы сетки идут с шагом TILE */
  vertexHeight(ix: number, iz: number): number {
    if (!this.opts.hills) return 0; // плоский мир (песочница генерации)
    const wx = ix * TILE;
    const wz = iz * TILE;
    let h = (fbm(wx * HILL_FREQ, wz * HILL_FREQ, this.seed) - 0.5) * 2 * HILL_AMPLITUDE;
    h += (valueNoise(wx * RIDGE_FREQ, wz * RIDGE_FREQ, this.seed + 7777) - 0.5) * 2 * RIDGE_AMPLITUDE;

    // Плавно сглаживаем к спавну, чтобы старт был на ровном месте
    const d = Math.hypot(wx - this.spawn.x, wz - this.spawn.z);
    h *= smooth(clamp01((d - 5) / 12));
    return h;
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

  // ----- Стены -----

  /** Данные чанка (генерируются при первом обращении) */
  getChunk(cx: number, cz: number): ChunkData {
    const key = chunkKey(cx, cz);
    let data = this.chunks.get(key);
    if (!data) {
      data = this.generateChunk(cx, cz);
      this.chunks.set(key, data);
    }
    return data;
  }

  /** Стена ли в абсолютной клетке (включая твёрдые части мегаструктур — для flow field и точек спавна) */
  isWall(cellX: number, cellZ: number): boolean {
    const cx = Terrain.chunkOfCell(cellX);
    const cz = Terrain.chunkOfCell(cellZ);
    const data = this.getChunk(cx, cz);
    const lx = cellX - cx * CHUNK_CELLS;
    const lz = cellZ - cz * CHUNK_CELLS;
    if (data.wallMask[lz * CHUNK_CELLS + lx] === 1) return true;
    const st = this.structureAt((cellX + 0.5) * TILE, (cellZ + 0.5) * TILE);
    return st !== null && !st.ramp;
  }

  /** Блок стены с осевыми координатами (q, r) или null. Блок принадлежит чанку, где лежит его центр. */
  hexWall(q: number, r: number): HexWall | null {
    const c = hexCenter(q, r);
    const data = this.getChunk(Terrain.chunkOf(c.x), Terrain.chunkOf(c.z));
    return data.hexSet.get(hexKey(q, r)) ?? null;
  }

  /** Верх hex-стены в точке или null (без мегаструктур) */
  private hexTopAt(wx: number, wz: number): number | null {
    const h = hexAt(wx, wz);
    const wall = this.hexWall(h.q, h.r);
    return wall ? this.getHeight(wall.x, wall.z) + wall.height : null;
  }

  /** Стена ли в мировой точке: hex-блок или твёрдая часть сооружения (пандус проходим) — для врагов */
  isWallAt(wx: number, wz: number): boolean {
    return this.blocksAt(wx, wz) !== null;
  }

  /**
   * Высота верха преграды (мировой Y) в точке или null: hex-стена или мегаструктура,
   * включая пандусы — это «твёрдая поверхность над рельефом», для пуль и опоры.
   */
  wallTopAt(wx: number, wz: number): number | null {
    const hexTop = this.hexTopAt(wx, wz);
    const st = this.structureAt(wx, wz);
    if (st === null) return hexTop;
    return hexTop !== null ? Math.max(hexTop, st.top) : st.top;
  }

  /** Верх блокирующей преграды в точке (стены и твёрдые части сооружений; пандус не блокирует) или null */
  blocksAt(wx: number, wz: number): number | null {
    const st = this.structureAt(wx, wz);
    const hexTop = this.hexTopAt(wx, wz);
    if (st === null || st.ramp) return hexTop;
    return hexTop !== null ? Math.max(hexTop, st.top) : st.top;
  }

  /** Высота опоры в точке: верх стены/сооружения, если она там есть, иначе рельеф — по ней ходит игрок */
  floorAt(wx: number, wz: number): number {
    return this.wallTopAt(wx, wz) ?? this.getHeight(wx, wz);
  }

  /**
   * Биом «влажности» в точке, 0..1 — низкочастотный шум масштабом ~90 юнитов.
   * Используется рендером для плавной тонировки земли (выжженное ↔ сырое).
   */
  biomeAt(wx: number, wz: number): number {
    return fbm(wx * 0.011, wz * 0.011, this.seed ^ 0x5b10, 3);
  }

  // ----- Мегаструктуры -----

  private structures = new Map<number, Structure | null>();
  /** Мемо последнего региона: запросы идут плотными кластерами по соседним точкам */
  private lastRegionKey = -1;
  private lastRegionStruct: Structure | null = null;

  /** Сооружение региона (детерминированно из сида) или null */
  structureInRegion(rx: number, rz: number): Structure | null {
    if (!this.opts.structures) return null;
    const key = chunkKey(rx, rz);
    if (key === this.lastRegionKey) return this.lastRegionStruct;
    let s = this.structures.get(key);
    if (s === undefined) {
      s = this.generateStructure(rx, rz);
      this.structures.set(key, s);
    }
    this.lastRegionKey = key;
    this.lastRegionStruct = s;
    return s;
  }

  /**
   * Сооружение в мировой точке: высота верха и признак пандуса (проходимого склона);
   * null — сооружения нет. Аналитически, без hex-квантования.
   */
  structureAt(wx: number, wz: number): { top: number; ramp: boolean } | null {
    const s = this.structureInRegion(Math.floor(wx / REGION_SIZE), Math.floor(wz / REGION_SIZE));
    if (!s || wx < s.minX || wx > s.maxX || wz < s.minZ || wz > s.maxZ) return null;
    if (s.kind === "monolith") return { top: s.baseY + s.height, ramp: false };
    // Зиккурат: ярусы по чебышёвской дистанции от центра
    const dx = Math.abs(wx - s.cx);
    const dz = Math.abs(wz - s.cz);
    const d = Math.max(dx, dz);
    if (d > s.half) return null;
    // Пандус: полоса на одной стороне от подошвы до края плато (плато остаётся твёрдой
    // вершиной), непрерывный склон с тем же уклоном, что у ярусов
    const along =
      s.rampSide === 0 ? wx - s.cx : s.rampSide === 1 ? s.cx - wx : s.rampSide === 2 ? wz - s.cz : s.cz - wz;
    const across = s.rampSide <= 1 ? dz : dx;
    const plateau = s.half - s.tiers * s.tierDepth;
    if (along > plateau && across <= s.rampHalfW) {
      const slope = s.tierH / s.tierDepth;
      return { top: s.baseY + Math.min(s.topH, (s.half - along) * slope), ramp: true };
    }
    const tier = Math.min(s.tiers, Math.floor((s.half - d) / s.tierDepth) + 1);
    return { top: s.baseY + tier * s.tierH, ramp: false };
  }

  /** Ближайшее сооружение заданного типа с центром в кольце [minDist, maxDist] от точки */
  nearestStructure(x: number, z: number, minDist: number, maxDist: number, kind?: StructureKind): Structure | null {
    const rx0 = Math.floor((x - maxDist) / REGION_SIZE);
    const rx1 = Math.floor((x + maxDist) / REGION_SIZE);
    const rz0 = Math.floor((z - maxDist) / REGION_SIZE);
    const rz1 = Math.floor((z + maxDist) / REGION_SIZE);
    let best: Structure | null = null;
    let bestD = Infinity;
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        const s = this.structureInRegion(rx, rz);
        if (!s || (kind && s.kind !== kind)) continue;
        const d = Math.hypot(s.cx - x, s.cz - z);
        if (d < minDist || d > maxDist || d >= bestD) continue;
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  /** Может ли сооружение отбрасывать тень на тайл чанка (сооружение в пределах reach юнитов) */
  structureNearTile(tx: number, tz: number, reach: number): boolean {
    const x0 = tx * CHUNK_SIZE - reach;
    const x1 = (tx + 1) * CHUNK_SIZE + reach;
    const z0 = tz * CHUNK_SIZE - reach;
    const z1 = (tz + 1) * CHUNK_SIZE + reach;
    const rx0 = Math.floor(x0 / REGION_SIZE);
    const rx1 = Math.floor(x1 / REGION_SIZE);
    const rz0 = Math.floor(z0 / REGION_SIZE);
    const rz1 = Math.floor(z1 / REGION_SIZE);
    for (let rz = rz0; rz <= rz1; rz++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        const s = this.structureInRegion(rx, rz);
        if (s && s.maxX >= x0 && s.minX <= x1 && s.maxZ >= z0 && s.minZ <= z1) return true;
      }
    }
    return false;
  }

  /** Генерация сооружения региона: детерминированно, подошва целиком внутри региона */
  private generateStructure(rx: number, rz: number): Structure | null {
    // Регион спавна всегда пуст
    if (rx === Math.floor(this.spawn.x / REGION_SIZE) && rz === Math.floor(this.spawn.z / REGION_SIZE)) return null;
    const rand = mulberry32(hash2i(rx, rz, this.seed ^ REGION_SEED_SALT));
    if (rand() >= STRUCTURE_CHANCE) return null;
    const rcx = (rx + 0.5) * REGION_SIZE;
    const rcz = (rz + 0.5) * REGION_SIZE;
    if (rand() < 0.6) {
      // Зиккурат
      const half = ZIG_HALF;
      const free = REGION_SIZE / 2 - half - STRUCTURE_MARGIN;
      const cx = rcx + (rand() * 2 - 1) * free;
      const cz = rcz + (rand() * 2 - 1) * free;
      return {
        kind: "ziggurat",
        cx,
        cz,
        baseY: this.getHeight(cx, cz),
        half,
        tiers: ZIG_TIERS,
        tierH: ZIG_TIER_H,
        tierDepth: ZIG_TIER_DEPTH,
        rampSide: Math.floor(rand() * 4),
        rampHalfW: ZIG_RAMP_HALF_W,
        halfX: 0,
        halfZ: 0,
        height: 0,
        topH: ZIG_TIERS * ZIG_TIER_H,
        minX: cx - half,
        maxX: cx + half,
        minZ: cz - half,
        maxZ: cz + half,
      };
    }
    // Монолит
    const halfX = MON_HX_MIN + rand() * MON_HX_RND;
    const halfZ = MON_HZ_MIN + rand() * MON_HZ_RND;
    const hx = rand() < 0.5 ? halfX : halfZ; // поворот на 90°
    const hz = hx === halfX ? halfZ : halfX;
    const height = MON_H_MIN + rand() * MON_H_RND;
    const cx = rcx + (rand() * 2 - 1) * (REGION_SIZE / 2 - hx - STRUCTURE_MARGIN);
    const cz = rcz + (rand() * 2 - 1) * (REGION_SIZE / 2 - hz - STRUCTURE_MARGIN);
    return {
      kind: "monolith",
      cx,
      cz,
      baseY: this.getHeight(cx, cz),
      half: 0,
      tiers: 0,
      tierH: 0,
      tierDepth: 0,
      rampSide: -1,
      rampHalfW: 0,
      halfX: hx,
      halfZ: hz,
      height,
      topH: height,
      minX: cx - hx,
      maxX: cx + hx,
      minZ: cz - hz,
      maxZ: cz + hz,
    };
  }

  /** Забыть данные чанков дальше radius (в чанках) от центра — чтобы кеш не рос бесконечно */
  pruneChunks(centerCx: number, centerCz: number, radius: number): void {
    for (const [key, data] of this.chunks) {
      if (Math.abs(data.cx - centerCx) > radius || Math.abs(data.cz - centerCz) > radius) {
        this.chunks.delete(key);
      }
    }
  }

  /**
   * Случайная открытая точка (не стена) на расстоянии [minDist, maxDist] от заданной.
   * Возвращает центр клетки. Если кольцо целиком занято (игрок на вершине
   * зиккурата — вокруг одни ярусы), кольцо расширяется, пока не найдётся земля.
   */
  randomOpenPoint(
    from: { x: number; z: number },
    minDist: number,
    maxDist: number,
  ): { x: number; z: number } {
    for (let round = 0; round < 4; round++) {
      const maxD = maxDist * (1 + round * 0.75);
      for (let attempt = 0; attempt < 300; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = minDist + Math.random() * (maxD - minDist);
        const cx = Terrain.cellOf(from.x + Math.cos(angle) * dist);
        const cz = Terrain.cellOf(from.z + Math.sin(angle) * dist);
        if (this.isWall(cx, cz)) continue;
        return { x: (cx + 0.5) * TILE, z: (cz + 0.5) * TILE };
      }
    }
    return { x: from.x + minDist, z: from.z };
  }

  // ----- Генерация чанка -----

  /**
   * Стены чанка: цепочки шестигранных блоков, детерминированно по сиду.
   *
   * Цепочка — случайное блуждание по hex-сетке. Блок добавляется, только если среди его
   * шести соседей ровно один уже стена (предыдущий блок цепочки), поэтому ни к одному блоку
   * никогда не прилегает больше двух других — ни внутри цепочки, ни между цепочками.
   *
   * Центры блоков держатся на расстоянии >= HEX_SPACING от границ чанка: тогда блоки соседних
   * чанков не могут оказаться смежными, а растеризация блока целиком попадает в свой чанк.
   */
  private generateChunk(cx: number, cz: number): ChunkData {
    const hexes: HexWall[] = [];
    const hexSet = new Map<number, HexWall>();
    const wallMask = new Uint8Array(CHUNK_CELLS * CHUNK_CELLS);
    const rand = mulberry32(hash2i(cx, cz, this.seed ^ 0x9e3779b9));

    const minX = cx * CHUNK_SIZE + HEX_SPACING;
    const maxX = (cx + 1) * CHUNK_SIZE - HEX_SPACING;
    const minZ = cz * CHUNK_SIZE + HEX_SPACING;
    const maxZ = (cz + 1) * CHUNK_SIZE - HEX_SPACING;
    const spawnClear = SPAWN_CLEAR_CELLS * TILE;

    /** Можно ли поставить блок в (q, r): внутри допустимой зоны, не у спавна, не занято, не в сооружении */
    const allowed = (q: number, r: number): boolean => {
      if (hexSet.has(hexKey(q, r))) return false;
      const c = hexCenter(q, r);
      if (c.x < minX || c.x >= maxX || c.z < minZ || c.z >= maxZ) return false;
      if (this.structureAt(c.x, c.z) !== null) return false; // валуны не растут сквозь мегаструктуры
      return Math.hypot(c.x - this.spawn.x, c.z - this.spawn.z) >= spawnClear + HEX_R;
    };

    /** Сколько соседей (q, r) уже стены */
    const wallNeighbors = (q: number, r: number): number => {
      let n = 0;
      for (const [dq, dr] of HEX_DIRS) if (hexSet.has(hexKey(q + dq, r + dr))) n++;
      return n;
    };

    const place = (q: number, r: number): void => {
      const c = hexCenter(q, r);
      const wall: HexWall = {
        q,
        r,
        x: c.x,
        z: c.z,
        height: HEX_HEIGHT_MIN + rand() * (HEX_HEIGHT_MAX - HEX_HEIGHT_MIN),
      };
      hexes.push(wall);
      hexSet.set(hexKey(q, r), wall);
      this.rasterizeHex(wall, cx, cz, wallMask);
    };

    const chains = this.opts.walls ? CHAINS_MIN + Math.floor(rand() * (CHAINS_MAX - CHAINS_MIN + 1)) : 0;
    for (let c = 0; c < chains; c++) {
      // Старт: свободный блок без соседей-стен
      let start: { q: number; r: number } | null = null;
      for (let t = 0; t < 12 && !start; t++) {
        const h = hexAt(minX + rand() * (maxX - minX), minZ + rand() * (maxZ - minZ));
        if (allowed(h.q, h.r) && wallNeighbors(h.q, h.r) === 0) start = h;
      }
      if (!start) continue;

      place(start.q, start.r);
      let { q, r } = start;
      let dir = Math.floor(rand() * 6);
      const length = CHAIN_MIN + Math.floor(rand() * (CHAIN_MAX - CHAIN_MIN + 1));

      for (let i = 1; i < length; i++) {
        // Предпочитаем идти прямо, иначе поворот на ±60°; разворот на 120°+ создал бы
        // смежность с позапрошлым блоком и всё равно был бы отвергнут проверкой соседей
        const preferred = rand() < 0.55 ? 0 : rand() < 0.5 ? 1 : 5;
        const turns = preferred === 0 ? [0, 1, 5] : [preferred, 0, 6 - preferred];
        let placed = false;
        for (const t of turns) {
          const nd = (dir + t) % 6;
          const nq = q + HEX_DIRS[nd][0];
          const nr = r + HEX_DIRS[nd][1];
          if (!allowed(nq, nr) || wallNeighbors(nq, nr) !== 1) continue;
          place(nq, nr);
          q = nq;
          r = nr;
          dir = nd;
          placed = true;
          break;
        }
        if (!placed) break; // цепочка упёрлась — заканчиваем
      }
    }

    return { cx, cz, hexes, hexSet, wallMask };
  }

  /** Помечает клетки чанка, центры которых лежат в блоке (с небольшим запасом) */
  private rasterizeHex(wall: HexWall, cx: number, cz: number, wallMask: Uint8Array): void {
    const reach = HEX_INRADIUS + RASTER_MARGIN;
    const rc = (reach * 2) / Math.sqrt(3); // описанный радиус расширенного шестиугольника
    const baseX = cx * CHUNK_CELLS;
    const baseZ = cz * CHUNK_CELLS;
    const c0x = Terrain.cellOf(wall.x - reach);
    const c1x = Terrain.cellOf(wall.x + reach);
    const c0z = Terrain.cellOf(wall.z - reach);
    const c1z = Terrain.cellOf(wall.z + reach);
    for (let cellZ = c0z; cellZ <= c1z; cellZ++) {
      for (let cellX = c0x; cellX <= c1x; cellX++) {
        const lx = cellX - baseX;
        const lz = cellZ - baseZ;
        if (lx < 0 || lz < 0 || lx >= CHUNK_CELLS || lz >= CHUNK_CELLS) continue;
        const px = (cellX + 0.5) * TILE;
        const pz = (cellZ + 0.5) * TILE;
        if (pointInHex(px, pz, wall.x, wall.z, rc)) wallMask[lz * CHUNK_CELLS + lx] = 1;
      }
    }
  }
}
