import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Enemy } from "./enemy";
import type { HeightFn } from "./player";
import { segmentSegmentDistance } from "./mathUtil";
import { WeaponStats } from "./weapon";

// --- Пуля ---
const BULLET_SPEED = 260; // юнитов/с — почти мгновенно на дистанции боя, но трассер ещё виден
const BULLET_RANGE = 120; // дальше — исчезает
const BULLET_RADIUS = 0.03; // «толщина» для попаданий
const WORLD_STEP = 0.3; // шаг проверки земли и стен вдоль пути за кадр
const BULLET_SLOW = 0.6; // попадание пули замедляет врага до этой доли скорости...
const BULLET_SLOW_TIME = 0.7; // ...на столько секунд (меч и автоматика не замедляют)
const PIERCE_FALLOFF = 0.5; // урон после каждого пробития
const RICOCHET_RANGE = 10; // рикошет ищет врага в этом радиусе от точки удара

export interface Bullet {
  pos: Vector3;
  dir: Vector3;
  traveled: number;
  damage: number;
  range: number;
  /** Сколько врагов уже пробито */
  pierced: number;
  /** Рикошет уже был */
  bounced: boolean;
}

export interface WorldQuery {
  getHeight: HeightFn;
  /** Верх стены в точке или null */
  wallTopAt(wx: number, wz: number): number | null;
}

export interface BulletHooks {
  onKill: (enemy: Enemy) => void;
  /** Каждое попадание по врагу (до урона; молния и т. п.) */
  onHit?: (enemy: Enemy, damage: number, point: Vector3) => void;
  /** Взрыв пули (перк): точка, радиус, урон — визуал и урон по области делает Game */
  onBlast?: (point: Vector3, radius: number, damage: number) => void;
  /** Лечение игрока (вампирские пули) */
  onHeal?: (amount: number) => void;
}

/**
 * Пули: маленькие быстрые трассеры — чистые данные, рисует их софтверный рендер
 * короткими светящимися линиями. Общий пул для всех оружий (`Weapon`) — кто стреляет,
 * решает оружие, здесь только полёт и попадания. Столкновения проверяются по отрезку
 * пути за кадр. Перки пуль (крит, пробитие, рикошет, взрыв, вампиризм) читаются из
 * общих `WeaponStats`.
 */
export class ProjectilePool {
  /** Пули в полёте — рендер читает напрямую */
  readonly bullets: Bullet[] = [];
  /** Общие статы игрока — Game подставляет после создания игрока */
  stats = new WeaponStats();

  /** Выпустить пулю из точки at по нормированному направлению dir */
  spawn(at: Vector3, dir: Vector3, damage: number, range = BULLET_RANGE): void {
    this.bullets.push({ pos: at.clone(), dir: dir.clone(), traveled: 0, damage, range, pierced: 0, bounced: false });
  }

  /** Сколько пуль в полёте */
  get count(): number {
    return this.bullets.length;
  }

  /** Двигает пули, проверяет попадания по отрезку пути за кадр. */
  update(dt: number, enemies: Enemy[], world: WorldQuery, hooks: BulletHooks): void {
    const st = this.stats;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const step = BULLET_SPEED * dt;
      const from = b.pos;
      const to = from.add(b.dir.scale(step));

      // Земля и стены: первый сэмпл вдоль пути, где пуля ниже поверхности
      let worldS = Infinity;
      const samples = Math.max(1, Math.ceil(step / WORLD_STEP));
      for (let k = 1; k <= samples; k++) {
        const s = k / samples;
        const x = from.x + (to.x - from.x) * s;
        const y = from.y + (to.y - from.y) * s;
        const z = from.z + (to.z - from.z) * s;
        const top = world.wallTopAt(x, z);
        if (y <= world.getHeight(x, z) || (top !== null && y <= top)) {
          worldS = s;
          break;
        }
      }

      // Враги на отрезке до точки удара о мир, по порядку
      const hits: { enemy: Enemy; s: number }[] = [];
      const mid = from.add(to).scaleInPlace(0.5);
      const reach = step * 0.5 + 2.5;
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const c = enemy.node.position;
        if (Vector3.DistanceSquared(c, mid) > reach * reach) continue;
        const h = enemy.hitHalfAxis;
        const { dist, s } = segmentSegmentDistance(from, to, new Vector3(c.x, c.y - h, c.z), new Vector3(c.x, c.y + h, c.z));
        if (dist <= enemy.hitRadius + BULLET_RADIUS && s < worldS) hits.push({ enemy, s });
      }
      hits.sort((a, c) => a.s - c.s);

      let done = false;
      for (const { enemy, s } of hits) {
        if (!enemy.alive) continue;
        const point = Vector3.Lerp(from, to, s);
        const [dmg] = st.roll(Math.max(1, Math.round(b.damage * Math.pow(PIERCE_FALLOFF, b.pierced))));
        hooks.onHit?.(enemy, dmg, point);
        if (enemy.alive) {
          enemy.applySlow(BULLET_SLOW, BULLET_SLOW_TIME);
          if (enemy.takeDamage(dmg)) hooks.onKill(enemy);
        }
        if (st.bulletLifesteal > 0) hooks.onHeal?.(dmg * st.bulletLifesteal);
        if (st.bulletBlast > 0) {
          hooks.onBlast?.(point, st.bulletBlast, dmg);
          done = true; // взрывная пуля кончается на первом попадании
          break;
        }
        if (b.pierced >= st.pierce) {
          done = true;
          break;
        }
        b.pierced++;
      }
      if (done) {
        this.bullets.splice(i, 1);
        continue;
      }

      if (worldS <= 1) {
        const point = Vector3.Lerp(from, to, worldS);
        if (st.bulletBlast > 0) hooks.onBlast?.(point, st.bulletBlast, b.damage);
        // Рикошет: один раз отскакиваем от мира в ближайшего врага
        const target = st.ricochet && !b.bounced && st.bulletBlast <= 0 ? nearestEnemy(enemies, point, RICOCHET_RANGE) : null;
        if (target) {
          b.bounced = true;
          b.pos = point;
          b.dir = target.node.position.subtract(point).normalize();
          continue;
        }
        this.bullets.splice(i, 1);
        continue;
      }

      b.traveled += step;
      if (b.traveled > b.range) {
        this.bullets.splice(i, 1);
        continue;
      }
      b.pos = to;
    }
  }

  /** Убрать все пули */
  clear(): void {
    this.bullets.length = 0;
  }
}

function nearestEnemy(enemies: Enemy[], from: Vector3, range: number): Enemy | null {
  let best: Enemy | null = null;
  let bestD = range * range;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = Vector3.DistanceSquared(e.node.position, from);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}
