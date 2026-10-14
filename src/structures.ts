/**
 * Постройки на карте: платформы, стены и лестницы. Всё детерминировано по сиду
 * мира, поэтому клиент и сервер строят одну и ту же карту.
 *
 * Постройка — набор осевых коробок, которые стоят на земле и уходят вниз
 * «в глубину» (сплошные снизу доверху). Поэтому для физики это обычная высотная
 * поверхность с вертикальными краями: сверху можно стоять и ходить, сбоку
 * высокая стенка не пускает (Player: подъём не выше STEP_UP), а заряды и
 * лучи упираются в неё, как в рельеф. Под каждой постройкой рельеф выровнен
 * (Terrain.zones), чтобы ступени и стены стояли ровно.
 *
 * Зоны трёх видов:
 *  – «зиккурат»: три яруса-платформы со ступенями с одной стороны;
 *  – «форт»: кольцо стен с двумя проходами, башни по углам, лестница на стену,
 *    внутри платформа и укрытия;
 *  – «руины»: разрозненные стены разной высоты (низкие перепрыгиваются) и
 *    небольшая платформа.
 */

export type ZoneKind = "ziggurat" | "fort" | "ruins";

export interface PlannedZone {
  kind: ZoneKind;
  x: number;
  z: number;
  /** Половина стороны выровненной площадки (в ней лежит вся постройка) */
  half: number;
}

/** Зона с уровнем земли под ней (его определяет Terrain по сырому рельефу в центре) */
export interface Zone extends PlannedZone {
  level: number;
}

/** Материал коробки (разный цвет кладки) */
export const MAT_WALL = 0;
export const MAT_PLATFORM = 1;
export const MAT_STAIRS = 2;

export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
  /** Низ (глубоко под землёй — виден только то, что выше рельефа) */
  bot: number;
  mat: number;
}

/** Шаги по высоте: подъём одной ступени меньше STEP_UP игрока (0.55) */
const RISER = 0.4;
const TREAD = 1.6;
const STAIR_WIDTH = 3.2;
const BOX_DEPTH = 8;
/** Мир: половина размера, юнитов */
const WORLD_HALF = 128;

const ZONE_HALF: Record<ZoneKind, number> = { ziggurat: 16, fort: 20, ruins: 17 };
const MAX_ZONES = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Раскладка зон по сиду: далеко от спавна и края, зоны не перекрываются */
export function planZones(seed: number): PlannedZone[] {
  const rnd = mulberry32((seed ^ 0x57ac1) >>> 0);
  const kinds: ZoneKind[] = ["fort", "ziggurat", "ruins"];
  const out: PlannedZone[] = [];
  for (let attempt = 0; attempt < 600 && out.length < MAX_ZONES; attempt++) {
    const kind = kinds[out.length % kinds.length];
    const half = ZONE_HALF[kind];
    const lim = WORLD_HALF - half - 6;
    const x = (rnd() * 2 - 1) * lim;
    const z = (rnd() * 2 - 1) * lim;
    if (Math.hypot(x, z) < half + 26) continue; // спавн должен остаться свободным
    if (out.some((o) => Math.max(Math.abs(o.x - x), Math.abs(o.z - z)) < o.half + half + 12)) continue;
    out.push({ kind, x, z, half });
  }
  return out;
}

// ---------- Сборка коробок ----------

/** Поворот локальных координат зоны на k·90° вокруг её центра */
function rot(k: number, lx: number, lz: number): [number, number] {
  switch (k & 3) {
    case 1:
      return [-lz, lx];
    case 2:
      return [-lx, -lz];
    case 3:
      return [lz, -lx];
    default:
      return [lx, lz];
  }
}

class Builder {
  readonly boxes: Box[] = [];
  constructor(
    private readonly cx: number,
    private readonly cz: number,
    private readonly level: number,
    private readonly k: number,
  ) {}

