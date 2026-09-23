import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { buildGunMesh, GUN_MUZZLE_LOCAL } from "./characterModel";
import { gunTemplate } from "./weaponModel";
import type { Enemy } from "./enemy";
import { lookRotation } from "./mathUtil";
import type { Player } from "./player";
import type { ProjectilePool } from "./projectiles";
import { Gun, GUN_PRESETS } from "./weapon";
import { BlastFx, Boomerang, Mortar, OrbitBlades, type AutoHooks } from "./autoWeapons";

/** Оружия колеса/магазина + результаты крафта (saw — Пила) */
export type WeaponId = "drone" | "boomerang" | "blades" | "mortar" | "lightning" | "radiance" | "saw";

/** Оружие, выпадающее с колеса фортуны. weight — относительный шанс среди призов, price — в магазине */
export interface WeaponDef {
  id: WeaponId;
  title: string;
  desc: string;
  weight: number;
  price: number;
}

export const WEAPONS: readonly WeaponDef[] = [
  { id: "drone", title: "Летающий пистолет", desc: "Сам стреляет 2 раза в секунду в ближайшего врага. Все бафы пистолета", weight: 10, price: 400 },
  { id: "boomerang", title: "Бумеранг", desc: "Летит сквозь врагов к ближайшему и возвращается, урон ×2 за касание. Мультивыстрел — веер бумерангов", weight: 8, price: 350 },
  { id: "blades", title: "Орбитальные клинки", desc: "Два клинка кружат вокруг и режут всех рядом (урон ×1.5). Мультивыстрел добавляет клинки, скорострельность крутит быстрее", weight: 8, price: 350 },
  { id: "mortar", title: "Мортира", desc: "Раз в 2.4 с навесом бьёт по самой плотной толпе: взрыв радиусом 3, урон ×4. Мультивыстрел — больше снарядов", weight: 7, price: 450 },
  { id: "lightning", title: "Молния", desc: "30% попаданий любого оружия бьют молнией ещё по двум ближайшим врагам", weight: 5, price: 600 },
  { id: "radiance", title: "Radiance", desc: "Враги рядом горят, а их удары с шансом 30% почти не наносят урона", weight: 3, price: 900 },
];

/** Названия оружий, которых нет на колесе (крафт) */
const CRAFT_TITLES: Partial<Record<WeaponId, string>> = { saw: "Пила" };

export function weaponTitle(id: WeaponId): string {
  return WEAPONS.find((w) => w.id === id)?.title ?? CRAFT_TITLES[id] ?? id;
}

// --- Летающий пистолет ---
const DRONE_COOLDOWN = 0.5; // с между выстрелами (2/с) до бафов скорострельности
const DRONE_RANGE = 28;
const DRONE_OFFSET = new Vector3(-0.9, 1.1, -0.2); // слева над плечом (в системе игрока: +X вправо, +Z вперёд)
const DRONE_FOLLOW = 9; // 1/с
const DRONE_TURN = 12;
// Рой (крафт): три дрона поменьше
const SWARM_COUNT = 3;
const SWARM_DAMAGE_MULT = 0.6;
const SWARM_OFFSETS = [new Vector3(-0.9, 1.1, -0.2), new Vector3(0.9, 1.2, -0.3), new Vector3(0, 1.6, -0.8)];

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
// Ядро (крафт)
const CORE_RADIUS = 9;
const CORE_MISS_CHANCE = 0.5;

interface Bolt {
  mesh: LinesMesh;
  life: number;
}

interface Drone {
  root: TransformNode;
  meshes: AbstractMesh[];
  muzzle: Vector3;
  gun: Gun;
  offset: Vector3;
  phase: number;
}

/**
 * Выигранные оружия и их логика: летающий пистолет, бумеранг, клинки, мортира, молния по попаданиям,
 * аура Radiance. Урон врагам наносит через переданные колбэки, чтобы золото и статистика считались в одном месте.
 * Крафт превращает оружия в улучшенные версии (Рой, Пила, Ядро, Ионная пушка) — те же объекты с другими параметрами.
 */
export class WeaponSystem {
  /** Что уже выиграно (порядок — порядок получения) */
  readonly owned: WeaponId[] = [];
  /** Переименования после крафта (Рой, Ядро, …) */
  private titles = new Map<WeaponId, string>();

  private boomerang: Boomerang | null = null;
  private blades: OrbitBlades | null = null;
  private mortar: Mortar | null = null;
  private fx: BlastFx;
  /** Враги последнего кадра — для молнии из автоматических оружий */
  private enemies: Enemy[] = [];

  private drones: Drone[] = [];
  private droneTime = 0;

  private bolts: Bolt[] = [];
  private freeBolts: LinesMesh[] = [];

  private aura: Mesh | null = null;
  private auraMat: StandardMaterial | null = null;
  private radianceTimer = 0;
  private radianceRadius = RADIANCE_RADIUS;
  private radianceMiss = RADIANCE_MISS_CHANCE;
  private time = 0;

