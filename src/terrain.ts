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
function hash2i(ix: number, iz: number, seed: number): number {
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

/**
 * Бесконечный террейн. Высота — чистая функция от мировых координат (шум),
 * стены — детерминированно генерируются по чанкам и кешируются лениво.
 * Меши здесь не создаются — этим занимается ChunkManager.
 */
export class Terrain {
  /** Точка спавна игрока: начало координат, там всегда ровно и без стен */
  readonly spawn = { x: 0, z: 0 };
  readonly seed: number;

  private chunks = new Map<number, ChunkData>();

  constructor(seed = Math.floor(Math.random() * 1e9)) {
    this.seed = seed;
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

  /** Стена ли в абсолютной клетке */
  isWall(cellX: number, cellZ: number): boolean {
    const cx = Terrain.chunkOfCell(cellX);
    const cz = Terrain.chunkOfCell(cellZ);
    const data = this.getChunk(cx, cz);
    const lx = cellX - cx * CHUNK_CELLS;
    const lz = cellZ - cz * CHUNK_CELLS;
    return data.wallMask[lz * CHUNK_CELLS + lx] === 1;
  }

  /** Блок стены с осевыми координатами (q, r) или null. Блок принадлежит чанку, где лежит его центр. */
  hexWall(q: number, r: number): HexWall | null {
    const c = hexCenter(q, r);
    const data = this.getChunk(Terrain.chunkOf(c.x), Terrain.chunkOf(c.z));
    return data.hexSet.get(hexKey(q, r)) ?? null;
  }

  /** Стена ли в мировой точке — точная проверка по геометрии шестиугольника (для снарядов) */
  isWallAt(wx: number, wz: number): boolean {
    const h = hexAt(wx, wz);
    return this.hexWall(h.q, h.r) !== null;
  }

  /** Высота верха стены (мировой Y) в точке или null, если стены нет — для камеры и пуль */
  wallTopAt(wx: number, wz: number): number | null {
    const h = hexAt(wx, wz);
    const wall = this.hexWall(h.q, h.r);
    return wall ? this.getHeight(wall.x, wall.z) + wall.height : null;
  }

  /** Высота опоры в точке: верх стены, если она там есть, иначе рельеф — по ней ходит игрок */
  floorAt(wx: number, wz: number): number {
    return this.wallTopAt(wx, wz) ?? this.getHeight(wx, wz);
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
   * Возвращает центр клетки.
   */
  randomOpenPoint(
    from: { x: number; z: number },
    minDist: number,
    maxDist: number,
  ): { x: number; z: number } {
    for (let attempt = 0; attempt < 300; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = minDist + Math.random() * (maxDist - minDist);
      const cx = Terrain.cellOf(from.x + Math.cos(angle) * dist);
      const cz = Terrain.cellOf(from.z + Math.sin(angle) * dist);
      if (this.isWall(cx, cz)) continue;
      return { x: (cx + 0.5) * TILE, z: (cz + 0.5) * TILE };
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

    /** Можно ли поставить блок в (q, r): внутри допустимой зоны, не у спавна, не занято */
    const allowed = (q: number, r: number): boolean => {
      if (hexSet.has(hexKey(q, r))) return false;
      const c = hexCenter(q, r);
      if (c.x < minX || c.x >= maxX || c.z < minZ || c.z >= maxZ) return false;
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

    const chains = CHAINS_MIN + Math.floor(rand() * (CHAINS_MAX - CHAINS_MIN + 1));
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
