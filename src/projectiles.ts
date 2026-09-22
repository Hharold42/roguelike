import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { Enemy } from "./enemy";
import type { HeightFn } from "./player";
import { lookRotation, segmentSegmentDistance } from "./mathUtil";

// --- Пуля ---
const BULLET_SPEED = 260; // юнитов/с — почти мгновенно на дистанции боя, но трассер ещё виден
const BULLET_RANGE = 120; // дальше — исчезает
const BULLET_LEN = 1.2; // длина трассера (длиннее, чтобы читался на такой скорости)
const BULLET_THICK = 0.05;
const BULLET_RADIUS = 0.03; // «толщина» для попаданий
const WORLD_STEP = 0.3; // шаг проверки земли и стен вдоль пути за кадр

interface Bullet {
  mesh: Mesh;
  pos: Vector3;
  dir: Vector3;
  traveled: number;
  damage: number;
}

export interface WorldQuery {
  getHeight: HeightFn;
  /** Верх стены в точке или null */
  wallTopAt(wx: number, wz: number): number | null;
}

/**
 * Пули: маленькие быстрые трассеры. Общий пул для всех оружий (`Weapon`) — кто стреляет, решает оружие,
 * здесь только полёт и попадания. Столкновения проверяются по отрезку пути за кадр
 * (пуля пролетает несколько юнитов за кадр).
 */
export class ProjectilePool {
  private scene: Scene;
  private bullets: Bullet[] = [];
  private free: Mesh[] = [];
  private material: StandardMaterial;

  constructor(scene: Scene) {
    this.scene = scene;
    this.material = new StandardMaterial("bulletMat", scene);
    this.material.diffuseColor = new Color3(1, 0.85, 0.3);
    this.material.emissiveColor = new Color3(1, 0.75, 0.2);
    this.material.specularColor = Color3.Black();
    this.material.disableLighting = true;
  }

  /** Выпустить пулю из точки at по нормированному направлению dir */
  spawn(at: Vector3, dir: Vector3, damage: number): void {
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
    this.bullets.push({ mesh, pos, dir: dir.clone(), traveled: 0, damage });
  }

  /**
   * Двигает пули, проверяет попадания по отрезку пути за кадр.
   * onHit — каждое попадание по врагу (до урона; молния и т. п.), onKill — каждый убитый.
   */
  update(
    dt: number,
    enemies: Enemy[],
    world: WorldQuery,
    onKill: (enemy: Enemy) => void,
    onHit?: (enemy: Enemy, damage: number, point: Vector3) => void,
  ): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const step = BULLET_SPEED * dt;
      const from = b.pos;
      const to = from.add(b.dir.scale(step));

      // Ближайшее событие на отрезке: s ∈ [0,1]
      let hitS = Infinity;
      let hitEnemy: Enemy | null = null;

      // Враги: отрезок пути против оси капсулы
      const mid = from.add(to).scaleInPlace(0.5);
      const reach = step * 0.5 + 2.5;
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const c = enemy.node.position;
        if (Vector3.DistanceSquared(c, mid) > reach * reach) continue;
        const h = enemy.hitHalfAxis;
        const { dist, s } = segmentSegmentDistance(
          from,
          to,
          new Vector3(c.x, c.y - h, c.z),
          new Vector3(c.x, c.y + h, c.z),
        );
        if (dist <= enemy.hitRadius + BULLET_RADIUS && s < hitS) {
          hitS = s;
          hitEnemy = enemy;
        }
      }

      // Земля и стены: сэмплы вдоль пути
      const samples = Math.max(1, Math.ceil(step / WORLD_STEP));
      for (let k = 1; k <= samples; k++) {
        const s = k / samples;
        if (s >= hitS) break;
        const x = from.x + (to.x - from.x) * s;
        const y = from.y + (to.y - from.y) * s;
        const z = from.z + (to.z - from.z) * s;
        const top = world.wallTopAt(x, z);
        if (y <= world.getHeight(x, z) || (top !== null && y <= top)) {
          hitS = s;
          hitEnemy = null;
          break;
        }
      }

      if (hitS <= 1) {
        if (hitEnemy) {
          onHit?.(hitEnemy, b.damage, Vector3.Lerp(from, to, hitS));
          if (hitEnemy.alive && hitEnemy.takeDamage(b.damage)) onKill(hitEnemy);
        }
        this.release(i);
        continue;
      }

      b.traveled += step;
      if (b.traveled > BULLET_RANGE) {
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