  constructor(
    private scene: Scene,
    private projectiles: ProjectilePool,
    private onKill: (enemy: Enemy) => void,
    private floorAt: (x: number, z: number) => number,
  ) {
    this.fx = new BlastFx(scene);
  }

  has(id: WeaponId): boolean {
    return this.owned.includes(id);
  }

  /** Оружия, которых ещё нет — они и лежат на колесе / в магазине */
  get available(): WeaponDef[] {
    return WEAPONS.filter((w) => !this.has(w.id));
  }

  /** Названия выигранных оружий по порядку (с учётом крафта) */
  get ownedTitles(): string[] {
    return this.owned.map((id) => this.titles.get(id) ?? weaponTitle(id));
  }

  /** Цена продажи (половина магазинной) */
  sellPrice(id: WeaponId): number {
    const def = WEAPONS.find((w) => w.id === id);
    return Math.round((def?.price ?? 600) / 2);
  }

  private hooks(): AutoHooks {
    return {
      onHit: (e, dmg, point) => this.onWeaponHit(e, dmg, point, this.enemies),
      onKill: this.onKill,
      floorAt: this.floorAt,
    };
  }

  /** Выдать оружие (приз с колеса / покупка). Повторно — ничего не делает. */
  grant(id: WeaponId, player: Player): boolean {
    if (this.has(id)) return false;
    this.owned.push(id);
    switch (id) {
      case "drone":
        this.createDrones(player, 1);
        break;
      case "boomerang":
        this.boomerang = new Boomerang(this.scene, player.weaponStats, this.hooks());
        break;
      case "blades":
        this.blades = new OrbitBlades(this.scene, player.weaponStats, this.hooks());
        break;
      case "mortar":
        this.mortar = new Mortar(this.scene, player.weaponStats, this.hooks(), this.fx);
        break;
      case "radiance":
        this.createAura();
        break;
      case "saw":
        this.blades = new OrbitBlades(this.scene, player.weaponStats, this.hooks(), { baseCount: 4, radius: 4 });
        this.boomerang = new Boomerang(this.scene, player.weaponStats, this.hooks(), { color: new Color3(0.45, 0.85, 1), cooldownMult: 1.4 });
        break;
      case "lightning":
        break;
    }
    return true;
  }

  /** Забрать оружие (продажа, перековка, ингредиент крафта): меши убираются */
  revoke(id: WeaponId): boolean {
    const i = this.owned.indexOf(id);
    if (i < 0) return false;
    this.owned.splice(i, 1);
    this.titles.delete(id);
    switch (id) {
      case "drone":
        this.disposeDrones();
        break;
      case "boomerang":
        this.boomerang?.dispose();
        this.boomerang = null;
        break;
      case "blades":
        this.blades?.dispose();
        this.blades = null;
        break;
      case "saw":
        this.blades?.dispose();
        this.blades = null;
        this.boomerang?.dispose();
        this.boomerang = null;
        break;
      case "mortar":
        this.mortar?.dispose();
        this.mortar = null;
        break;
      case "radiance":
        this.aura?.dispose(false, true);
        this.aura = null;
        this.auraMat = null;
        this.radianceRadius = RADIANCE_RADIUS;
        this.radianceMiss = RADIANCE_MISS_CHANCE;
        break;
      case "lightning":
        break;
    }
    return true;
  }

  // ---------- Крафт ----------

  /** Рой: летающий пистолет → три дрона с уроном ×0.6 */
  makeSwarm(player: Player): void {
    if (!this.has("drone")) return;
    this.disposeDrones();
    this.createDrones(player, SWARM_COUNT);
    this.titles.set("drone", "Рой");
  }

  /** Ядро: Radiance радиусом 9, промах врагов 50 % */
  makeCore(): void {
    if (!this.aura) return;
    this.radianceRadius = CORE_RADIUS;
    this.radianceMiss = CORE_MISS_CHANCE;
    this.aura.scaling.setAll(CORE_RADIUS / RADIANCE_RADIUS);
    this.titles.set("radiance", "Ядро");
  }

  /** Ионная пушка: взрывы мортиры оставляют электрическое поле */
  makeIon(): void {
    if (!this.mortar) return;
    this.mortar.ion = true;
    this.titles.set("mortar", "Ионная пушка");
  }

  /** Оружие уже улучшено крафтом (Рой, Ядро, Ионная пушка) */
  crafted(id: WeaponId): boolean {
    return this.titles.has(id);
  }

  /** Кольцо взрыва на земле (бомба из магазина и т. п.) */
  blast(at: Vector3, radius: number, color = new Color3(1, 0.85, 0.3)): void {
    this.fx.show(at.x, at.y, at.z, radius, color);
  }

  /** Меши для теней (появляются при получении) */
  get shadowCasters(): AbstractMesh[] {
    return this.drones.flatMap((d) => d.meshes);
  }