  /** Коробка в локальных координатах: x — «вперёд» зоны, высота — над уровнем земли */
  add(lx0: number, lx1: number, lz0: number, lz1: number, h: number, mat: number): void {
    const [ax, az] = rot(this.k, lx0, lz0);
    const [bx, bz] = rot(this.k, lx1, lz1);
    const top = this.level + h;
    this.boxes.push({
      x0: this.cx + Math.min(ax, bx),
      x1: this.cx + Math.max(ax, bx),
      z0: this.cz + Math.min(az, bz),
      z1: this.cz + Math.max(az, bz),
      top,
      bot: top - BOX_DEPTH,
      mat,
    });
  }

  /**
   * Лестница вдоль +x (в локальных осях) к площадке с краем на x = edge и верхом
   * topH: ступени по RISER вниз от верха площадки, каждая шириной TREAD.
   * maxX — до куда ступени можно тянуть (чтобы не вылезти за нижний ярус).
   */
  stairs(edge: number, topH: number, zc: number, steps: number, maxX = Infinity): void {
    for (let i = 1; i <= steps; i++) {
      const h = topH - RISER * i;
      if (h <= 0) break;
      const x0 = edge + (i - 1) * TREAD;
      const x1 = Math.min(maxX, edge + i * TREAD);
      if (x1 - x0 < 0.4) continue;
      this.add(x0, x1, zc - STAIR_WIDTH / 2, zc + STAIR_WIDTH / 2, h, MAT_STAIRS);
    }
  }
}

function buildZiggurat(b: Builder): void {
  // Три яруса: 1.2 / 2.4 / 3.6 над землёй
  b.add(-8, 8, -8, 8, 1.2, MAT_PLATFORM);
  b.add(-5, 5, -5, 5, 2.4, MAT_PLATFORM);
  b.add(-2.5, 2.5, -2.5, 2.5, 3.6, MAT_PLATFORM);
  // Подъём с одной стороны: землю → ярус 1 → ярус 2 → ярус 3 (каждая лестница в границах нижнего яруса)
  b.stairs(8, 1.2, 0, 2);
  b.stairs(5, 2.4, 0, 2, 8);
  b.stairs(2.5, 3.6, 0, 2, 5);
}

function buildFort(b: Builder): void {
  const H = 2.4;
  // Кольцо стен половиной 10 толщиной 2; проходы на ±x (шириной 4)
  b.add(-10, 10, 8, 10, H, MAT_WALL); // +z
  b.add(-10, 10, -10, -8, H, MAT_WALL); // -z
  b.add(8, 10, -10, -2, H, MAT_WALL); // +x, левая часть
  b.add(8, 10, 2, 10, H, MAT_WALL); // +x, правая
  b.add(-10, -8, -10, -2, H, MAT_WALL);
  b.add(-10, -8, 2, 10, H, MAT_WALL);
  // Угловые башни выше стены
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(sx * 10 - 2, sx * 10 + 2, sz * 10 - 2, sz * 10 + 2, 3.6, MAT_PLATFORM);
    }
  }
  // Лестница на стену снаружи (вдоль -z стены, смещена от прохода): оси лестниц идут вдоль +x локально,
  // поэтому поворачиваем её в сторону стены через отдельную раскладку вручную
  for (let i = 1; i <= 5; i++) {
    const h = H - RISER * i;
    if (h <= 0) break;
    const z1 = -10 - (i - 1) * TREAD;
    const z0 = -10 - i * TREAD;
    b.add(3.4, 3.4 + STAIR_WIDTH, z0, z1, h, MAT_STAIRS);
  }
  // Внутри: платформа по центру со ступенями и два укрытия
  b.add(-2.5, 2.5, -2.5, 2.5, 1.2, MAT_PLATFORM);
  b.stairs(2.5, 1.2, 0, 2);
  b.add(-6, -4, 4, 6, 1.4, MAT_WALL);
  b.add(4, 6, -6, -4, 1.4, MAT_WALL);
}

