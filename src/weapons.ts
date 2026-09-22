import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { buildGunMesh, GUN_MUZZLE_LOCAL } from "./characterModel";
import type { Enemy } from "./enemy";
import { lookRotation } from "./mathUtil";
import type { Player } from "./player";
import type { ProjectilePool } from "./projectiles";
import { Gun } from "./weapon";

/** Улучшения оружия за золото — покупаются по порядку */
export interface WeaponTier {
  id: "drone" | "lightning" | "radiance";
  title: string;
  desc: string;
  cost: number;
}

export const WEAPON_TIERS: readonly WeaponTier[] = [
  { id: "drone", title: "Летающий пистолет", desc: "Сам стреляет 2 раза в секунду в ближайшего врага", cost: 100 },
  { id: "lightning", title: "Молния", desc: "30% попаданий любого оружия бьют молнией ещё по двум ближайшим врагам", cost: 500 },
  { id: "radiance", title: "Radiance", desc: "Враги рядом горят, а их удары с шансом 30% почти не наносят урона", cost: 1000 },
];

// --- Летающий пистолет ---
const DRONE_COOLDOWN = 0.5; // с между выстрелами (2/с) до бафов скорострельности
const DRONE_RANGE = 28;
const DRONE_OFFSET = new Vector3(-0.9, 1.1, -0.2); // слева над плечом (в системе игрока: +X вправо, +Z вперёд)
const DRONE_FOLLOW = 9; // 1/с
const DRONE_TURN = 12;

// --- Молния ---
const LIGHTNING_CHANCE = 0.3;
const LIGHTNING_JUMPS = 2;
const LIGHTNING_RANGE = 8; // от поражённого врага
const LIGHTNING_DAMAGE_MULT = 1; // доля урона пули
const BOLT_LIFE = 0.18; // с, визуал
const BOLT_SEGMENTS = 7;
const BOLT_JAG = 0.35;

// --- Radiance ---
const RADIANCE_RADIUS = 6;
const RADIANCE_TICK = 0.5; // с
const RADIANCE_DAMAGE_MULT = 0.5; // доля урона игрока за тик (минимум 1)
const RADIANCE_MISS_CHANCE = 0.3;
const RADIANCE_MISS_MULT = 0.1; // урон врага при промахе

interface Bolt {
  mesh: LinesMesh;
  life: number;
}

/**
 * Купленные улучшения оружия и их логика: летающий пистолет, молния по попаданиям, аура Radiance.
 * Урон врагам наносит через переданные колбэки, чтобы золото и статистика считались в одном месте.
 */
export class WeaponSystem {
  /** Сколько уровней куплено (0..3) */
  tier = 0;

  private drone: TransformNode | null = null;
  private droneMeshes: Mesh[] = [];
  /** Оружие дрона: общие stats с ручным пистолетом (урон, мультивыстрел, скорострельность), свой кулдаун */
  private droneGun: Gun | null = null;
  private droneTime = 0;

  private bolts: Bolt[] = [];
  private freeBolts: LinesMesh[] = [];

  private aura: Mesh | null = null;
  private auraMat: StandardMaterial | null = null;
  private radianceTimer = 0;
  private time = 0;

  constructor(
    private scene: Scene,
    private projectiles: ProjectilePool,
    private onKill: (enemy: Enemy) => void,
  ) {}

  /** Следующее доступное к покупке улучшение или null, если всё куплено */
  get next(): WeaponTier | null {
    return WEAPON_TIERS[this.tier] ?? null;
  }

  has(id: WeaponTier["id"]): boolean {
    return WEAPON_TIERS.findIndex((t) => t.id === id) < this.tier;
  }

  /** Купить следующее улучшение, если хватает золота. Возвращает купленное или null. */
  buy(player: Player): WeaponTier | null {
    const t = this.next;
    if (!t || player.gold < t.cost) return null;
    player.gold -= t.cost;
    this.tier++;
    if (t.id === "drone") this.createDrone(player);
    if (t.id === "radiance") this.createAura();
    return t;
  }

