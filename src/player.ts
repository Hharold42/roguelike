import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { clamp, type MotionState } from "./motion";
import { WeaponStats } from "./weapon";

export type HeightFn = (x: number, z: number) => number;
/** Блокирует ли стена круг игрока (радиус PLAYER_RADIUS) в точке на заданной высоте ступней */
export type BlockFn = (x: number, z: number, feetY: number) => boolean;

const TURN_RATE = 14; // скорость доворота персонажа (1/с)
const HALF_HEIGHT = 1.0; // центр «капсулы» над ступнями
export const PLAYER_RADIUS = 0.45; // горизонтальный радиус круга коллизий со стенами

// --- Движение: скорость с инерцией, а не телепорт на dir*speed ---
const GROUND_ACCEL = 16; // 1/с: разгон до ~90% за 0.15 с
const GROUND_DECEL = 20; // остановка чуть резче разгона
const AIR_ACCEL = 4; // в воздухе подруливаем слабо — инерция прыжка сохраняется
const AIR_DRAG = 3; // отпустили клавиши в полёте — скорость плавно гаснет (можно «не долететь» до края)

// --- Прыжок ---
const JUMP_SPEED = 11.2; // высота при удержании ≈ v²/2g ≈ 2.2
const JUMP_CUT = 0.45; // отпустили пробел на взлёте — vy умножается: короткий прыжок ≈ 1 юнит
const GRAVITY_UP = 28; // взлёт мягче...
const GRAVITY_DOWN = 46; // ...падение резче: дуга не «лунная»
const APEX_VY = 1.6; // около вершины гравитация ослаблена — короткое «зависание»
const APEX_GRAVITY = 0.55;
const COYOTE_TIME = 0.1; // с после схода с края ещё можно прыгнуть
const JUMP_BUFFER = 0.12; // нажатие чуть раньше приземления не теряется
const STEP_DOWN = 0.5; // опора ушла ниже на столько за кадр — падаем (сошли с края блока)
const LAND_SNAP = 0.2; // приземляемся, если опора не дальше этого под ступнями при падении
const LAND_RECOVERY = 0.35; // с, амортизация после приземления
const LAND_ATTACK = 0.07; // с, за сколько амортизация набирает максимум
const LAND_SLOW = 0.45; // при жёстком приземлении горизонтальная скорость режется до этой доли

// --- Присед ---
const CROUCH_SPEED_MULT = 0.5;
const CROUCH_RATE = 10; // скорость перехода в присед и обратно (1/с)
const EYE_OFFSET = 0.85; // глаза над центром (ступни + 1.85 — чуть выше низкой стены 1.8)
const CAMERA_CROUCH_DROP = 0.45; // насколько опускается точка обзора в приседе

export interface PlayerActions {
  /** Нажат прыжок в этом кадре */
  jump: boolean;
  /** Прыжок удерживается (для переменной высоты) */
  jumpHeld: boolean;
  /** Удерживается присед */
  crouch: boolean;
}

const NO_ACTIONS: PlayerActions = { jump: false, jumpHeld: false, crouch: false };

/**
 * Игрок: точка (центр капсулы) + yaw. Вид от первого лица — модели нет,
 * коллизии со стенами — точная проверка круга против отрисованных колонн
 * стен (isBlocked приходит из game.ts) со скольжением по осям.
 */
export class Player {
  /** Центр капсулы (ступни = y − 1) */
  readonly position: Vector3;
  /** Куда смотрит корпус (= азимут камеры в первом лице), рад */
  yaw = 0;

  // --- Прокачиваемые статы (улучшения между этапами) ---
  hp = 100;
  maxHp = 100;
  speedMult = 1;
  regen = 0;
  /** Общие характеристики всех оружий (ручной пистолет, летающий, …): урон, мультивыстрел, скорострельность */
  readonly weaponStats = new WeaponStats();
  /** Собранное золото (валюта колеса фортуны) */
  gold = 0;
  /** Заряды щита: каждый поглощает один удар целиком */
  shield = 0;
  /** Доп. золото с каждого убитого врага */
  goldBonus = 0;

  private baseSpeed = 9;

