import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { Enemy } from "./enemy";
import type { Player } from "./player";
import type { WeaponStats } from "./weapon";

/**
 * Автоматические оружия, выпадающие с колеса фортуны. Каждое само выбирает цель и атакует,
 * урон считает от общих `WeaponStats` игрока — но по-разному: бумеранг и мортира берут
 * мультивыстрел как число снарядов, клинки — как число лезвий, скорострельность ускоряет всех.
 */
export interface AutoHooks {
  /** Попадание до урона — молния и т. п. */
  onHit: (enemy: Enemy, damage: number, point: Vector3) => void;
  onKill: (enemy: Enemy) => void;
  /** Высота опоры (земля или верх стены) */
  floorAt: (x: number, z: number) => number;
}

/** Урон врагу через хуки: крит по общим статам, onHit (молния), урон, убитого — в onKill */
function dealDamage(hooks: AutoHooks, stats: WeaponStats, e: Enemy, base: number, point: Vector3): void {
  const [dmg] = stats.roll(base);
  hooks.onHit(e, dmg, point);
  if (e.alive && e.takeDamage(dmg)) hooks.onKill(e);
}

function glowMat(scene: Scene, name: string, color: Color3): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color.scale(0.4);
  mat.specularColor = Color3.Black();
  mat.emissiveColor = color;
  return mat;
}

/** Пометить меш для GlowLayer (Game читает metadata.glow) */
function glowTag(mesh: Mesh, color: Color3): void {
  mesh.metadata = { ...(mesh.metadata ?? {}), glow: [color.r, color.g, color.b] };
}

// ---------- Взрывы (общий пул колец на земле) ----------

const BLAST_LIFE = 0.35;

interface Blast {
  mesh: Mesh;
  mat: StandardMaterial;
  life: number;
  radius: number;
}

/** Расходящееся кольцо на земле — взрыв мортиры, бомба из магазина */
export class BlastFx {
  private active: Blast[] = [];
  private free: Blast[] = [];

  constructor(private scene: Scene) {}

  show(x: number, y: number, z: number, radius: number, color = new Color3(1, 0.55, 0.15)): void {
    let b = this.free.pop();
    if (!b) {
      const mat = new StandardMaterial("blastMat", this.scene);
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      const mesh = CreateDisc("blast", { radius: 1, tessellation: 40 }, this.scene);
      mesh.rotation.x = Math.PI / 2;
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      b = { mesh, mat, life: 0, radius: 1 };
    }
    b.mat.emissiveColor = color;
    b.mesh.position.set(x, y + 0.08, z);
    b.mesh.scaling.setAll(radius * 0.3);
    b.mesh.setEnabled(true);
    b.life = BLAST_LIFE;
    b.radius = radius;
    this.active.push(b);
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.life -= dt;
      const t = 1 - Math.max(0, b.life / BLAST_LIFE);
      b.mesh.scaling.setAll(b.radius * (0.3 + 0.7 * Math.sqrt(t)));
      b.mat.alpha = 0.55 * (1 - t);
      if (b.life <= 0) {
        b.mesh.setEnabled(false);
        this.free.push(b);
        this.active.splice(i, 1);
      }
    }
  }
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
const BOOM_COLOR = new Color3(0.55, 1, 0.45);

interface Flight {
  root: TransformNode;
  pos: Vector3;
  dir: Vector3;
  out: number;
  traveled: number;
  returning: boolean;
  hit: Set<number>;
}

/**
 * Бумеранг: летит к ближайшему врагу, пробивая всех по пути, разворачивается и возвращается
 * к игроку, снова бьёт. Мультивыстрел бросает несколько веером.
 */
export interface BoomerangOptions {
  /** Цвет лопастей (Пила — цвет клинков) */
  color?: Color3;
  /** Множитель кулдауна */
  cooldownMult?: number;
}

export class Boomerang {
  private cooldown = 0;
  private flights: Flight[] = [];
  private free: TransformNode[] = [];
  private mat: StandardMaterial;
  private readonly color: Color3;
  private readonly cooldownMult: number;