function buildRuins(b: Builder, rnd: () => number): void {
  // Небольшая платформа в центре
  b.add(-3, 3, -3, 3, 1.6, MAT_PLATFORM);
  b.stairs(3, 1.6, 0, 3);
  // Разрозненные стены разной высоты: низкие (1.4) можно перепрыгнуть, высокие — нет
  const heights = [1.4, 1.4, 2.4, 3.2];
  const placed: [number, number][] = [];
  for (let attempt = 0; attempt < 60 && placed.length < 8; attempt++) {
    const px = (rnd() * 2 - 1) * 11;
    const pz = (rnd() * 2 - 1) * 11;
    if (Math.hypot(px, pz) < 8.5) continue; // не на платформе
    if (placed.some(([qx, qz]) => Math.max(Math.abs(qx - px), Math.abs(qz - pz)) < 7)) continue;
    const len = 4 + rnd() * 5;
    const h = heights[Math.floor(rnd() * heights.length)];
    if (rnd() < 0.5) b.add(px - len / 2, px + len / 2, pz - 1, pz + 1, h, MAT_WALL);
    else b.add(px - 1, px + 1, pz - len / 2, pz + len / 2, h, MAT_WALL);
    placed.push([px, pz]);
  }
}

export function buildBoxes(zones: readonly Zone[], seed: number): Box[] {
  const rnd = mulberry32((seed ^ 0x9e3779) >>> 0);
  const all: Box[] = [];
  for (const z of zones) {
    const b = new Builder(z.x, z.z, z.level, Math.floor(rnd() * 4));
    if (z.kind === "ziggurat") buildZiggurat(b);
    else if (z.kind === "fort") buildFort(b);
    else buildRuins(b, rnd);
    for (const box of b.boxes) all.push(box);
  }
  return all;
}

// ---------- Запросы ----------

const GRID_CELL = 8;
const GRID_ORIGIN = -(WORLD_HALF + 16);
const GRID_DIM = Math.ceil((WORLD_HALF + 16) * 2 / GRID_CELL);

export class Structures {
  readonly boxes: Box[];
  private readonly grid: number[][] = [];

  constructor(zones: readonly Zone[], seed: number) {
    this.boxes = buildBoxes(zones, seed);
    for (let i = 0; i < GRID_DIM * GRID_DIM; i++) this.grid.push([]);
    this.boxes.forEach((b, i) => {
      // Коробка записана во все клетки, которые она задевает с запасом 1 (для расширенных запросов)
      const gx0 = this.cell(b.x0 - 1);
      const gx1 = this.cell(b.x1 + 1);
      const gz0 = this.cell(b.z0 - 1);
      const gz1 = this.cell(b.z1 + 1);
      for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) this.grid[gz * GRID_DIM + gx].push(i);
    });
  }

  private cell(v: number): number {
    const c = Math.floor((v - GRID_ORIGIN) / GRID_CELL);
    return c < 0 ? 0 : c >= GRID_DIM ? GRID_DIM - 1 : c;
  }

  /** Верх самой высокой коробки над точкой (−∞, если там нет построек) */
  topAt(x: number, z: number): number {
    return this.solidTopAt(x, z, 0);
  }

  /**
   * Верх самой высокой коробки, чей контур, расширенный на r, накрывает точку.
   * Так тело радиуса r не заходит в стену: для движения берётся r = радиус игрока.
   */
  solidTopAt(x: number, z: number, r: number): number {
    const cellList = this.grid[this.cell(z) * GRID_DIM + this.cell(x)];
    let top = -Infinity;
    for (let i = 0; i < cellList.length; i++) {
      const b = this.boxes[cellList[i]];
      if (b.top > top && x >= b.x0 - r && x <= b.x1 + r && z >= b.z0 - r && z <= b.z1 + r) top = b.top;
    }
    return top;
  }
}
