import { TILE, Terrain } from "./terrain";

const UNREACHABLE = 1 << 20;
/** Размер окна поля в клетках (64 * 2 = 128 юнитов), центрировано на цели */
const GRID = 64;
const HALF = GRID >> 1;
/** Если цель на стене — ищем свободные клетки в кольцах до этого радиуса */
const SEED_RADIUS = 4;

/** 8 направлений: ортогональные + диагонали */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Flow field (карта Дейкстры) в скользящем окне GRID x GRID клеток вокруг цели.
 * Один BFS от клетки игрока — и каждый враг знает, в какую сторону идти, с обходом стен.
 * Мир бесконечный, поэтому окно переезжает вместе с игроком; пересчёт — при смене клетки.
 * Враги за пределами окна получают null и идут напрямик.
 */
export class FlowField {
  private dist = new Int32Array(GRID * GRID);
  private queue = new Int32Array(GRID * GRID);
  /** Абсолютная клетка, соответствующая локальной (0, 0) */
  private originX = 0;
  private originZ = 0;
  private lastTx = NaN;
  private lastTz = NaN;

  constructor(private terrain: Terrain) {
    this.dist.fill(UNREACHABLE);
  }

  /** Можно ли стоять в абсолютной клетке (в пределах окна и не стена) */
  private canStep(cx: number, cz: number): boolean {
    const lx = cx - this.originX;
    const lz = cz - this.originZ;
    if (lx < 0 || lz < 0 || lx >= GRID || lz >= GRID) return false;
    return !this.terrain.isWall(cx, cz);
  }

  /** Диагональный шаг разрешён, только если обе ортогональные клетки свободны (не срезаем углы) */
  private canStepFrom(cx: number, cz: number, dx: number, dz: number): boolean {
    if (!this.canStep(cx + dx, cz + dz)) return false;
    if (dx !== 0 && dz !== 0) {
      return this.canStep(cx + dx, cz) && this.canStep(cx, cz + dz);
    }
    return true;
  }

  private index(cx: number, cz: number): number {
    return (cz - this.originZ) * GRID + (cx - this.originX);
  }

  /** Пересчёт поля от мировой позиции цели. Бесплатен, если цель не сменила клетку. */
  recompute(targetWx: number, targetWz: number): void {
    const tx = Terrain.cellOf(targetWx);
    const tz = Terrain.cellOf(targetWz);
    if (tx === this.lastTx && tz === this.lastTz) return;
    this.lastTx = tx;
    this.lastTz = tz;

    this.originX = tx - HALF;
    this.originZ = tz - HALF;
    this.dist.fill(UNREACHABLE);

    const queue = this.queue;
    let head = 0;
    let tail = 0;
    if (this.canStep(tx, tz)) {
      const start = this.index(tx, tz);
      queue[tail++] = start;
      this.dist[start] = 0;
    } else {
      // Цель стоит на стене (игрок на блоке): стартуем от ближайших свободных клеток вокруг —
      // враги собираются у подножия, а не теряют маршрут
      for (let r = 1; r <= SEED_RADIUS && tail === 0; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || !this.canStep(tx + dx, tz + dz)) continue;
            const i = this.index(tx + dx, tz + dz);
            queue[tail++] = i;
            this.dist[i] = 0;
          }
        }
      }
      if (tail === 0) return;
    }

    while (head < tail) {
      const cur = queue[head++];
      const cx = (cur % GRID) + this.originX;
      const cz = ((cur / GRID) | 0) + this.originZ;
      const next = this.dist[cur] + 1;

      for (const [dx, dz] of DIRS) {
        if (!this.canStepFrom(cx, cz, dx, dz)) continue;
        const ni = this.index(cx + dx, cz + dz);
        if (this.dist[ni] <= next) continue;
        this.dist[ni] = next;
        queue[tail++] = ni;
      }
    }
  }

  /** Расстояние до цели для абсолютной клетки или UNREACHABLE, если вне окна */
  private distAt(cx: number, cz: number): number {
    const lx = cx - this.originX;
    const lz = cz - this.originZ;
    if (lx < 0 || lz < 0 || lx >= GRID || lz >= GRID) return UNREACHABLE;
    return this.dist[lz * GRID + lx];
  }

  /**
   * Нормализованное направление движения к цели из мировой точки
   * или null, если цель недостижима / точка вне окна / уже в той же клетке.
   */
  getDirection(wx: number, wz: number): { x: number; z: number } | null {
    const cx = Terrain.cellOf(wx);
    const cz = Terrain.cellOf(wz);
    const d0 = this.distAt(cx, cz);
    if (d0 <= 0 || d0 >= UNREACHABLE) return null;

    // Соседняя клетка с минимальным расстоянием — туда и идём
    let best = d0;
    let bx = 0;
    let bz = 0;
    let found = false;
    for (const [dx, dz] of DIRS) {
      if (!this.canStepFrom(cx, cz, dx, dz)) continue;
      const nd = this.distAt(cx + dx, cz + dz);
      if (nd < best) {
        best = nd;
        bx = cx + dx;
        bz = cz + dz;
        found = true;
      }
    }
    if (!found) return null;

    const tx = (bx + 0.5) * TILE - wx;
    const tz = (bz + 0.5) * TILE - wz;
    const len = Math.hypot(tx, tz);
    if (len < 1e-4) return null;
    return { x: tx / len, z: tz / len };
  }

  /** Достижима ли мировая точка от текущей цели */
  isReachable(wx: number, wz: number): boolean {
    return this.distAt(Terrain.cellOf(wx), Terrain.cellOf(wz)) < UNREACHABLE;
  }
}
