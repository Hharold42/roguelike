import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateCapsule } from "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { CharacterModel } from "./characterModel";
import { clamp, type MotionState } from "./motion";
import { WeaponStats } from "./weapon";

export type HeightFn = (x: number, z: number) => number;

const TURN_RATE = 14; // скорость доворота персонажа (1/с)
const HALF_HEIGHT = 1.0; // центр капсулы над ступнями

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
const CROUCH_COLLIDER = 0.35; // насколько ниже становится коллайдер
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

export class Player {
  /** Невидимый коллайдер-капсула: движение, коллизии, поворот. Модель — его дочерний узел. */
  readonly mesh: Mesh;
  model: CharacterModel | null = null;

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

  /** Состояние движения для анимации (обновляется в update) */
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

  constructor(scene: Scene, start: Vector3) {
    this.mesh = CreateCapsule("player", { height: 2, radius: 0.5 }, scene);
    this.mesh.position = start.clone();
    this.mesh.isVisible = false;
    this.mesh.isPickable = false;

    this.mesh.ellipsoid = new Vector3(0.5, HALF_HEIGHT, 0.5);
    this.mesh.checkCollisions = true;
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  /** В воздухе ли персонаж */
  get airborne(): boolean {
    return !this.grounded;
  }

  /** Степень приседа 0..1 */
  get crouchAmount(): number {
    return this.crouchT;
  }

  /** Точка, за которой следит камера: центр капсулы, в приседе — ниже */
  cameraAnchor(): Vector3 {
    const p = this.mesh.position;
    return new Vector3(p.x, p.y - this.crouchT * CAMERA_CROUCH_DROP, p.z);
  }

  /** Подвесить визуальную модель к коллайдеру (ноги модели — у нижней точки капсулы) */
  attachModel(model: CharacterModel): void {
    this.model?.dispose();
    this.model = model;
    model.root.parent = this.mesh;
    model.root.position.set(0, -HALF_HEIGHT, 0);
  }

  /**
   * Движение и поворот, опора на рельеф и верх стен, прыжок, реген.
   * moveDir — мировое горизонтальное направление движения (уже с учётом камеры) или null;
   * faceYaw — куда повернуться (рад) или null, чтобы оставить текущий поворот;
   * getFloor — высота опоры в точке (верх стены или рельеф);
   * actions — прыжок/присед.
   */
  update(dt: number, moveDir: Vector3 | null, faceYaw: number | null, getFloor: HeightFn, actions: PlayerActions = NO_ACTIONS): void {
    if (this.regen > 0 && this.hp > 0) {
      this.hp = Math.min(this.maxHp, this.hp + this.regen * dt);
    }
    const pos = this.mesh.position;

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
      const before = pos.clone();
      // Стены — коллайдеры: сбоку в блок не войти, но когда ступни выше его верха — проходим над ним
      this.mesh.moveWithCollisions(new Vector3(this.vel.x * dt, 0, this.vel.z * dt));
      // Фактическое смещение = скорость: упёрлись в стену — скорость гаснет, а не «давит» дальше
      if (dt > 0) {
        this.vel.x = (pos.x - before.x) / dt;
        this.vel.z = (pos.z - before.z) / dt;
      }
    }

    // --- Вертикаль. Опора — верх стены или рельеф под центром капсулы ---
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
      // Приземление на опору под центром капсулы — рельеф или верх стены
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

    // Коллайдер ниже в приседе
    this.mesh.ellipsoid.y = HALF_HEIGHT - CROUCH_COLLIDER * this.crouchT;

    // --- Плавный доворот по кратчайшей дуге ---
    let yawRate = 0;
    if (faceYaw !== null) {
      let delta = faceYaw - this.mesh.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const step = delta * Math.min(1, dt * TURN_RATE);
      this.mesh.rotation.y += step;
      if (dt > 0) yawRate = step / dt;
    }

    // --- Состояние для анимации: по фактической скорости, а не по нажатым клавишам ---
    const yaw = this.mesh.rotation.y;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const forwardSpeed = this.vel.x * fx + this.vel.z * fz;
    const sideSpeed = this.vel.x * fz - this.vel.z * fx; // вправо положительно
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const m = this.motion;
    m.moving = hSpeed > 0.3;
    // Идём спиной вперёд — ноги перебирают в обратную сторону
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

    this.model?.update(dt, m);
  }

  /** Направить оружие на мировую точку (после update) */
  aim(target: Vector3): void {
    this.model?.aim(target);
  }

  /** Замах оружейной руки вбок, рад (меч) */
  swing(angle: number): void {
    this.model?.swing(angle);
  }

  /** Откуда вылетают пули: срез ствола модели, иначе точка перед грудью */
  muzzle(): Vector3 {
    const m = this.model?.muzzle();
    if (m) return m;
    const yaw = this.mesh.rotation.y;
    return new Vector3(
      this.position.x + Math.sin(yaw) * 0.8,
      this.position.y + 0.3,
      this.position.z + Math.cos(yaw) * 0.8,
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
