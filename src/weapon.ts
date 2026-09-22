import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Enemy } from "./enemy";
import { lerp } from "./mathUtil";
import type { ProjectilePool } from "./projectiles";

// --- Разброс (огнестрел) ---
const SPREAD_MIN_DEG = 1;
const SPREAD_MAX_DEG = 2;
const SPREAD_CHANCE_MIN = 0.02; // шанс промаха «холодным» стволом
const SPREAD_CHANCE_MAX = 0.3; // при непрерывной стрельбе
const HEAT_PER_SHOT = 0.08; // ~12 выстрелов подряд до максимума
const RECOVER_MIN = 0.5; // секунд до полного остывания при минимальном нагреве...
const RECOVER_MAX = 2.0; // ...и при максимальном
const MULTI_FAN_DEG = 5; // веер при улучшении «доп. снаряды»

// --- Меч ---
const SWORD_RANGE = 2.6; // радиус удара от центра игрока
const SWORD_ARC = (130 * Math.PI) / 180; // ширина сектора
const SWORD_HEIGHT = 1.6; // допустимая разница высот ступней
const SWORD_DAMAGE_MULT = 3; // урон взмаха = урон снаряда × это
const SWING_TIME = 0.14; // длительность одного взмаха, с
const SWING_GAP = 0.04; // пауза между взмахами серии
const SWING_HALF = 1.1; // амплитуда руки, рад (взмах идёт от -A до +A)
const ARC_LIFE = 0.22; // визуал сектора, с

/**
 * Общие характеристики всех оружий игрока. Улучшения (урон, скорострельность, мультивыстрел)
 * меняют этот объект, а не конкретный пистолет — поэтому действуют и на ручной, и на летающий,
 * и на меч, и на любое оружие, которое появится позже.
 */
export class WeaponStats {
  /** Урон одной пули (для меча — базовый урон взмаха до множителя) */
  damage = 1;
  /** Пуль за выстрел (веером) / взмахов за удар */
  projectiles = 1;
  /** Множитель кулдауна: 0.82 после каждой «Скорострельности» */
  cooldownMult = 1;
}

/**
 * Одно оружие: свой кулдаун, общие stats. Пистолет в руке, летающий пистолет и меч — экземпляры наследников.
 */
export abstract class Weapon {
  protected cooldown = 0;

  constructor(
    readonly stats: WeaponStats,
    /** Базовый кулдаун между атаками, с (до множителя скорострельности) */
    protected readonly baseCooldown: number,
  ) {}

  /** Кулдаун с учётом улучшений скорострельности */
  get fireCooldown(): number {
    return this.baseCooldown * this.stats.cooldownMult;
  }

  get ready(): boolean {
    return this.cooldown <= 0;
  }

  /** Нагрев 0..1 (для HUD) — есть только у огнестрела */
  get heatLevel(): number {
    return 0;
  }

  /** Горизонтальный замах оружейной руки для анимации, рад (0 — вдоль прицела) */
  get swingAngle(): number {
    return 0;
  }

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  /** Атака из точки origin (дуло / центр игрока) в точку target, если кулдаун прошёл */
  abstract tryFire(origin: Vector3, target: Vector3): boolean;

  reset(): void {
    this.cooldown = 0;
  }
}

export interface GunOptions {
  baseCooldown: number;
  /** Греется ли ствол при непрерывной стрельбе (разброс растёт). У автоматики — нет */
  heat?: boolean;
}

/** Огнестрел: стреляет через общий пул пуль, греется при непрерывной стрельбе */
export class Gun extends Weapon {
  private heat = 0;
  private sinceShot = Infinity;
  private decayRate = 0;
  private readonly heats: boolean;

  constructor(
    private pool: ProjectilePool,
    stats: WeaponStats,
    opts: GunOptions,
  ) {
    super(stats, opts.baseCooldown);
    this.heats = opts.heat ?? true;
  }

  /** Текущий шанс разброса */
  get spreadChance(): number {
    return lerp(SPREAD_CHANCE_MIN, SPREAD_CHANCE_MAX, this.heat);
  }

  override get heatLevel(): number {
    return this.heat;
  }

  override update(dt: number): void {
    super.update(dt);
    // Остывание начинается, когда очередь прервалась (пауза дольше кулдауна)
    this.sinceShot += dt;
    if (this.heat > 0 && this.sinceShot > this.fireCooldown + 0.1) {
      this.heat = Math.max(0, this.heat - this.decayRate * dt);
    }
  }