  /** Меши для теней (появляются при покупке) */
  get shadowCasters(): Mesh[] {
    return this.droneMeshes;
  }

  update(dt: number, player: Player, enemies: Enemy[]): void {
    this.time += dt;
    if (this.drone) this.updateDrone(dt, player, enemies);
    if (this.aura) this.updateRadiance(dt, player, enemies);
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      b.mesh.alpha = Math.max(0, b.life / BOLT_LIFE);
      if (b.life <= 0) {
        b.mesh.setEnabled(false);
        this.freeBolts.push(b.mesh);
        this.bolts.splice(i, 1);
      }
    }
  }

  /** Попадание любым оружием (пуля, взмах меча) по врагу: с шансом — молния на двух ближайших */
  onWeaponHit(target: Enemy, damage: number, point: Vector3, enemies: Enemy[]): void {
    if (!this.has("lightning") || Math.random() >= LIGHTNING_CHANCE) return;
    const from = target.node.position;
    const near = enemies
      .filter((e) => e.alive && e !== target && Vector3.DistanceSquared(e.node.position, from) <= LIGHTNING_RANGE * LIGHTNING_RANGE)
      .sort((a, b) => Vector3.DistanceSquared(a.node.position, from) - Vector3.DistanceSquared(b.node.position, from))
      .slice(0, LIGHTNING_JUMPS);
    let prev = point;
    for (const e of near) {
      const to = e.node.position.clone();
      this.spawnBolt(prev, to);
      if (e.takeDamage(Math.max(1, Math.round(damage * LIGHTNING_DAMAGE_MULT)))) this.onKill(e);
      prev = to;
    }
  }

  /** Урон, который враг наносит игроку, с учётом Radiance (промах — 10 %) */
  incomingDamage(enemy: Enemy, damage: number, player: Player): number {
    if (!this.aura) return damage;
    const d2 = Vector3.DistanceSquared(enemy.node.position, player.position);
    if (d2 <= RADIANCE_RADIUS * RADIANCE_RADIUS && Math.random() < RADIANCE_MISS_CHANCE) return damage * RADIANCE_MISS_MULT;
    return damage;
  }

  // ---------- Летающий пистолет ----------

  private createDrone(player: Player): void {
    const gun = buildGunMesh(this.scene, "drone", new Color3(0.35, 0.85, 1));
    gun.root.scaling.setAll(1.3); // чуть крупнее ручного — чтобы читался в воздухе
    this.drone = gun.root;
    this.droneMeshes = gun.meshes;
    // Автоматика не греется: разброс остаётся минимальным
    this.droneGun = new Gun(this.projectiles, player.weaponStats, { baseCooldown: DRONE_COOLDOWN, heat: false });
  }

  private updateDrone(dt: number, player: Player, enemies: Enemy[]): void {
    const drone = this.drone!;
    const gun = this.droneGun!;
    this.droneTime += dt;
    gun.update(dt);
    // Позиция: слева над плечом игрока, парит
    const yaw = player.mesh.rotation.y;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const ox = DRONE_OFFSET.x * cy + DRONE_OFFSET.z * sy;
    const oz = -DRONE_OFFSET.x * sy + DRONE_OFFSET.z * cy;
    const want = new Vector3(
      player.position.x + ox,
      player.position.y + DRONE_OFFSET.y + 0.08 * Math.sin(this.droneTime * 2.3),
      player.position.z + oz,
    );
    if (Vector3.DistanceSquared(drone.position, want) > 25) drone.position.copyFrom(want);
    else drone.position.addInPlace(want.subtract(drone.position).scaleInPlace(Math.min(1, dt * DRONE_FOLLOW)));

    // Цель — ближайший живой враг в радиусе
    let target: Enemy | null = null;
    let best = DRONE_RANGE * DRONE_RANGE;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d2 = Vector3.DistanceSquared(e.node.position, drone.position);
      if (d2 < best) {
        best = d2;
        target = e;
      }
    }
    // Поворот: на цель, иначе — куда смотрит игрок
    const dir = target ? target.node.position.subtract(drone.position) : new Vector3(sy, 0, cy);
    if (dir.lengthSquared() > 1e-6) {
      const wantRot = lookRotation(dir.normalize(), Vector3.Up());
      Quaternion.SlerpToRef(drone.rotationQuaternion!, wantRot, Math.min(1, dt * DRONE_TURN), drone.rotationQuaternion!);
    }

    if (target && gun.ready) {
      drone.computeWorldMatrix(true);
      const muzzle = Vector3.TransformCoordinates(GUN_MUZZLE_LOCAL, drone.getWorldMatrix());
      gun.tryFire(muzzle, target.node.position);
    }
  }

  // ---------- Молния ----------

  private spawnBolt(from: Vector3, to: Vector3): void {
    const points: Vector3[] = [];
    const dir = to.subtract(from);
    const len = dir.length();
    const side = Vector3.Cross(dir, Vector3.Up()).normalize();
    if (side.lengthSquared() < 1e-6) side.set(1, 0, 0);
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const t = i / BOLT_SEGMENTS;
      const p = Vector3.Lerp(from, to, t);
      if (i > 0 && i < BOLT_SEGMENTS) {
        const j = (Math.random() * 2 - 1) * BOLT_JAG * Math.min(1, len / 4);
        p.addInPlace(side.scale(j));
        p.y += (Math.random() * 2 - 1) * BOLT_JAG * 0.6;
      }
      points.push(p);
    }
    let mesh = this.freeBolts.pop();
    if (mesh) {
      mesh = CreateLines("bolt", { points, instance: mesh });
      mesh.setEnabled(true);
    } else {
      mesh = CreateLines("bolt", { points, updatable: true }, this.scene);
      mesh.color = new Color3(0.6, 0.9, 1);
      mesh.isPickable = false;
    }
    mesh.alpha = 1;
    this.bolts.push({ mesh, life: BOLT_LIFE });
  }

  // ---------- Radiance ----------

  private createAura(): void {
    const glowMat = (name: string, alpha: number) => {
      const mat = new StandardMaterial(name, this.scene);
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.emissiveColor = new Color3(1, 0.45, 0.12);
      mat.alpha = alpha;
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      return mat;
    };
    // Едва заметная заливка + яркое кольцо по границе радиуса
    const fill = CreateDisc("radiance", { radius: RADIANCE_RADIUS, tessellation: 48 }, this.scene);
    fill.rotation.x = Math.PI / 2;
    fill.material = glowMat("radianceFillMat", 0.07);
    const ring = CreateTorus("radianceRing", { diameter: RADIANCE_RADIUS * 2, thickness: 0.12, tessellation: 64 }, this.scene);
    ring.material = glowMat("radianceRingMat", 0.6);
    ring.metadata = { gold: true }; // тёплое свечение через GlowLayer
    ring.parent = fill;
    ring.rotation.x = -Math.PI / 2;
    ring.position.z = -0.02;
    for (const m of [fill, ring]) {
      m.isPickable = false;
      m.receiveShadows = false;
    }
    this.aura = fill;
    this.auraMat = ring.material as StandardMaterial;
  }

  private updateRadiance(dt: number, player: Player, enemies: Enemy[]): void {
    const aura = this.aura!;
    aura.position.set(player.position.x, player.position.y - 1 + 0.08, player.position.z);
    this.auraMat!.alpha = 0.5 + 0.15 * Math.sin(this.time * 3);

    this.radianceTimer -= dt;
    if (this.radianceTimer > 0) return;
    this.radianceTimer = RADIANCE_TICK;
    const dmg = Math.max(1, Math.round(player.weaponStats.damage * RADIANCE_DAMAGE_MULT));
    const r2 = RADIANCE_RADIUS * RADIANCE_RADIUS;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.node.position.x - player.position.x;
      const dz = e.node.position.z - player.position.z;
      if (dx * dx + dz * dz > r2) continue;
      if (e.takeDamage(dmg)) this.onKill(e);
    }
  }
}
