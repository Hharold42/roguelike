import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { CreatePolyhedron } from "@babylonjs/core/Meshes/Builders/polyhedronBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { HeightFn } from "./player";
const COIN_SIZE = 0.16;
const MAX_COINS_PER_DROP = 5; // крупная сумма падает несколькими монетами, но не сотней
const GRAVITY = 22;
const POP_SPEED = 5.5; // подброс при выпадении
const BOUNCE = 0.35;
const MAGNET_DIST = 4.5; // ближе этого монета летит к игроку
const MAGNET_ACCEL = 40;
const MAGNET_MAX = 18;
const PICK_DIST = 0.75;
const LIFETIME = 25; // с, потом исчезает
const SPIN = 3.2; // рад/с

interface Coin {
  mesh: InstancedMesh;
  pos: Vector3;
  vel: Vector3;
  value: number;
  age: number;
  /** Летит к игроку */
  magnet: boolean;
  floor: number;
}

/**
 * Золото: монеты-инстансы одного октаэдра. Выпадают из врага, подпрыгивают, ложатся на землю,
 * рядом с игроком притягиваются и подбираются. Один draw call на все монеты.
 */
export class GoldPool {
  private source: Mesh;
  private coins: Coin[] = [];
  private free: InstancedMesh[] = [];

  constructor(scene: Scene) {
    const mat = new StandardMaterial("goldMat", scene);
    mat.diffuseColor = new Color3(1, 0.8, 0.2);
    mat.emissiveColor = new Color3(0.9, 0.62, 0.1);
    mat.specularColor = new Color3(1, 1, 0.8);
    this.source = CreatePolyhedron("gold", { type: 1, size: COIN_SIZE }, scene);
    this.source.material = mat;
    this.source.isVisible = false;
    this.source.isPickable = false;
    this.source.metadata = { gold: true }; // GlowLayer подсвечивает
    this.source.registerInstancedBuffer(VertexBuffer.ColorKind, 4);
    this.source.instancedBuffers[VertexBuffer.ColorKind] = new Color4(1, 1, 1, 1);
  }

  /** Меш-источник для теней (инстансы рисуются вместе с ним) */
  get shadowCaster(): Mesh {
    return this.source;
  }

  /** Выпадение amount золота в точке (центр врага) */
  spawn(at: Vector3, amount: number, floor: number): void {
    if (amount <= 0) return;
    const n = Math.min(MAX_COINS_PER_DROP, amount);
    const base = Math.floor(amount / n);
    let rest = amount - base * n;
    for (let i = 0; i < n; i++) {
      const value = base + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
      let mesh = this.free.pop();
      if (!mesh) {
        mesh = this.source.createInstance("goldCoin");
        mesh.isPickable = false;
      }
      mesh.setEnabled(true);
      // Крупная монета — чуть больше и ярче
      const s = 1 + 0.25 * Math.min(3, value - 1);
      mesh.scaling.setAll(s);
      mesh.instancedBuffers[VertexBuffer.ColorKind] = value > 1 ? new Color4(1, 0.95, 0.6, 1) : new Color4(1, 0.85, 0.35, 1);
      const a = Math.random() * Math.PI * 2;
      const h = 1.5 + Math.random() * 2;
      const pos = at.clone();
      pos.y += 0.2;
      this.coins.push({
        mesh,
        pos,
        vel: new Vector3(Math.cos(a) * h, POP_SPEED * (0.8 + Math.random() * 0.5), Math.sin(a) * h),
        value,
        age: 0,
        magnet: false,
        floor,
      });
    }
  }

  /** Физика и подбор. Возвращает собранное за кадр золото. */
  update(dt: number, playerPos: Vector3, getFloor: HeightFn): number {
    let collected = 0;
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      c.age += dt;
      const dx = playerPos.x - c.pos.x;
      const dy = playerPos.y - 0.3 - c.pos.y; // к поясу
      const dz = playerPos.z - c.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (!c.magnet && d2 < MAGNET_DIST * MAGNET_DIST) c.magnet = true;

      if (c.magnet) {
        const d = Math.sqrt(d2) || 1e-3;
        if (d < PICK_DIST) {
          collected += c.value;
          this.release(i);
          continue;
        }
        // Разгон к игроку, старую скорость гасим
        c.vel.scaleInPlace(Math.max(0, 1 - dt * 6));
        c.vel.addInPlace(new Vector3(dx / d, dy / d, dz / d).scaleInPlace(MAGNET_ACCEL * dt));
        const v = c.vel.length();
        if (v > MAGNET_MAX) c.vel.scaleInPlace(MAGNET_MAX / v);
        c.pos.addInPlace(c.vel.scale(dt));
      } else {
        c.vel.y -= GRAVITY * dt;
        c.pos.addInPlace(c.vel.scale(dt));
        const floor = getFloor(c.pos.x, c.pos.z) + COIN_SIZE;
        if (c.pos.y < floor) {
          c.pos.y = floor;
          if (c.vel.y < -1) {
            c.vel.y = -c.vel.y * BOUNCE;
            c.vel.x *= 0.6;
            c.vel.z *= 0.6;
          } else {
            c.vel.set(0, 0, 0);
          }
        }
        if (c.age > LIFETIME) {
          this.release(i);
          continue;
        }
      }
      c.mesh.position.copyFrom(c.pos);
      c.mesh.rotation.y += SPIN * dt;
      // Лежащая монета чуть подпрыгивает-«дышит», чтобы читалась
      if (!c.magnet && c.vel.lengthSquared() < 1e-4) c.mesh.position.y += 0.04 * Math.sin(c.age * 4 + c.mesh.uniqueId);
    }
    return collected;
  }

  private release(i: number): void {
    const c = this.coins[i];
    c.mesh.setEnabled(false);
    this.free.push(c.mesh);
    this.coins.splice(i, 1);
  }
}
