import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Enemy } from "./enemy";
import type { Player } from "./player";
import type { WeaponStats } from "./weapon";

/**
 * Автоматические оружия, выпадающие с колеса фортуны. Каждое само выбирает цель и атакует,
 * урон считает от общих `WeaponStats` игрока — но по-разному: бумеранг и мортира берут
 * мультивыстрел как число снарядов, клинки — как число лезвий, скорострельность ускоряет всех.
 *
 * Визуал — софтверный рендер: классы только хранят позиции (flights, blades, shells, fields),
 * а кольца взрывов уходят в FxSink.
 */
export interface AutoHooks {
  /** Попадание до урона — молния и т. п. */
  onHit: (enemy: Enemy, damage: number, point: Vector3) => void;
  onKill: (enemy: Enemy) => void;
  /** Высота опоры (земля или верх стены) */
  floorAt: (x: number, z: number) => number;
}

/** Приёмник эффектов (рендер): кольцо взрыва на земле, ломаная молнии */
export interface FxSink {
  blast(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void;
  bolt(pts: { x: number; y: number; z: number }[]): void;
}

/** Урон врагу через хуки: крит по общим статам, onHit (молния), урон, убитого — в onKill */
function dealDamage(hooks: AutoHooks, stats: WeaponStats, e: Enemy, base: number, point: Vector3): void {
  const [dmg] = stats.roll(base);
  hooks.onHit(e, dmg, point);
  if (e.alive && e.takeDamage(dmg)) hooks.onKill(e);
}

// ---------- Бумеранг ----------

const BOOM_COOLDOWN = 1.4; // с между бросками до скорострельности
const BOOM_SEARCH = 16; // радиус поиска цели
const BOOM_SPEED = 20;
const BOOM_MIN_OUT = 4;
const BOOM_MAX_OUT = 12;
const BOOM_HIT_R = 0.7;
const BOOM_DAMAGE_MULT = 2; // за каждое касание (туда и обратно — два)
const BOOM_SPIN = 16; // рад/с
const BOOM_FAN_DEG = 22; // веер при мультивыстреле
const BOOM_HEIGHT = 1.0; // над опорой

export interface BoomerangFlight {
  pos: Vector3;
  dir: Vector3;
  out: number;
  traveled: number;
  returning: boolean;
  hit: Set<number>;
  /** Угол вращения (кадр спрайта) */
  spin: number;
}

/**
 * Бумеранг: летит к ближайшему врагу, пробивая всех по пути, разворачивается и возвращается
 * к игроку, снова бьёт. Мультивыстрел бросает несколько веером.
 */
export interface BoomerangOptions {
  /** Множитель кулдауна */
  cooldownMult?: number;
}

export class Boomerang {
  private cooldown = 0;
  /** Полёты — рендер читает позиции и spin */
  readonly flights: BoomerangFlight[] = [];
  private readonly cooldownMult: number;

  constructor(
    private stats: WeaponStats,
    private hooks: AutoHooks,
    opts: BoomerangOptions = {},
  ) {
    this.cooldownMult = opts.cooldownMult ?? 1;
  }

  get damage(): number {
    return Math.max(1, Math.round(this.stats.damage * BOOM_DAMAGE_MULT));
  }