  // --- Физика ---
  private vel = new Vector3(0, 0, 0); // горизонтальная скорость (y не используется)
  private vy = 0;
  private grounded = true;
  private airTime = 0;
  private coyote = 0;
  private jumpBuffer = 0;
  private jumpCut = false; // укорачивание прыжка уже применено
  private landImpulse = 0;
  private landT = Infinity;
  /** 0 — стоим, 1 — полный присед (сглажено) */
  private crouchT = 0;

  /** Состояние движения за кадр (камера-качание, вьюмодель) */
  readonly motion: MotionState = {
    moving: false,
    speed: 0,
    strafe: 0,
    airborne: false,
    vy: 0,
    airTime: 0,
    land: 0,
    crouch: 0,
    yawRate: 0,
  };

  constructor(start: Vector3) {
    this.position = start.clone();
  }

  /** В воздухе ли персонаж */
  get airborne(): boolean {
    return !this.grounded;
  }

  /** Степень приседа 0..1 */
  get crouchAmount(): number {
    return this.crouchT;
  }

  /** Высота глаз (мировая Y): центр + смещение, в приседе ниже, при приземлении — просадка */
  eyeY(): number {
    return this.position.y + EYE_OFFSET - this.crouchT * CAMERA_CROUCH_DROP - this.motion.land * 0.18;
  }

  /**
   * Движение и поворот, опора на рельеф и верх стен, прыжок, реген.
   * moveDir — мировое горизонтальное направление движения (уже с учётом камеры) или null;
   * faceYaw — куда повернуться (рад) или null, чтобы оставить текущий поворот;
   * getFloor — высота опоры в точке (верх стены или рельеф);
   * isBlocked — блокирует ли стена круг игрока в точке на высоте ступней;
   * actions — прыжок/присед.
   */
  update(
    dt: number,
    moveDir: Vector3 | null,
    faceYaw: number | null,
    getFloor: HeightFn,
    isBlocked: BlockFn,
    actions: PlayerActions = NO_ACTIONS,
  ): void {
    if (this.regen > 0 && this.hp > 0) {
      this.hp = Math.min(this.maxHp, this.hp + this.regen * dt);
    }
    const pos = this.position;

    // --- Присед: только на земле ---
    const wantCrouch = actions.crouch && this.grounded;
    this.crouchT += ((wantCrouch ? 1 : 0) - this.crouchT) * Math.min(1, dt * CROUCH_RATE);
    if (this.crouchT < 0.001) this.crouchT = 0;
    const maxSpeed = this.baseSpeed * this.speedMult * (1 - (1 - CROUCH_SPEED_MULT) * this.crouchT);

    // --- Горизонталь: скорость тянется к желаемой, в воздухе — медленно (инерция) ---
    const wantMove = moveDir !== null && moveDir.lengthSquared() > 1e-6;
    const desired = new Vector3(0, 0, 0);
    if (wantMove) {
      desired.copyFrom(moveDir!);
      desired.y = 0;
      desired.normalize().scaleInPlace(maxSpeed);
    }
    const rate = !this.grounded ? (wantMove ? AIR_ACCEL : AIR_DRAG) : wantMove ? GROUND_ACCEL : GROUND_DECEL;
    const k = Math.min(1, dt * rate);
    this.vel.x += (desired.x - this.vel.x) * k;
    this.vel.z += (desired.z - this.vel.z) * k;
    if (!wantMove && this.vel.lengthSquared() < 0.01) this.vel.set(0, 0, 0);

    if (this.vel.lengthSquared() > 0) {
      const stepX = this.vel.x * dt;
      const stepZ = this.vel.z * dt;
      const feet = pos.y - HALF_HEIGHT;
      // Полный ход, иначе скольжение вдоль стены по одной оси
      if (!isBlocked(pos.x + stepX, pos.z + stepZ, feet)) {
        pos.x += stepX;
        pos.z += stepZ;
      } else if (!isBlocked(pos.x + stepX, pos.z, feet)) {
        pos.x += stepX;
        this.vel.z = 0;
      } else if (!isBlocked(pos.x, pos.z + stepZ, feet)) {
        pos.z += stepZ;
        this.vel.x = 0;
      } else {
        this.vel.set(0, 0, 0);
      }
    }

    // --- Вертикаль. Опора — верх стены или рельеф под центром ---
    const floorY = getFloor(pos.x, pos.z) + HALF_HEIGHT;
    this.jumpBuffer = actions.jump ? JUMP_BUFFER : this.jumpBuffer - dt;
    if (this.grounded) {
      this.coyote = COYOTE_TIME;
      if (floorY < pos.y - STEP_DOWN) {
        // Сошли с края блока — падаем (coyote time позволяет ещё прыгнуть)
        this.grounded = false;
        this.vy = 0;
        this.airTime = 0;
      } else {
        // Склоны и мелкие ступеньки — прилипаем
        pos.y = floorY;
      }
    } else {
      this.coyote -= dt;
    }

    // Прыжок: с земли или в coyote-окне, нажатие из буфера
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      this.grounded = false;
      this.vy = JUMP_SPEED;
      this.airTime = 0;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.jumpCut = false;
      this.crouchT *= 0.5; // из приседа выпрямляемся рывком
    }

