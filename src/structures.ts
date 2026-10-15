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
 * Летающие платформы — тонкие коробки, повисшие в воздухе (floating): под ними
 * можно ходить, снизу их можно пробить прыжком, а сверху на них можно встать.
 * Для них физика спрашивает опору с учётом высоты ступней (supportAt), а
 * заряды — попадание в точку (hitFloating).
 *
 * Зоны пяти видов:
 *  – «зиккурат»: три яруса-платформы со ступенями с одной стороны;
 *  – «форт»: кольцо стен с двумя проходами, башни по углам, лестница на стену,
 *    внутри платформа и укрытия;
 *  – «руины»: разрозненные стены разной высоты (низкие перепрыгиваются) и
 *    небольшая платформа;
 *  – «укрытия»: короткие стены Г-образно, коридором или с колоннами;
 *  – «небо»: кольцо летающих платформ вокруг высокой центральной.
 */

export type ZoneKind = "ziggurat" | "fort" | "ruins" | "cover" | "sky";

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
export const MAT_SKY = 3;

/** Выше этого от ступни стена не пускает (ступени лестницы — 0.4) */
export const STEP_UP = 0.55;
/** Высота тела для проверки «задеваю ли головой» (под платформой с низом выше — проходим) */
export const BODY_H = 1.7;

export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
  /** Низ (у стоящих на земле — глубоко под землёй, у летающих — чуть ниже верха) */
  bot: number;
  mat: number;
  /** Летающая платформа: под ней можно пройти */
  floating: boolean;
}

/** Шаги по высоте: подъём одной ступени меньше STEP_UP игрока (0.55) */
const RISER = 0.4;
const TREAD = 1.6;
const STAIR_WIDTH = 3.2;
const BOX_DEPTH = 8;
/** Мир: половина размера, юнитов */
const WORLD_HALF = 128;