  update(dt: number, player: Player, enemies: Enemy[]): void {
    this.cooldown -= dt;
    const origin = player.position.add(new Vector3(0, 0.3, 0));
    if (this.cooldown <= 0) {
      const target = nearest(enemies, origin, BOOM_SEARCH);
      if (target) {
        this.cooldown = BOOM_COOLDOWN * this.cooldownMult * this.stats.totalCooldownMult;
        this.throwAt(origin, target);
      }
    }

    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      if (f.returning) {
        const back = origin.subtract(f.pos);
        back.y = 0;
        const d = back.length();
        if (d < 0.9) {
          this.flights.splice(i, 1);
          continue;
        }
        f.dir.copyFrom(back.scaleInPlace(1 / d));
      }
      const step = BOOM_SPEED * dt;
      f.pos.addInPlace(f.dir.scale(step));
      f.traveled += step;
      f.spin += BOOM_SPIN * dt;
      if (!f.returning && f.traveled >= f.out) {
        f.returning = true;
        f.hit.clear(); // на обратном пути бьёт тех же ещё раз
      }
      // Высота: над опорой, чтобы не зарываться в холмы
      const wantY = this.hooks.floorAt(f.pos.x, f.pos.z) + BOOM_HEIGHT;
      f.pos.y += (wantY - f.pos.y) * Math.min(1, dt * 12);

      const dmg = this.damage;
      for (const e of enemies) {
        if (!e.alive || f.hit.has(e.id)) continue;
        const p = e.node.position;
        const dx = p.x - f.pos.x;
        const dz = p.z - f.pos.z;
        const r = BOOM_HIT_R + e.hitRadius;
        if (dx * dx + dz * dz > r * r) continue;
        if (Math.abs(p.y - f.pos.y) > 1.5) continue;
        f.hit.add(e.id);
        dealDamage(this.hooks, this.stats, e, dmg, new Vector3(p.x, f.pos.y, p.z));
      }
    }
  }

  private throwAt(origin: Vector3, target: Enemy): void {
    const to = target.node.position.subtract(origin);
    to.y = 0;
    const dist = to.length();
    if (dist < 1e-3) return;
    const base = to.scaleInPlace(1 / dist);
    const count = Math.max(1, this.stats.projectiles);
    const out = Math.min(BOOM_MAX_OUT, Math.max(BOOM_MIN_OUT, dist + 1.5));
    for (let i = 0; i < count; i++) {
      const fan = ((i - (count - 1) / 2) * BOOM_FAN_DEG * Math.PI) / 180;
      const c = Math.cos(fan);
      const s = Math.sin(fan);
      const dir = new Vector3(base.x * c + base.z * s, 0, -base.x * s + base.z * c);
      this.flights.push({ pos: origin.clone(), dir, out, traveled: 0, returning: false, hit: new Set(), spin: 0 });
    }
  }

  /** Сколько бумерангов сейчас в полёте */
  get inFlight(): number {
    return this.flights.length;
  }
}

// ---------- Орбитальные клинки ----------

const BLADE_BASE_COUNT = 2; // + по одному за каждый уровень мультивыстрела
const BLADE_RADIUS = 2.4;
const BLADE_SPEED = 2.6; // рад/с до скорострельности
const BLADE_HIT_R = 0.55;
const BLADE_DAMAGE_MULT = 1.5;
const BLADE_RETICK = 0.45; // с, чаще одного врага не режем
const BLADE_HEIGHT = -0.15; // относительно центра игрока (пояс)

export interface BladePos {
  x: number;
  y: number;
  z: number;
  /** Угол на орбите (кадр спрайта) */
  angle: number;
}

/**
 * Клинки кружат вокруг игрока и режут всех, кого задевают. Число клинков растёт с мультивыстрелом,
 * скорость вращения — со скорострельностью, урон — с уроном.
 */
export interface BladesOptions {
  /** Базовое число клинков (Пила — 4) */
  baseCount?: number;
  radius?: number;
}

export class OrbitBlades {
  private angle = 0;
  private time = 0;
  private lastHit = new Map<number, number>();
  baseCount: number;
  radius: number;
  /** Позиции клинков за последний update — рендер читает напрямую */
  readonly positions: BladePos[] = [];

  constructor(
    private stats: WeaponStats,
    private hooks: AutoHooks,
    opts: BladesOptions = {},
  ) {
    this.baseCount = opts.baseCount ?? BLADE_BASE_COUNT;
    this.radius = opts.radius ?? BLADE_RADIUS;
  }

  get count(): number {
    return this.baseCount + Math.max(0, this.stats.projectiles - 1);
  }

  get damage(): number {
    return Math.max(1, Math.round(this.stats.damage * BLADE_DAMAGE_MULT));
  }

