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
const SWORD_ARC_DEG = 130; // ширина сектора по умолчанию
const SWORD_HEIGHT = 1.6; // допустимая разница высот ступней
const SWORD_DAMAGE_MULT = 3; // урон взмаха = урон снаряда × это
const SWING_TIME = 0.14; // длительность одного взмаха, с
const SWING_GAP = 0.04; // пауза между взмахами серии
const SWING_HALF = 1.1; // амплитуда руки, рад (взмах идёт от -A до +A)
const ARC_LIFE = 0.22; // визуал сектора, с

export const CRIT_MULT = 3;

/**
 * Общие характеристики всех оружий игрока. Улучшения (урон, скорострельность, мультивыстрел)
 * меняют этот объект, а не конкретный пистолет — поэтому действуют и на ручной, и на летающий,
 * и на меч, и на любое оружие, которое появится позже. Сюда же ложатся перки из магазина и крафта.
 */
export class WeaponStats {
  /** Урон одной пули (для меча — базовый урон взмаха до множителя) */
  damage = 1;
  /** Пуль за выстрел (веером) / взмахов за удар */
  projectiles = 1;
  /** Множитель кулдауна: 0.82 после каждой «Скорострельности» */
  cooldownMult = 1;
  /** Временный множитель кулдауна (ярость и т. п.) — ставит Game каждый кадр */
  tempCooldownMult = 1;
  /** Шанс крита (урон × CRIT_MULT) */
  critChance = 0;
  /** Сколько врагов пуля пробивает насквозь (урон ×0.5 за каждое пробитие) */
  pierce = 0;
  /** Пуля, ударившись о землю или стену, один раз отскакивает в ближайшего врага */
  ricochet = false;
  /** Радиус взрыва пули при попадании (0 — нет) */
  bulletBlast = 0;
  /** Доля урона пуль, возвращаемая игроку здоровьем */
  bulletLifesteal = 0;
  /** Каждое попадание меча гарантированно бьёт молнией (Громовой клинок) */
  thunderBlade = false;

  /** Итоговый множитель кулдауна */
  get totalCooldownMult(): number {
    return this.cooldownMult * this.tempCooldownMult;
  }

  /** Урон с учётом крита. Возвращает [урон, крит?] */
  roll(base: number): [number, boolean] {
    if (this.critChance > 0 && Math.random() < this.critChance) return [base * CRIT_MULT, true];
    return [base, false];
  }
}

/**
 * Одно оружие: свой кулдаун, общие stats. Пистолет в руке, летающий пистолет и меч — экземпляры наследников.
 */
export abstract class Weapon {
  protected cooldown = 0;

  constructor(
    readonly stats: WeaponStats,
    /** Базовый кулдаун между атаками, с (до множителя скорострельности) */
    protected baseCooldown: number,
  ) {}

