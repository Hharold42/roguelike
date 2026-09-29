import type { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { HeightFn } from "./player";
import type { BlockedFn } from "./crowd";
import { clamp } from "./motion";

/** Враг — человечек-спрайт; рост базовой модели, от которого считается масштаб */
const CHARACTER_HEIGHT = 2;
/** Базовый масштаб врага (меньше игрока) */
export const ENEMY_SCALE = 0.75;
const ELITE_SCALE = 1.35; // относительно обычного (≈ рост игрока)
const HIT_RADIUS = 0.35; // радиус капсулы попаданий при масштабе 1

const ATTACK_RANGE = 1.35; // горизонтальная дистанция удара от центра врага до центра игрока
const ATTACK_HEIGHT = 1.1; // разница высот ступней, при которой удар ещё достаёт (игрок на блоке — не достаёт)
const ATTACK_COOLDOWN = 1.1; // секунды между замахами
const ATTACK_WINDUP = 0.32; // замах: урон проходит в конце, если игрок всё ещё в зоне — можно отпрыгнуть

// --- Толпа: чтобы не шли колонной ---
const SURROUND_DIST = 9; // ближе этого идём не по полю, а обходим игрока на свой угол
const FAN_ANGLE = 0.75; // рад: на сколько враг смещает точку подхода от прямой на игрока
const JITTER_BIAS = 0.35; // постоянный боковой снос вдоль маршрута (у каждого свой)
const JITTER_WANDER = 0.3; // и качающийся
const SPEED_SPREAD = 0.2; // ±20 % к скорости — толпа растягивается

// --- Реакция на урон ---
const HIT_FLASH_TIME = 0.18; // с, вспышка красным

/** Статы врага — растут с номером этапа */
export interface EnemyStats {
  hp: number;
  speed: number;
  damage: number;
  tint: Color3;
  /** Золото за убийство */
  gold: number;
  /** Элитный: крупнее и ярче */
  elite?: boolean;
  /** Дополнительный множитель размера поверх обычного/элитного (боссы) */
  scale?: number;
}

/** Итоговый масштаб врага: базовый × элитный × множитель босса */
function enemyScale(stats: EnemyStats): number {
  return ENEMY_SCALE * (stats.elite ? ELITE_SCALE : 1) * (stats.scale ?? 1);
}

let nextId = 1;

/**
 * Преследователь: идёт к игроку, обходя стены, окружает и бьёт вблизи с замахом.
 * Рендер — спрайт (soft/renderer читает node.position, tint, walkPhase, attackK, flashK);
 * здесь только логика. `node` — лёгкий держатель позиции, чтобы не трогать все места,
 * где читается enemy.node.position.
 */
export class Enemy {
  readonly id = nextId++;
  /** Центр капсулы: движение. */
  readonly node = { position: new Vector3(0, 0, 0) };
  readonly elite: boolean;
  readonly gold: number;
  /** Тинт спрайта (из статов) */
  readonly tint: Color3;
  /** Итоговый масштаб (рост = 2 × scale) */
  readonly scale: number;
  alive = true;

  private hp: number;
  private speed: number;
  private damage: number;
  private attackTimer = 0;
  private windup = 0;
  /** Замедление: множитель скорости, пока slowT > 0 */
  private slowMult = 1;
  private slowT = 0;
  /** Вспышка от урона: остаток времени */
  private flashT = 0;
  /** Смещение центра капсулы над землёй (= половина роста) */
  private halfHeight: number;

  // Индивидуальность в толпе
  private sideBias: number;
  private wanderPhase: number;
  private wanderFreq: number;
  private fanSign: number;
  private time = 0;
  /** Фаза шага для спрайт-анимации: растёт с фактической скоростью */
  walkPhase = Math.random();

  constructor(pos: Vector3, stats: EnemyStats) {
    this.hp = stats.hp;
    this.speed = stats.speed * (1 + SPEED_SPREAD * (Math.random() * 2 - 1));
    this.damage = stats.damage;
    this.gold = stats.gold;
    this.elite = stats.elite === true;
    this.tint = stats.tint;
    this.scale = enemyScale(stats);
    this.halfHeight = (CHARACTER_HEIGHT / 2) * this.scale;

    this.sideBias = Math.random() * 2 - 1;
    this.wanderPhase = Math.random() * Math.PI * 2;
    this.wanderFreq = 0.5 + Math.random() * 0.8;
    this.fanSign = Math.random() < 0.5 ? -1 : 1;

    this.node.position.copyFrom(pos);
  }

  /** Прогресс замаха 0..1 (0 — не атакует) — спрайт атаки */
  get attackK(): number {
    return this.windup > 0 ? 1 - this.windup / ATTACK_WINDUP : 0;
  }

  /** Степень вспышки урона 0..1 — подмешивание красного в тинт */
  get flashK(): number {
    return this.flashT > 0 ? this.flashT / HIT_FLASH_TIME : 0;
  }

  /** Замедлить: скорость × mult на seconds (повторное — продлевает, множитель берётся сильнейший) */
  applySlow(mult: number, seconds: number): void {
    this.slowMult = this.slowT > 0 ? Math.min(this.slowMult, mult) : mult;
    this.slowT = Math.max(this.slowT, seconds);
  }

  /** Замедлен ли сейчас */
  get slowed(): boolean {
    return this.slowT > 0;
  }

  /** Радиус капсулы (для попаданий) */
  get hitRadius(): number {
    return HIT_RADIUS * this.scale;
  }

  /** Высота ступней в мире (центр минус половина роста) */
  get feetY(): number {
    return this.node.position.y - this.halfHeight;
  }

  /** Половина длины оси капсулы (между центрами полусфер) */
  get hitHalfAxis(): number {
    return Math.max(0.05, this.halfHeight - this.hitRadius);
  }

  /** Поставить врага на землю в мировой точке (x, z) */
  placeAt(x: number, groundY: number, z: number): void {
    this.node.position.set(x, groundY + this.halfHeight, z);
  }

  /**
   * Преследование по flow field (обход стен), вблизи — обход игрока на свой угол (окружение).
   * Удар — с замахом: урон проходит в конце ATTACK_WINDUP, если игрок ещё в зоне по горизонтали
   * И по высоте (стоя на блоке, игрок недостижим). Возвращает урон за кадр.
   * blocked — стена ли в точке: проверяем передний край капсулы, при упоре скользим вдоль стены.
   */
  update(
    dt: number,
    playerPos: Vector3,
    getHeight: HeightFn,
    flowDir: { x: number; z: number } | null,
    blocked: BlockedFn,
  ): number {
    if (!this.alive) return 0;
    this.time += dt;
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.slowT = Math.max(0, this.slowT - dt);
    this.flashT = Math.max(0, this.flashT - dt);

    const p = this.node.position;
    const dx = playerPos.x - p.x;
    const dz = playerPos.z - p.z;
    const dist = Math.hypot(dx, dz);
    // Высота ступней: игрок — центр капсулы минус 1, враг — минус halfHeight
    const feetDiff = Math.abs(playerPos.y - 1 - (p.y - this.halfHeight));
    const canReach = feetDiff <= ATTACK_HEIGHT;
    const inRange = dist <= ATTACK_RANGE + this.hitRadius;

    // Замах: урон в конце, если игрок не ушёл (в т. ч. не подпрыгнул)
    let dealt = 0;
    if (this.windup > 0) {
      this.windup -= dt;
      if (this.windup <= 0) {
        this.windup = 0;
        if (inRange && canReach) dealt = this.damage;
      }
    }

    const x0 = p.x;
    const z0 = p.z;

    if (inRange && canReach) {
      if (this.attackTimer <= 0 && this.windup <= 0) {
        this.attackTimer = ATTACK_COOLDOWN;
        this.windup = ATTACK_WINDUP;
      }
    } else if (this.windup <= 0 && dist > 0.001) {
      let mx: number;
      let mz: number;
      if (dist < SURROUND_DIST || !flowDir) {
        // Подходим не по прямой, а со своего угла — вместе с расталкиванием получается кольцо
        const fan = dist < SURROUND_DIST ? FAN_ANGLE * this.fanSign * clamp((dist - ATTACK_RANGE) / SURROUND_DIST, 0, 1) : 0;
        const a = Math.atan2(dx, dz) + fan;
        mx = Math.sin(a);
        mz = Math.cos(a);
      } else {
        // По полю, но со своим боковым сносом: толпа не сливается в колонну
        const jitter = JITTER_BIAS * this.sideBias + JITTER_WANDER * Math.sin(this.time * this.wanderFreq + this.wanderPhase);
        mx = flowDir.x - flowDir.z * jitter;
        mz = flowDir.z + flowDir.x * jitter;
        const len = Math.hypot(mx, mz) || 1;
        mx /= len;
        mz /= len;
      }
      const step = this.speed * (this.slowT > 0 ? this.slowMult : 1) * dt;
      const r = this.hitRadius;
      const nx = p.x + mx * step;
      const nz = p.z + mz * step;
      if (!blocked(nx + mx * r, nz + mz * r)) {
        p.x = nx;
        p.z = nz;
      } else if (!blocked(nx + Math.sign(mx) * r, p.z)) {
        p.x = nx; // скользим вдоль стены по X
      } else if (!blocked(p.x, nz + Math.sign(mz) * r)) {
        p.z = nz; // ...или по Z
      }
    }
    p.y = getHeight(p.x, p.z) + this.halfHeight;

    // Фаза шага — по фактической скорости, в «единицах роста»
    if (dt > 0) this.walkPhase += (Math.hypot(p.x - x0, p.z - z0) / dt / this.scale) * dt * 1.6;

    return dealt;
  }

  /** Возвращает true, если враг убит */
  takeDamage(amount: number): boolean {
    this.hp -= amount;
    if (this.hp <= 0) {
      this.kill();
      return true;
    }
    // Вспышка сразу на пике — иначе при быстрой стрельбе кадр без подсветки не даст её заметить
    this.flashT = HIT_FLASH_TIME;
    return false;
  }

  kill(): void {
    this.alive = false;
  }
}