    if (!this.grounded) {
      this.airTime += dt;
      // Переменная высота: отпустили пробел на взлёте — прыжок короткий
      if (!this.jumpCut && !actions.jumpHeld && this.vy > 0) {
        this.vy *= JUMP_CUT;
        this.jumpCut = true;
      }
      let g = this.vy > 0 ? GRAVITY_UP : GRAVITY_DOWN;
      if (Math.abs(this.vy) < APEX_VY) g *= APEX_GRAVITY;
      this.vy -= g * dt;
      pos.y += this.vy * dt;
      // Приземление на опору под центром — рельеф или верх стены
      if (this.vy <= 0 && pos.y <= floorY + LAND_SNAP) {
        pos.y = floorY;
        this.grounded = true;
        this.landImpulse = clamp(-this.vy / 16, 0.2, 1);
        this.landT = 0;
        // Жёсткое приземление гасит разбег
        const keep = 1 - (1 - LAND_SLOW) * this.landImpulse;
        this.vel.scaleInPlace(keep);
        this.vy = 0;
      }
    }
    this.landT += dt;

    // --- Плавный доворот по кратчайшей дуге ---
    let yawRate = 0;
    if (faceYaw !== null) {
      let delta = faceYaw - this.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const step = delta * Math.min(1, dt * TURN_RATE);
      this.yaw += step;
      if (dt > 0) yawRate = step / dt;
    }

    // --- Состояние движения: по фактической скорости, а не по нажатым клавишам ---
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const forwardSpeed = this.vel.x * fx + this.vel.z * fz;
    const sideSpeed = this.vel.x * fz - this.vel.z * fx; // вправо положительно
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const m = this.motion;
    m.moving = hSpeed > 0.3;
    m.speed = forwardSpeed < -0.2 * hSpeed ? -hSpeed : hSpeed;
    m.strafe = clamp(sideSpeed / Math.max(1, this.baseSpeed * this.speedMult), -1, 1);
    m.airborne = !this.grounded;
    m.vy = this.vy;
    m.airTime = this.airTime;
    m.land =
      this.landT < LAND_ATTACK
        ? (this.landImpulse * this.landT) / LAND_ATTACK
        : this.landImpulse * Math.max(0, 1 - (this.landT - LAND_ATTACK) / (LAND_RECOVERY - LAND_ATTACK));
    m.crouch = this.crouchT;
    m.yawRate = yawRate;
  }

  /** Откуда вылетают пули: точка перед глазами по курсу */
  muzzle(): Vector3 {
    return new Vector3(
      this.position.x + Math.sin(this.yaw) * 0.5,
      this.eyeY(),
      this.position.z + Math.cos(this.yaw) * 0.5,
    );
  }

  /** Урон по игроку; заряд щита поглощает удар целиком. Возвращает true, если щит сработал */
  takeDamage(amount: number): boolean {
    if (amount <= 0) return false;
    if (this.shield > 0) {
      this.shield--;
      return true;
    }
    this.hp = Math.max(0, this.hp - amount);
    return false;
  }
}