  update(dt: number, player: Player, enemies: Enemy[]): void {
    this.time += dt;
    this.angle += (BLADE_SPEED / this.stats.totalCooldownMult) * dt;
    const n = this.count;
    const c = player.position;
    const y = c.y + BLADE_HEIGHT;
    const dmg = this.damage;
    this.positions.length = 0;
    for (let i = 0; i < n; i++) {
      const a = this.angle + (i / n) * Math.PI * 2;
      const bx = c.x + Math.cos(a) * this.radius;
      const bz = c.z + Math.sin(a) * this.radius;
      this.positions.push({ x: bx, y, z: bz, angle: a });
      for (const e of enemies) {
        if (!e.alive) continue;
        const p = e.node.position;
        const dx = p.x - bx;
        const dz = p.z - bz;
        const r = BLADE_HIT_R + e.hitRadius;
        if (dx * dx + dz * dz > r * r) continue;
        if (Math.abs(p.y - y) > 1.3) continue;
        const last = this.lastHit.get(e.id) ?? -Infinity;
        if (this.time - last < BLADE_RETICK) continue;
        this.lastHit.set(e.id, this.time);
        dealDamage(this.hooks, this.stats, e, dmg, new Vector3(bx, y, bz));
      }
    }
    if (this.lastHit.size > 2000) this.lastHit.clear();
  }
}

// ---------- Мортира ----------

const MORTAR_COOLDOWN = 2.4;
const MORTAR_RANGE = 22;
const MORTAR_MIN_RANGE = 3; // ближе — не стреляем, чтобы не накрыть себя
const MORTAR_FLIGHT = 0.9; // с
const MORTAR_ARC = 5; // высота дуги
const MORTAR_BLAST_R = 3.2;
const MORTAR_DAMAGE_MULT = 4;
const MORTAR_CLUSTER_R = 3; // оценка «плотности» цели
// Цвет взрыва (оранжевый) и ионного поля (голубой) — для FxSink
const MORTAR_RGB: [number, number, number] = [1, 0.55, 0.2];
// Ионная пушка (крафт): взрыв оставляет электрическое поле
const ION_LIFE = 3; // с
const ION_TICK = 0.5;
const ION_DAMAGE_MULT = 0.75; // от урона снаряда за тик

export interface Shell {
  pos: Vector3;
  from: Vector3;
  to: Vector3;
  t: number;
}

export interface IonField {
  pos: Vector3;
  life: number;
  tick: number;
}

/**
 * Мортира: раз в несколько секунд навесом кидает снаряд в самое плотное скопление врагов,
 * взрыв бьёт всех в радиусе. Мультивыстрел — несколько снарядов по разным скоплениям.
 */
export class Mortar {
  private cooldown = MORTAR_COOLDOWN * 0.5; // первый выстрел быстрее
  /** Снаряды в полёте — рендер читает pos */
  readonly shells: Shell[] = [];
  /** Активные ионные поля — рендер рисует кольца */
  readonly fields: IonField[] = [];
  /** Сколько взрывов прогремело (для тестов и статистики) */
  blasts = 0;
  /** Ионная пушка: взрыв оставляет поле */
  ion = false;

  constructor(
    private stats: WeaponStats,
    private hooks: AutoHooks,
    private fx: FxSink,
  ) {}

  get damage(): number {
    return Math.max(1, Math.round(this.stats.damage * MORTAR_DAMAGE_MULT));
  }

  /** Активных ионных полей */
  get fieldCount(): number {
    return this.fields.length;
  }