  update(dt: number, player: Player, enemies: Enemy[]): void {
    this.time += dt;
    this.enemies = enemies;
    if (this.drones.length) this.updateDrones(dt, player, enemies);
    this.boomerang?.update(dt, player, enemies);
    this.blades?.update(dt, player, enemies);
    this.mortar?.update(dt, player, enemies);
    this.fx.update(dt);
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

  /**
   * Попадание любым оружием (пуля, взмах меча, автоматика) по врагу: с шансом — молния на двух ближайших.
   * force — молния гарантированно и без самого оружия «Молния» (Громовой клинок забирает его в рецепт).
   */
  onWeaponHit(target: Enemy, damage: number, point: Vector3, enemies: Enemy[], force = false): void {
    if (!force && (!this.has("lightning") || Math.random() >= LIGHTNING_CHANCE)) return;
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
    if (d2 <= this.radianceRadius * this.radianceRadius && Math.random() < this.radianceMiss) return damage * RADIANCE_MISS_MULT;
    return damage;
  }

  // ---------- Летающий пистолет / Рой ----------

  private createDrones(player: Player, count: number): void {
    for (let i = 0; i < count; i++) {
      // Та же модель, что в руке (если файл загружен), иначе примитивы с голубым стволом
      const template = gunTemplate(this.scene);
      const gun = template ? template.instantiate(`drone${i}`) : buildGunMesh(this.scene, `drone${i}`, new Color3(0.35, 0.85, 1));
      if (!gun.root.rotationQuaternion) gun.root.rotationQuaternion = Quaternion.Identity();
      gun.root.scaling.setAll(count > 1 ? 1.0 : 1.3); // одиночный чуть крупнее ручного — чтобы читался в воздухе
      // Автоматика не греется: разброс остаётся минимальным
      const weapon = new Gun(this.projectiles, player.weaponStats, { baseCooldown: DRONE_COOLDOWN, heat: false });
      if (count > 1) weapon.applyPreset({ ...GUN_PRESETS.pistol, damageMult: SWARM_DAMAGE_MULT });
      this.drones.push({
        root: gun.root,
        meshes: gun.meshes,
        muzzle: "muzzleLocal" in gun ? gun.muzzleLocal : GUN_MUZZLE_LOCAL,
        gun: weapon,
        offset: count > 1 ? SWARM_OFFSETS[i % SWARM_OFFSETS.length] : DRONE_OFFSET,
        phase: (i / count) * Math.PI * 2,
      });
    }
  }

  private disposeDrones(): void {
    for (const d of this.drones) d.root.dispose(false, true);
    this.drones.length = 0;
  }

  private updateDrones(dt: number, player: Player, enemies: Enemy[]): void {
    this.droneTime += dt;
    const yaw = player.mesh.rotation.y;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    for (const d of this.drones) {
      d.gun.update(dt);
      // Позиция: у плеча игрока, парит
      const ox = d.offset.x * cy + d.offset.z * sy;
      const oz = -d.offset.x * sy + d.offset.z * cy;
      const want = new Vector3(
        player.position.x + ox,
        player.position.y + d.offset.y + 0.08 * Math.sin(this.droneTime * 2.3 + d.phase),
        player.position.z + oz,
      );
      if (Vector3.DistanceSquared(d.root.position, want) > 25) d.root.position.copyFrom(want);
      else d.root.position.addInPlace(want.subtract(d.root.position).scaleInPlace(Math.min(1, dt * DRONE_FOLLOW)));

      // Цель — ближайший живой враг в радиусе
      let target: Enemy | null = null;
      let best = DRONE_RANGE * DRONE_RANGE;
      for (const e of enemies) {
        if (!e.alive) continue;
        const d2 = Vector3.DistanceSquared(e.node.position, d.root.position);
        if (d2 < best) {
          best = d2;
          target = e;
        }
      }
      // Поворот: на цель, иначе — куда смотрит игрок
      const dir = target ? target.node.position.subtract(d.root.position) : new Vector3(sy, 0, cy);
      if (dir.lengthSquared() > 1e-6) {
        const wantRot = lookRotation(dir.normalize(), Vector3.Up());
        Quaternion.SlerpToRef(d.root.rotationQuaternion!, wantRot, Math.min(1, dt * DRONE_TURN), d.root.rotationQuaternion!);
      }

      if (target && d.gun.ready) {
        d.root.computeWorldMatrix(true);
        const muzzle = Vector3.TransformCoordinates(d.muzzle, d.root.getWorldMatrix());
        d.gun.tryFire(muzzle, target.node.position);
      }
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
    const r2 = this.radianceRadius * this.radianceRadius;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.node.position.x - player.position.x;
      const dz = e.node.position.z - player.position.z;
      if (dx * dx + dz * dz > r2) continue;
      if (e.takeDamage(dmg)) this.onKill(e);
    }
  }
}