const ZONE_HALF: Record<ZoneKind, number> = { ziggurat: 16, fort: 20, ruins: 17, cover: 10, sky: 14 };
const MAX_ZONES = 14;
/** Порядок видов при раскладке: крупные и мелкие чередуются */
const ZONE_ORDER: ZoneKind[] = ["fort", "sky", "cover", "ziggurat", "cover", "ruins", "sky", "cover"];

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
  const out: PlannedZone[] = [];
  for (let attempt = 0; attempt < 3000 && out.length < MAX_ZONES; attempt++) {
    const kind = ZONE_ORDER[out.length % ZONE_ORDER.length];
    const half = ZONE_HALF[kind];
    const lim = WORLD_HALF - half - 6;
    const x = (rnd() * 2 - 1) * lim;
    const z = (rnd() * 2 - 1) * lim;
    if (Math.hypot(x, z) < half + 26) continue; // спавн должен остаться свободным
    if (out.some((o) => Math.max(Math.abs(o.x - x), Math.abs(o.z - z)) < o.half + half + 10)) continue;
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
      floating: false,
    });
  }

  /** Летающая платформа: верх на h над землёй зоны, толщина thick (низ — не ниже BODY_H над землёй) */
  float(lx0: number, lx1: number, lz0: number, lz1: number, h: number, thick: number, mat: number): void {
    const [ax, az] = rot(this.k, lx0, lz0);
    const [bx, bz] = rot(this.k, lx1, lz1);
    const top = this.level + h;
    this.boxes.push({
      x0: this.cx + Math.min(ax, bx),
      x1: this.cx + Math.max(ax, bx),
      z0: this.cz + Math.min(az, bz),
      z1: this.cz + Math.max(az, bz),
      top,
      bot: top - thick,
      mat,
      floating: true,
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

function buildCover(b: Builder, rnd: () => number): void {
  const variant = Math.floor(rnd() * 3);
  if (variant === 0) {
    // Г-образная стена
    b.add(-7, 3, -1, 1, 2.4, MAT_WALL);
    b.add(1, 3, -7, 1, 2.4, MAT_WALL);
    b.add(-7, -5, 4, 6, 1.4, MAT_WALL);
  } else if (variant === 1) {
    // Коридор из двух стен и низкая стенка посередине
    b.add(-7, 7, -5, -3, 2.4, MAT_WALL);
    b.add(-7, 7, 3, 5, 2.4, MAT_WALL);
    b.add(-1, 1, -1, 1, 1.4, MAT_WALL);
  } else {
    // Четыре колонны, соединённые низкими стенками
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(sx * 5 - 1, sx * 5 + 1, sz * 5 - 1, sz * 5 + 1, 3.2, MAT_WALL);
    b.add(-4, 4, -6, -4, 1.4, MAT_WALL);
    b.add(-4, 4, 4, 6, 1.4, MAT_WALL);
  }
}

function buildSky(b: Builder, rnd: () => number): void {
  const T = 0.8; // толщина платформ
  // Кольцо из пяти платформ вокруг высокой центральной; первая — низкая, туда запрыгнуть с блока
  const heights = [3.0, 3.9, 5.1, 6.3, 4.5];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const cx = Math.cos(a) * 8;
    const cz = Math.sin(a) * 8;
    const h = heights[i] + (rnd() - 0.5) * 0.2;
    b.float(cx - 2.5, cx + 2.5, cz - 2.5, cz + 2.5, h, T, MAT_SKY);
  }
  b.float(-3.5, 3.5, -3.5, 3.5, 8.0, T, MAT_SKY);
  // Блок-ступень к первой платформе (на оси +x, у её внешнего края)
  b.add(11, 13, -1, 1, 1.4, MAT_WALL);
}

export function buildBoxes(zones: readonly Zone[], seed: number): Box[] {
  const rnd = mulberry32((seed ^ 0x9e3779) >>> 0);
  const all: Box[] = [];
  for (const z of zones) {
    const b = new Builder(z.x, z.z, z.level, Math.floor(rnd() * 4));
    if (z.kind === "ziggurat") buildZiggurat(b);
    else if (z.kind === "fort") buildFort(b);
    else if (z.kind === "cover") buildCover(b, rnd);
    else if (z.kind === "sky") buildSky(b, rnd);
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

  /** Клетка сетки с точкой (x, z) */
  private cellList(x: number, z: number): number[] {
    return this.grid[this.cell(z) * GRID_DIM + this.cell(x)];
  }

  /** Верх самой высокой стоящей на земле коробки над точкой (−∞, если там нет построек) */
  topAt(x: number, z: number): number {
    return this.solidTopAt(x, z, 0);
  }

  /**
   * Верх самой высокой стоящей на земле коробки, чей контур, расширенный на r,
   * накрывает точку (летающие не считаются). Для спавна и гаджетов.
   */
  solidTopAt(x: number, z: number, r: number): number {
    const list = this.cellList(x, z);
    let top = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const b = this.boxes[list[i]];
      if (b.floating) continue;
      if (b.top > top && x >= b.x0 - r && x <= b.x1 + r && z >= b.z0 - r && z <= b.z1 + r) top = b.top;
    }
    return top;
  }

  /**
   * Опора от летающих платформ под точкой: верх самой высокой, до которой
   * ступни (на высоте y) дотягиваются с запасом reach; −∞ — нет такой.
   */
  supportAt(x: number, z: number, y: number, reach: number): number {
    const list = this.cellList(x, z);
    let top = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const b = this.boxes[list[i]];
      if (!b.floating || b.top <= top || b.top > y + reach) continue;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) top = b.top;
    }
    return top;
  }

  /**
   * Не пускает ли постройка тело (радиус r, ступни на высоте y) в точку (x, z):
   * коробка со стеной выше ступени больше чем на STEP_UP и с низом ниже макушки.
   * Под летающей платформой с высоким низом проходим.
   */
  blocks(x: number, z: number, y: number, r: number): boolean {
    const list = this.cellList(x, z);
    for (let i = 0; i < list.length; i++) {
      const b = this.boxes[list[i]];
      if (b.top <= y + STEP_UP || b.bot >= y + BODY_H) continue;
      if (x >= b.x0 - r && x <= b.x1 + r && z >= b.z0 - r && z <= b.z1 + r) return true;
    }
    return false;
  }

  /** Точка внутри летающей платформы — для зарядов, лучей и линии видимости */
  hitFloating(x: number, y: number, z: number): boolean {
    const list = this.cellList(x, z);
    for (let i = 0; i < list.length; i++) {
      const b = this.boxes[list[i]];
      if (b.floating && y >= b.bot && y <= b.top && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
    }
    return false;
  }
}
