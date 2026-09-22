import type { Enemy } from "./enemy";

/** Проверка «точка внутри стены» */
export type BlockedFn = (x: number, z: number) => boolean;

const MIN_DIST = 1.0; // враги держатся не ближе этого друг к другу (они в 3/4 роста игрока)
const CELL = MIN_DIST; // ячейка сетки = радиус поиска, соседей ищем в 3x3 ячейках
const PLAYER_RADIUS = 0.5;

/** Ключ ячейки сетки: два 16-битных знаковых индекса */
function cellKey(cx: number, cz: number): number {
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

/**
 * Мягкое расталкивание толпы за O(N): пространственная сетка вместо перебора всех пар.
 * Позиции меняются напрямую (без moveWithCollisions); в стену врага не вталкиваем.
 * Игрок — твёрдый круг: врагов из него выталкивает, сам не двигается.
 */
export class CrowdSeparator {
  private grid = new Map<number, Enemy[]>();

  separate(enemies: Enemy[], playerX: number, playerZ: number, blocked: BlockedFn): void {
    const grid = this.grid;
    grid.clear();
    for (const e of enemies) {
      if (!e.alive) continue;
      const key = cellKey(Math.floor(e.node.position.x / CELL), Math.floor(e.node.position.z / CELL));
      const bucket = grid.get(key);
      if (bucket) bucket.push(e);
      else grid.set(key, [e]);
    }

    for (const e of enemies) {
      if (!e.alive) continue;
      const p = e.node.position;
      const cx = Math.floor(p.x / CELL);
      const cz = Math.floor(p.z / CELL);
      let pushX = 0;
      let pushZ = 0;

      // Соседи в 3x3 ячейках; каждую пару считаем один раз (по id)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = grid.get(cellKey(cx + dx, cz + dz));
          if (!bucket) continue;
          for (const o of bucket) {
            if (o === e) continue;
            const ox = p.x - o.node.position.x;
            const oz = p.z - o.node.position.z;
            const d2 = ox * ox + oz * oz;
            if (d2 >= MIN_DIST * MIN_DIST) continue;
            if (d2 < 1e-6) {
              // Совпали точно — разводим детерминированно по id, чтобы не дрожали
              pushX += e.id > o.id ? 0.05 : -0.05;
              continue;
            }
            const d = Math.sqrt(d2);
            const k = ((MIN_DIST - d) * 0.5) / d; // каждый сдвигается на половину перекрытия
            pushX += ox * k;
            pushZ += oz * k;
          }
        }
      }

      // Игрок — твёрдый: враг не заходит в его круг
      const px = p.x - playerX;
      const pz = p.z - playerZ;
      const minP = PLAYER_RADIUS + e.hitRadius;
      const dp2 = px * px + pz * pz;
      if (dp2 < minP * minP && dp2 > 1e-6) {
        const d = Math.sqrt(dp2);
        const k = (minP - d) / d;
        pushX += px * k;
        pushZ += pz * k;
      }

      if (pushX === 0 && pushZ === 0) continue;
      const nx = p.x + pushX;
      const nz = p.z + pushZ;
      if (!blocked(nx, nz)) {
        p.x = nx;
        p.z = nz;
      } else if (!blocked(nx, p.z)) {
        p.x = nx;
      } else if (!blocked(p.x, nz)) {
        p.z = nz;
      }
    }
  }
}
