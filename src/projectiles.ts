import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { Enemy } from "./enemy";
import type { HeightFn } from "./player";
import { lookRotation, segmentSegmentDistance } from "./mathUtil";
import { WeaponStats } from "./weapon";

// --- Пуля ---
const BULLET_SPEED = 260; // юнитов/с — почти мгновенно на дистанции боя, но трассер ещё виден
const BULLET_RANGE = 120; // дальше — исчезает
const BULLET_LEN = 1.2; // длина трассера (длиннее, чтобы читался на такой скорости)
const BULLET_THICK = 0.05;
const BULLET_RADIUS = 0.03; // «толщина» для попаданий
const WORLD_STEP = 0.3; // шаг проверки земли и стен вдоль пути за кадр
const BULLET_SLOW = 0.6; // попадание пули замедляет врага до этой доли скорости...
const BULLET_SLOW_TIME = 0.7; // ...на столько секунд (меч и автоматика не замедляют)
const PIERCE_FALLOFF = 0.5; // урон после каждого пробития
const RICOCHET_RANGE = 10; // рикошет ищет врага в этом радиусе от точки удара

interface Bullet {
  mesh: Mesh;
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
 * Пули: маленькие быстрые трассеры. Общий пул для всех оружий (`Weapon`) — кто стреляет, решает оружие,
 * здесь только полёт и попадания. Столкновения проверяются по отрезку пути за кадр
 * (пуля пролетает несколько юнитов за кадр). Перки пуль (крит, пробитие, рикошет, взрыв, вампиризм)
 * читаются из общих `WeaponStats`.
 */
export class ProjectilePool {
  private scene: Scene;
  private bullets: Bullet[] = [];
  private free: Mesh[] = [];
  private material: StandardMaterial;
  /** Общие статы игрока — Game подставляет после создания игрока */
  stats = new WeaponStats();

  constructor(scene: Scene) {
    this.scene = scene;
    this.material = new StandardMaterial("bulletMat", scene);
    this.material.diffuseColor = new Color3(1, 0.85, 0.3);
    this.material.emissiveColor = new Color3(1, 0.75, 0.2);
    this.material.specularColor = Color3.Black();
    this.material.disableLighting = true;
  }

  /** Выпустить пулю из точки at по нормированному направлению dir */
  spawn(at: Vector3, dir: Vector3, damage: number, range = BULLET_RANGE): void {
    let mesh = this.free.pop();
    if (!mesh) {
      mesh = CreateBox("bullet", { width: BULLET_THICK, height: BULLET_THICK, depth: BULLET_LEN }, this.scene);
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.rotationQuaternion = Quaternion.Identity();
    }
    mesh.setEnabled(true);
    mesh.rotationQuaternion!.copyFrom(lookRotation(dir));
    const pos = at.clone();
    mesh.position.copyFrom(pos);
    this.bullets.push({ mesh, pos, dir: dir.clone(), traveled: 0, damage, range, pierced: 0, bounced: false });
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
        this.release(i);
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
          b.mesh.rotationQuaternion!.copyFrom(lookRotation(b.dir));
          b.mesh.position.copyFrom(point);
          continue;
        }
        this.release(i);
        continue;
      }

      b.traveled += step;
      if (b.traveled > b.range) {
        this.release(i);
        continue;
      }
      b.pos = to;
      // Трассер рисуем хвостом назад от текущей точки
      b.mesh.position.copyFrom(to).subtractInPlace(b.dir.scale(BULLET_LEN / 2));
    }
  }

  private release(index: number): void {
    const b = this.bullets[index];
    b.mesh.setEnabled(false);
    this.free.push(b.mesh);
    this.bullets.splice(index, 1);
  }

  /** Убрать все пули */
  clear(): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) this.release(i);
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