  update(dt: number, player: Player, enemies: Enemy[]): void {
    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      const targets = this.pickTargets(player.position, enemies, Math.max(1, this.stats.projectiles));
      if (targets.length > 0) {
        this.cooldown = MORTAR_COOLDOWN * this.stats.totalCooldownMult;
        const from = player.position.add(new Vector3(0, 1.2, 0));
        for (const t of targets) this.fire(from, t);
      }
    }
    this.updateFields(dt, enemies);

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t += dt / MORTAR_FLIGHT;
      if (s.t >= 1) {
        this.explode(s.to, enemies);
        this.shells.splice(i, 1);
        continue;
      }
      const p = Vector3.Lerp(s.from, s.to, s.t);
      p.y += MORTAR_ARC * 4 * s.t * (1 - s.t);
      s.pos.copyFrom(p);
    }
  }

  /** До count целей: самая «плотная» первая, следующие — вне радиуса уже выбранных взрывов */
  private pickTargets(center: Vector3, enemies: Enemy[], count: number): Vector3[] {
    const inRange: Enemy[] = [];
    for (const e of enemies) {
      if (!e.alive) continue;
      const d2 = horizontalDist2(e.node.position, center);
      if (d2 <= MORTAR_RANGE * MORTAR_RANGE && d2 >= MORTAR_MIN_RANGE * MORTAR_MIN_RANGE) inRange.push(e);
    }
    if (inRange.length === 0) return [];
    const r2 = MORTAR_CLUSTER_R * MORTAR_CLUSTER_R;
    const score = inRange.map((e) => {
      let n = 0;
      for (const o of inRange) if (horizontalDist2(o.node.position, e.node.position) <= r2) n++;
      return n;
    });
    const chosen: Vector3[] = [];
    const used = new Array<boolean>(inRange.length).fill(false);
    const blast2 = MORTAR_BLAST_R * MORTAR_BLAST_R;
    for (let k = 0; k < count; k++) {
      let best = -1;
      for (let i = 0; i < inRange.length; i++) {
        if (used[i]) continue;
        if (best < 0 || score[i] > score[best]) best = i;
      }
      if (best < 0) break;
      const p = inRange[best].node.position;
      chosen.push(new Vector3(p.x, this.hooks.floorAt(p.x, p.z), p.z));
      for (let i = 0; i < inRange.length; i++) {
        if (horizontalDist2(inRange[i].node.position, p) <= blast2) used[i] = true;
      }
    }
    return chosen;
  }

  private fire(from: Vector3, to: Vector3): void {
    this.shells.push({ pos: from.clone(), from: from.clone(), to: to.clone(), t: 0 });
  }

  private explode(at: Vector3, enemies: Enemy[]): void {
    this.blasts++;
    this.fx.blast(at.x, at.y, at.z, MORTAR_BLAST_R, MORTAR_RGB[0], MORTAR_RGB[1], MORTAR_RGB[2]);
    const dmg = this.damage;
    for (const e of enemies) {
      if (!e.alive) continue;
      const p = e.node.position;
      const r = MORTAR_BLAST_R + e.hitRadius;
      if (horizontalDist2(p, at) > r * r) continue;
      if (Math.abs(e.feetY - at.y) > 2.5) continue;
      dealDamage(this.hooks, this.stats, e, dmg, new Vector3(p.x, p.y, p.z));
    }
    if (this.ion) this.spawnField(at);
  }

  /** Электрическое поле на месте взрыва: бьёт всех внутри каждые ION_TICK */
  private spawnField(at: Vector3): void {
    this.fields.push({ pos: at.clone(), life: ION_LIFE, tick: ION_TICK * 0.5 });
  }

  private updateFields(dt: number, enemies: Enemy[]): void {
    const dmg = Math.max(1, Math.round(this.stats.damage * ION_DAMAGE_MULT));
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      f.life -= dt;
      f.tick -= dt;
      if (f.tick <= 0) {
        f.tick = ION_TICK;
        for (const e of enemies) {
          if (!e.alive) continue;
          const p = e.node.position;
          const r = MORTAR_BLAST_R + e.hitRadius;
          if (horizontalDist2(p, f.pos) > r * r) continue;
          if (Math.abs(e.feetY - f.pos.y) > 2.5) continue;
          dealDamage(this.hooks, this.stats, e, dmg, new Vector3(p.x, p.y, p.z));
        }
      }
      if (f.life <= 0) this.fields.splice(i, 1);
    }
  }
}

// ---------- Общее ----------

function horizontalDist2(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function nearest(enemies: Enemy[], from: Vector3, range: number): Enemy | null {
  let best: Enemy | null = null;
  let bestD = range * range;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d2 = horizontalDist2(e.node.position, from);
    if (d2 < bestD) {
      bestD = d2;
      best = e;
    }
  }
  return best;
}