  tryFire(muzzle: Vector3, target: Vector3): boolean {
    if (this.cooldown > 0) return false;
    const base = target.subtract(muzzle);
    if (base.lengthSquared() < 1e-4) return false;
    base.normalize();

    this.cooldown = this.fireCooldown;
    const count = this.stats.projectiles;
    const chance = this.spreadChance;
    for (let i = 0; i < count; i++) {
      let dir = base;
      if (count > 1) {
        const fan = ((i - (count - 1) / 2) * MULTI_FAN_DEG * Math.PI) / 180;
        dir = rotateAroundUp(base, fan);
      }
      if (Math.random() < chance) {
        const deg = lerp(SPREAD_MIN_DEG, SPREAD_MAX_DEG, Math.random());
        dir = deviate(dir, (deg * Math.PI) / 180);
      }
      this.pool.spawn(muzzle, dir, this.stats.damage);
    }

    if (this.heats) {
      // Нагрев: каждый выстрел добавляет, остывание после очереди длится 0.5–2 с в зависимости от нагрева
      this.heat = Math.min(1, this.heat + HEAT_PER_SHOT);
      this.decayRate = this.heat / lerp(RECOVER_MIN, RECOVER_MAX, this.heat);
    }
    this.sinceShot = 0;
    return true;
  }

  override reset(): void {
    super.reset();
    this.heat = 0;
  }
}

export interface MeleeHooks {
  /** Живые враги для проверки попаданий */
  enemies: () => Enemy[];
  /** Центр игрока (взмахи серии идут из текущей позиции, а не из точки начала удара) */
  origin: () => Vector3;
  /** Куда смотрит корпус, рад */
  yaw: () => number;
  /** Попадание по врагу до урона (молния и т. п.) */
  onHit: (enemy: Enemy, damage: number, point: Vector3) => void;
  onKill: (enemy: Enemy) => void;
}

interface Swing {
  /** Направление взмаха: +1 слева направо, -1 наоборот */
  dir: 1 | -1;
  /** Прогресс 0..1 */
  t: number;
  /** Урон уже нанесён */
  hit: boolean;
}

/**
 * Меч: удар — серия из stats.projectiles взмахов, каждый бьёт всех врагов в секторе перед игроком.
 * Урон взмаха = stats.damage × SWORD_DAMAGE_MULT; кулдаун — общий множитель скорострельности.
 * Молния срабатывает на каждое попадание через onHit, как у пуль.
 */
export class Sword extends Weapon {
  private queue = 0; // взмахов осталось в серии
  private gap = 0; // пауза до следующего взмаха
  private swing: Swing | null = null;
  private nextDir: 1 | -1 = 1;
  private arm = 0; // сглаженный угол руки для анимации
  private arc: Mesh;
  private arcMat: StandardMaterial;
  private arcLife = 0;

  constructor(
    scene: Scene,
    stats: WeaponStats,
    baseCooldown: number,
    private hooks: MeleeHooks,
  ) {
    super(stats, baseCooldown);
    // Сектор удара на земле — читаемая зона поражения
    this.arcMat = new StandardMaterial("swordArcMat", scene);
    this.arcMat.diffuseColor = Color3.Black();
    this.arcMat.specularColor = Color3.Black();
    this.arcMat.emissiveColor = new Color3(0.75, 0.9, 1);
    this.arcMat.disableLighting = true;
    this.arcMat.backFaceCulling = false;
    this.arcMat.alpha = 0;
    this.arc = CreateDisc("swordArc", { radius: SWORD_RANGE, arc: SWORD_ARC / (Math.PI * 2), tessellation: 24 }, scene);
    this.arc.material = this.arcMat;
    this.arc.isPickable = false;
    this.arc.receiveShadows = false;
    this.arc.setEnabled(false);
  }

  /** Урон одного взмаха */
  get swingDamage(): number {
    return Math.max(1, Math.round(this.stats.damage * SWORD_DAMAGE_MULT));
  }

  /** Идёт серия взмахов */
  get attacking(): boolean {
    return this.swing !== null || this.queue > 0;
  }

  override get ready(): boolean {
    return this.cooldown <= 0 && !this.attacking;
  }

  override get swingAngle(): number {
    return this.arm;
  }