  /** Кулдаун с учётом улучшений скорострельности */
  get fireCooldown(): number {
    return this.baseCooldown * this.stats.totalCooldownMult;
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

/** Пресет огнестрела (крафт: дробовик, автомат) поверх базового пистолета */
export interface GunPreset {
  title: string;
  /** Множитель базового кулдауна */
  cooldownMult: number;
  /** Дополнительных пуль за выстрел (сверх мультивыстрела) */
  pellets: number;
  /** Ширина веера всех пуль, градусы */
  fanDeg: number;
  /** Множитель урона пули */
  damageMult: number;
  /** Дальность пули (undefined — стандартная) */
  range?: number;
  /** Множитель нагрева за выстрел */
  heatMult: number;
  /** Максимальный разброс при перегреве, градусы */
  spreadMaxDeg: number;
}

export const GUN_PRESETS: Record<"pistol" | "shotgun" | "rifle", GunPreset> = {
  pistol: { title: "Пистолет", cooldownMult: 1, pellets: 0, fanDeg: MULTI_FAN_DEG, damageMult: 1, heatMult: 1, spreadMaxDeg: SPREAD_MAX_DEG },
  shotgun: { title: "Дробовик", cooldownMult: 2, pellets: 5, fanDeg: 25, damageMult: 0.6, range: 12, heatMult: 0.5, spreadMaxDeg: 4 },
  rifle: { title: "Автомат", cooldownMult: 0.35, pellets: 0, fanDeg: MULTI_FAN_DEG, damageMult: 1, heatMult: 2, spreadMaxDeg: 5 },
};

/** Огнестрел: стреляет через общий пул пуль, греется при непрерывной стрельбе */
export class Gun extends Weapon {
  private heat = 0;
  private sinceShot = Infinity;
  private decayRate = 0;
  private readonly heats: boolean;
  private readonly rootCooldown: number;
  /** Нагрев не растёт, пока таймер > 0 (перк «Охлаждение») */
  private noHeat = 0;
  preset: GunPreset = GUN_PRESETS.pistol;

  constructor(
    private pool: ProjectilePool,
    stats: WeaponStats,
    opts: GunOptions,
  ) {
    super(stats, opts.baseCooldown);
    this.rootCooldown = opts.baseCooldown;
    this.heats = opts.heat ?? true;
  }

  /** Сменить пресет (крафт): кулдаун пересчитывается от исходного */
  applyPreset(preset: GunPreset): void {
    this.preset = preset;
    this.baseCooldown = this.rootCooldown * preset.cooldownMult;
  }

  /** Текущий шанс разброса */
  get spreadChance(): number {
    return lerp(SPREAD_CHANCE_MIN, SPREAD_CHANCE_MAX, this.heat);
  }

  override get heatLevel(): number {
    return this.heat;
  }

  /** Ствол не греется seconds секунд */
  suppressHeat(seconds: number): void {
    this.noHeat = Math.max(this.noHeat, seconds);
    this.heat = 0;
  }

  override update(dt: number): void {
    super.update(dt);
    this.noHeat = Math.max(0, this.noHeat - dt);
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
    const p = this.preset;
    const count = this.stats.projectiles + p.pellets;
    const chance = this.spreadChance;
    const damage = Math.max(1, Math.round(this.stats.damage * p.damageMult));
    for (let i = 0; i < count; i++) {
      let dir = base;
      if (count > 1) {
        // Веер: у пистолета шаг fanDeg между пулями, у дробовика fanDeg — вся ширина конуса
        const fan = p.pellets > 0 ? (i / (count - 1) - 0.5) * p.fanDeg : (i - (count - 1) / 2) * p.fanDeg;
        dir = rotateAroundUp(base, (fan * Math.PI) / 180);
        if (p.pellets > 0) dir = deviate(dir, (Math.random() * p.fanDeg * 0.15 * Math.PI) / 180);
      }
      if (Math.random() < chance) {
        const deg = lerp(SPREAD_MIN_DEG, p.spreadMaxDeg, Math.random());
        dir = deviate(dir, (deg * Math.PI) / 180);
      }
      this.pool.spawn(muzzle, dir, damage, p.range);
    }

    if (this.heats && this.noHeat <= 0) {
      // Нагрев: каждый выстрел добавляет, остывание после очереди длится 0.5–2 с в зависимости от нагрева
      this.heat = Math.min(1, this.heat + HEAT_PER_SHOT * p.heatMult);
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
  /** Центр игрока (первый взмах серии бьёт отсюда, остальные — от снимка в момент начала серии) */
  origin: () => Vector3;
  /** Куда смотрит корпус, рад */
  yaw: () => number;
  /** Высота пола (земля или верх стены) в точке — для проверки высоты у отвязанных взмахов */
  floorAt: (x: number, z: number) => number;
  /** Попадание по врагу до урона (молния и т. п.); force — молния гарантированно */
  onHit: (enemy: Enemy, damage: number, point: Vector3, force?: boolean) => void;
  onKill: (enemy: Enemy) => void;
  /** Рывок игрока вперёд на distance перед ударом (перк «Рывок-удар»); Game проверяет стены */
  dash?: (distance: number) => void;
}

/** Модификации меча из магазина/крафта */
export interface SwordMods {
  title?: string;
  arcDeg?: number;
  /** Множитель урона взмаха (поверх SWORD_DAMAGE_MULT) */
  damageMult?: number;
  /** Множитель кулдауна */
  cooldownMult?: number;
  /** Рывок вперёд перед ударом, юниты */
  dash?: number;
}

/**
 * Серия взмахов одного удара. Первый взмах привязан к игроку, остальные идут «волной»
 * от точки, где игрок был в момент удара: каждый следующий на SWING_STEP дальше по yaw.
 * Серии независимы — новый удар может начаться, пока волна предыдущего ещё идёт.
 */
interface Series {
  /** Снимок позиции игрока в момент удара (не ссылка на живой player.position) */
  origin: Vector3;
  yaw: number;
  /** Номер текущего взмаха: 0 — первый (у игрока), дальше — отвязанные */
  index: number;
  /** Сколько взмахов ещё предстоит начать */
  left: number;
  /** Прогресс текущего взмаха 0..1; -1 — взмах ещё не начался (идёт пауза gap) */
  t: number;
  gap: number;
  /** Направление текущего взмаха: +1 слева направо, -1 наоборот */
  dir: 1 | -1;
  /** Урон текущего взмаха уже нанесён */
  hit: boolean;
}

/** Сектор удара на земле; у каждого свой материал — гаснут независимо */
interface Arc {
  mesh: Mesh;
  mat: StandardMaterial;
  life: number;
}

const SWING_STEP = 1.6; // на сколько каждый следующий взмах серии дальше предыдущего

/**
 * Меч: удар — серия из stats.projectiles взмахов, каждый бьёт всех врагов в секторе.
 * Урон взмаха = stats.damage × SWORD_DAMAGE_MULT; кулдаун — общий множитель скорострельности.
 * Молния срабатывает на каждое попадание через onHit, как у пуль.
 */
export class Sword extends Weapon {
  private series: Series[] = [];
  private nextDir: 1 | -1 = 1;
  private arm = 0; // сглаженный угол руки для анимации
  private arcs: Arc[] = [];
  private freeArcs: Arc[] = [];
  private readonly rootCooldown: number;
  title = "Меч";
  arc = (SWORD_ARC_DEG * Math.PI) / 180;
  damageMult = 1;
  dash = 0;

  constructor(
    private scene: Scene,
    stats: WeaponStats,
    baseCooldown: number,
    private hooks: MeleeHooks,
  ) {
    super(stats, baseCooldown);
    this.rootCooldown = baseCooldown;
  }

  /** Применить модификацию (крафт/предмет); поля, которых нет, не трогаются. Кулдаун — от исходного */
  applyMods(m: SwordMods): void {
    if (m.title) this.title = m.title;
    if (m.arcDeg !== undefined) this.arc = (Math.min(360, m.arcDeg) * Math.PI) / 180;
    if (m.damageMult !== undefined) this.damageMult *= m.damageMult;
    if (m.cooldownMult !== undefined) this.baseCooldown *= m.cooldownMult;
    if (m.dash !== undefined) this.dash = m.dash;
    // Секторы визуала перестраиваются под новый угол
    for (const a of [...this.arcs, ...this.freeArcs]) a.mesh.dispose();
    this.arcs.length = 0;
    this.freeArcs.length = 0;
  }

  get arcDeg(): number {
    return Math.round((this.arc * 180) / Math.PI);
  }

  /** Множитель урона взмаха относительно урона снаряда */
  get totalDamageMult(): number {
    return SWORD_DAMAGE_MULT * this.damageMult;
  }

  /** Урон одного взмаха */
  get swingDamage(): number {
    return Math.max(1, Math.round(this.stats.damage * this.totalDamageMult));
  }

  /** Идёт хотя бы одна серия взмахов */
  get attacking(): boolean {
    return this.series.length > 0;
  }

  override get swingAngle(): number {
    return this.arm;
  }

  /** Новый удар ограничен только кулдауном: волна предыдущего может ещё идти */
  tryFire(_origin: Vector3, _target: Vector3): boolean {
    if (!this.ready) return false;
    this.cooldown = this.fireCooldown;
    if (this.dash > 0) this.hooks.dash?.(this.dash);
    this.series.push({
      origin: this.hooks.origin().clone(),
      yaw: this.hooks.yaw(),
      index: -1,
      left: Math.max(1, this.stats.projectiles),
      t: -1,
      gap: 0,
      dir: this.nextDir,
      hit: false,
    });
    return true;
  }

  override update(dt: number): void {
    super.update(dt);
    // Взмахи ускоряются вместе с кулдауном, иначе длинная серия не влезала бы в скорострельность
    const swingTime = SWING_TIME * this.stats.totalCooldownMult;
    const gapTime = SWING_GAP * this.stats.totalCooldownMult;

    for (let i = this.series.length - 1; i >= 0; i--) {
      const s = this.series[i];
      if (s.t < 0) {
        // Пауза между взмахами (первый стартует сразу)
        s.gap -= dt;
        if (s.gap > 0) continue;
        s.index++;
        s.left--;
        s.t = 0;
        s.hit = false;
        s.dir = this.nextDir;
        this.nextDir = this.nextDir === 1 ? -1 : 1;
      }
      s.t += dt / swingTime;
      // Урон в середине взмаха — клинок проходит сектор
      if (!s.hit && s.t >= 0.5) {
        s.hit = true;
        this.strike(s);
      }
      if (s.t >= 1) {
        if (s.left > 0) {
          s.t = -1;
          s.gap = gapTime;
        } else {
          this.series.splice(i, 1);
        }
      }
    }

    // Рука: показывает самую свежую серию; во время взмаха идёт от -A до +A (или наоборот), в покое — к прицелу
    const last = this.series[this.series.length - 1];
    const active = last && last.t >= 0 ? last : null;
    const want = active ? active.dir * lerp(-SWING_HALF, SWING_HALF, ease(active.t)) : 0;
    const rate = active ? 40 : 14;
    this.arm += (want - this.arm) * Math.min(1, dt * rate);

    // Секторы гаснут
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.life -= dt;
      a.mat.alpha = 0.35 * Math.max(0, a.life / ARC_LIFE);
      if (a.life <= 0) {
        a.mesh.setEnabled(false);
        this.freeArcs.push(a);
        this.arcs.splice(i, 1);
      }
    }
  }

  /** Урон всем врагам в секторе текущего взмаха серии */
  private strike(s: Series): void {
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    // Первый взмах — от игрока, где он сейчас; остальные — от снимка, каждый на шаг дальше
    let o: Vector3;
    let feet: number;
    if (s.index === 0) {
      o = this.hooks.origin();
      feet = o.y - 1;
    } else {
      const d = s.index * SWING_STEP;
      o = new Vector3(s.origin.x + fx * d, 0, s.origin.z + fz * d);
      feet = this.hooks.floorAt(o.x, o.z);
    }
    const fullCircle = this.arc >= Math.PI * 2 - 1e-3;
    const cosHalf = Math.cos(this.arc / 2);
    const base = this.swingDamage;

    this.showArc(o.x, feet + 0.07, o.z, s.yaw);

    for (const e of this.hooks.enemies()) {
      if (!e.alive) continue;
      const p = e.node.position;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SWORD_RANGE + e.hitRadius) continue;
      if (Math.abs(e.feetY - feet) > SWORD_HEIGHT) continue;
      // Вплотную — бьём в любом направлении; иначе — только в секторе
      if (!fullCircle && dist > e.hitRadius && (dx * fx + dz * fz) / dist < cosHalf) continue;
      const [dmg] = this.stats.roll(base);
      this.hooks.onHit(e, dmg, new Vector3(p.x, p.y, p.z), this.stats.thunderBlade);
      if (e.alive && e.takeDamage(dmg)) this.hooks.onKill(e);
    }
  }

  /**
   * Сектор на земле, центр по yaw. Диск после rotation.x=π/2 лежит в XZ, его сектор
   * начинается с +X в сторону +Z; rotation.y поворачивает так, чтобы середина легла на направление yaw.
   */
  private showArc(x: number, y: number, z: number, yaw: number): void {
    let a = this.freeArcs.pop();
    if (!a) {
      const mat = new StandardMaterial("swordArcMat", this.scene);
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.emissiveColor = new Color3(0.75, 0.9, 1);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      const mesh = CreateDisc("swordArc", { radius: SWORD_RANGE, arc: Math.min(1, this.arc / (Math.PI * 2)), tessellation: 32 }, this.scene);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      a = { mesh, mat, life: 0 };
    }
    a.mesh.position.set(x, y, z);
    a.mesh.rotation.set(Math.PI / 2, this.arc / 2 - Math.PI / 2 + yaw, 0);
    a.mesh.setEnabled(true);
    a.mat.alpha = 0.35;
    a.life = ARC_LIFE;
    this.arcs.push(a);
  }

  override reset(): void {
    super.reset();
    this.series.length = 0;
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
  return dir
    .scale(Math.cos(angle))
    .addInPlace(off.scaleInPlace(Math.sin(angle)))
    .normalize();
}