  constructor(
    private scene: Scene,
    private stats: WeaponStats,
    private hooks: AutoHooks,
    opts: BoomerangOptions = {},
  ) {
    this.color = opts.color ?? BOOM_COLOR;
    this.cooldownMult = opts.cooldownMult ?? 1;
    this.mat = glowMat(scene, "boomMat", this.color);
  }

  dispose(): void {
    for (const f of this.flights) f.root.dispose();
    for (const r of this.free) r.dispose();
    this.flights.length = 0;
    this.free.length = 0;
    this.mat.dispose();
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
          this.release(i);
          continue;
        }
        f.dir.copyFrom(back.scaleInPlace(1 / d));
      }
      const step = BOOM_SPEED * dt;
      f.pos.addInPlace(f.dir.scale(step));
      f.traveled += step;
      if (!f.returning && f.traveled >= f.out) {
        f.returning = true;
        f.hit.clear(); // на обратном пути бьёт тех же ещё раз
      }
      // Высота: над опорой, чтобы не зарываться в холмы
      const wantY = this.hooks.floorAt(f.pos.x, f.pos.z) + BOOM_HEIGHT;
      f.pos.y += (wantY - f.pos.y) * Math.min(1, dt * 12);
      f.root.position.copyFrom(f.pos);
      f.root.rotation.y += BOOM_SPIN * dt;

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
      const root = this.free.pop() ?? this.buildMesh();
      root.setEnabled(true);
      root.position.copyFrom(origin);
      this.flights.push({ root, pos: origin.clone(), dir, out, traveled: 0, returning: false, hit: new Set() });
    }
  }

  /** Крестовина из двух лопастей — в полёте читается как вращающийся клинок */
  private buildMesh(): TransformNode {
    const root = new TransformNode("boomerang", this.scene);
    for (let k = 0; k < 2; k++) {
      const blade = CreateBox(`boomBlade${k}`, { width: 0.95, height: 0.05, depth: 0.16 }, this.scene);
      blade.material = this.mat;
      blade.rotation.y = (k * Math.PI) / 2;
      blade.isPickable = false;
      blade.parent = root;
      glowTag(blade, this.color);
    }
    return root;
  }

  private release(i: number): void {
    const f = this.flights[i];
    f.root.setEnabled(false);
    this.free.push(f.root);
    this.flights.splice(i, 1);
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
const BLADE_COLOR = new Color3(0.45, 0.85, 1);

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
  private blades: Mesh[] = [];
  private angle = 0;
  private time = 0;
  private lastHit = new Map<number, number>();
  private mat: StandardMaterial;
  baseCount: number;
  radius: number;

  constructor(
    private scene: Scene,
    private stats: WeaponStats,
    private hooks: AutoHooks,
    opts: BladesOptions = {},
  ) {
    this.baseCount = opts.baseCount ?? BLADE_BASE_COUNT;
    this.radius = opts.radius ?? BLADE_RADIUS;
    this.mat = glowMat(scene, "bladeMat", BLADE_COLOR);
  }

  dispose(): void {
    for (const b of this.blades) b.dispose();
    this.blades.length = 0;
    this.mat.dispose();
  }

  get count(): number {
    return this.baseCount + Math.max(0, this.stats.projectiles - 1);
  }

  get damage(): number {
    return Math.max(1, Math.round(this.stats.damage * BLADE_DAMAGE_MULT));
  }

  update(dt: number, player: Player, enemies: Enemy[]): void {
    this.time += dt;
    this.syncCount();
    this.angle += (BLADE_SPEED / this.stats.totalCooldownMult) * dt;
    const n = this.blades.length;
    const c = player.position;
    const y = c.y + BLADE_HEIGHT;
    const dmg = this.damage;
    for (let i = 0; i < n; i++) {
      const a = this.angle + (i / n) * Math.PI * 2;
      const bx = c.x + Math.cos(a) * this.radius;
      const bz = c.z + Math.sin(a) * this.radius;
      const blade = this.blades[i];
      blade.position.set(bx, y, bz);
      blade.rotation.y = -a; // лезвие по касательной
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

  private syncCount(): void {
    const want = this.count;
    while (this.blades.length < want) {
      const blade = CreateBox(`blade${this.blades.length}`, { width: 1.0, height: 0.05, depth: 0.22 }, this.scene);
      blade.material = this.mat;
      blade.isPickable = false;
      glowTag(blade, BLADE_COLOR);
      this.blades.push(blade);
    }
    while (this.blades.length > want) this.blades.pop()!.dispose();
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
const MORTAR_COLOR = new Color3(1, 0.55, 0.2);
// Ионная пушка (крафт): взрыв оставляет электрическое поле
const ION_LIFE = 3; // с
const ION_TICK = 0.5;
const ION_DAMAGE_MULT = 0.75; // от урона снаряда за тик
const ION_COLOR = new Color3(0.5, 0.8, 1);

interface Shell {
  mesh: Mesh;
  from: Vector3;
  to: Vector3;
  t: number;
}

interface IonField {
  mesh: Mesh;
  mat: StandardMaterial;
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
  private shells: Shell[] = [];
  private free: Mesh[] = [];
  private mat: StandardMaterial;
  private fields: IonField[] = [];
  private freeFields: IonField[] = [];
  /** Сколько взрывов прогремело (для тестов и статистики) */
  blasts = 0;
  /** Ионная пушка: взрыв оставляет поле */
  ion = false;

  constructor(
    private scene: Scene,
    private stats: WeaponStats,
    private hooks: AutoHooks,
    private fx: BlastFx,
  ) {
    this.mat = glowMat(scene, "shellMat", MORTAR_COLOR);
  }

  dispose(): void {
    for (const s of this.shells) s.mesh.dispose();
    for (const m of this.free) m.dispose();
    for (const f of [...this.fields, ...this.freeFields]) f.mesh.dispose();
    this.shells.length = 0;
    this.free.length = 0;
    this.fields.length = 0;
    this.freeFields.length = 0;
    this.mat.dispose();
  }

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
        s.mesh.setEnabled(false);
        this.free.push(s.mesh);
        this.shells.splice(i, 1);
        continue;
      }
      const p = Vector3.Lerp(s.from, s.to, s.t);
      p.y += MORTAR_ARC * 4 * s.t * (1 - s.t);
      s.mesh.position.copyFrom(p);
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
    let mesh = this.free.pop();
    if (!mesh) {
      mesh = CreateSphere("shell", { diameter: 0.34, segments: 8 }, this.scene);
      mesh.material = this.mat;
      mesh.isPickable = false;
      glowTag(mesh, MORTAR_COLOR);
    }
    mesh.setEnabled(true);
    mesh.position.copyFrom(from);
    this.shells.push({ mesh, from: from.clone(), to: to.clone(), t: 0 });
  }

  private explode(at: Vector3, enemies: Enemy[]): void {
    this.blasts++;
    this.fx.show(at.x, at.y, at.z, MORTAR_BLAST_R, MORTAR_COLOR);
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

  /** Электрическое поле на месте взрыва: голубой диск, пульсирует, бьёт всех внутри каждые ION_TICK */
  private spawnField(at: Vector3): void {
    let f = this.freeFields.pop();
    if (!f) {
      const mat = new StandardMaterial("ionMat", this.scene);
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.emissiveColor = ION_COLOR;
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      const mesh = CreateDisc("ionField", { radius: MORTAR_BLAST_R, tessellation: 40 }, this.scene);
      mesh.rotation.x = Math.PI / 2;
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      f = { mesh, mat, pos: at.clone(), life: 0, tick: 0 };
    }
    f.pos.copyFrom(at);
    f.life = ION_LIFE;
    f.tick = ION_TICK * 0.5;
    f.mesh.position.set(at.x, at.y + 0.1, at.z);
    f.mesh.setEnabled(true);
    this.fields.push(f);
  }

  private updateFields(dt: number, enemies: Enemy[]): void {
    const dmg = Math.max(1, Math.round(this.stats.damage * ION_DAMAGE_MULT));
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      f.life -= dt;
      f.tick -= dt;
      f.mat.alpha = (0.18 + 0.1 * Math.sin(f.life * 18)) * Math.min(1, f.life / 0.4);
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
      if (f.life <= 0) {
        f.mesh.setEnabled(false);
        this.freeFields.push(f);
        this.fields.splice(i, 1);
      }
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