  tryFire(_origin: Vector3, _target: Vector3): boolean {
    if (!this.ready) return false;
    this.cooldown = this.fireCooldown;
    this.queue = Math.max(1, this.stats.projectiles);
    this.gap = 0;
    this.startSwing();
    return true;
  }

  override update(dt: number): void {
    super.update(dt);
    // Текущий взмах: урон в середине (клинок проходит сектор), в конце — следующий из серии.
    // Взмахи ускоряются вместе с кулдауном, иначе длинная серия не влезала бы в скорострельность.
    if (this.swing) {
      this.swing.t += dt / (SWING_TIME * this.stats.cooldownMult);
      if (!this.swing.hit && this.swing.t >= 0.5) {
        this.swing.hit = true;
        this.strike();
      }
      if (this.swing.t >= 1) {
        this.swing = null;
        this.gap = SWING_GAP * this.stats.cooldownMult;
      }
    } else if (this.queue > 0) {
      this.gap -= dt;
      if (this.gap <= 0) this.startSwing();
    }

    // Рука: во время взмаха идёт от -A до +A (или наоборот), в покое возвращается к прицелу
    const want = this.swing ? this.swing.dir * lerp(-SWING_HALF, SWING_HALF, ease(this.swing.t)) : 0;
    const rate = this.swing ? 40 : 14;
    this.arm += (want - this.arm) * Math.min(1, dt * rate);

    // Сектор гаснет
    if (this.arcLife > 0) {
      this.arcLife -= dt;
      this.arcMat.alpha = 0.35 * Math.max(0, this.arcLife / ARC_LIFE);
      if (this.arcLife <= 0) this.arc.setEnabled(false);
    }
  }

  private startSwing(): void {
    this.queue--;
    this.swing = { dir: this.nextDir, t: 0, hit: false };
    this.nextDir = this.nextDir === 1 ? -1 : 1;
  }

  /** Урон всем врагам в секторе перед игроком */
  private strike(): void {
    const o = this.hooks.origin();
    const yaw = this.hooks.yaw();
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const cosHalf = Math.cos(SWORD_ARC / 2);
    const dmg = this.swingDamage;
    const playerFeet = o.y - 1;

    // Визуал: сектор на земле, центр по yaw. Диск после rotation.x=π/2 лежит в XZ, его сектор
    // начинается с +X в сторону +Z; rotation.y поворачивает так, чтобы середина легла на направление yaw.
    this.arc.position.set(o.x, playerFeet + 0.07, o.z);
    this.arc.rotation.set(Math.PI / 2, SWORD_ARC / 2 - Math.PI / 2 + yaw, 0);
    this.arc.setEnabled(true);
    this.arcLife = ARC_LIFE;
    this.arcMat.alpha = 0.35;

    for (const e of this.hooks.enemies()) {
      if (!e.alive) continue;
      const p = e.node.position;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SWORD_RANGE + e.hitRadius) continue;
      if (Math.abs(e.feetY - playerFeet) > SWORD_HEIGHT) continue;
      // Вплотную — бьём в любом направлении; иначе — только в секторе
      if (dist > e.hitRadius && (dx * fx + dz * fz) / dist < cosHalf) continue;
      this.hooks.onHit(e, dmg, new Vector3(p.x, p.y, p.z));
      if (e.alive && e.takeDamage(dmg)) this.hooks.onKill(e);
    }
  }

  override reset(): void {
    super.reset();
    this.queue = 0;
    this.swing = null;
  }
}

function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Повернуть направление вокруг вертикали на angle */
function rotateAroundUp(dir: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Vector3(dir.x * c + dir.z * s, dir.y, -dir.x * s + dir.z * c);
}

/** Отклонить направление на угол angle в случайную сторону */
function deviate(dir: Vector3, angle: number): Vector3 {
  const helper = Math.abs(dir.y) < 0.9 ? Vector3.Up() : new Vector3(1, 0, 0);
  const u = Vector3.Cross(dir, helper).normalize();
  const v = Vector3.Cross(dir, u).normalize();
  const phi = Math.random() * Math.PI * 2;
  const off = u.scale(Math.cos(phi)).addInPlace(v.scale(Math.sin(phi)));
  return dir.scale(Math.cos(angle)).addInPlace(off.scaleInPlace(Math.sin(angle))).normalize();
}
