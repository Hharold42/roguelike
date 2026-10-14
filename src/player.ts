/**
 * Игрок от первого лица: точка со ступнями на рельефе, стандартная
 * FPS-физика — разгон/торможение, гравитация с «не лунной» дугой прыжка,
 * coyote time и буфер прыжка, присед, спринт. Опора — рельеф и верх построек
 * (groundAt); стены построек не пускают (solidTopAt), если их верх выше ступни
 * больше чем на STEP_UP — низкие ступени проходятся пешком, низкие стенки
 * перепрыгиваются.
 * Позиция ограничена границами мира (невидимая стена на краю).
 */

import { clamp } from "./mathUtil";
import { CROUCH_DROP, EYE_HEIGHT, LAND_DROP } from "./shared/game";

export interface MoveInput {
  /** -1..1: вперёд/назад и вправо/влево (локальные, относительно yaw) */
  fwd: number;
  side: number;
  /** Нажали прыжок в этом кадре (фронт) */
  jump: boolean;
  /** Прыжок удерживается (для обрезки взлёта при отпускании) */
  jumpHeld: boolean;
  crouch: boolean;
  sprint: boolean;
}

export const BASE_SPEED = 6; // юнитов/с
export const SPRINT_MULT = 1.6;
export const CROUCH_MULT = 0.5;
export const GROUND_ACCEL = 16; // 1/с: разгон до ~90% за 0.15 с
const GROUND_DECEL = 20; // остановка чуть резче разгона
export const AIR_ACCEL = 4; // в воздухе подруливаем слабо — инерция прыжка сохраняется
const AIR_DRAG = 3;

export const JUMP_SPEED = 11.2; // высота при удержании ≈ v²/2g ≈ 2.2 ю
const JUMP_CUT = 0.45; // отпустили прыжок на взлёте — vy умножается: короткий прыжок
export const GRAVITY_UP = 28; // взлёт мягче...
export const GRAVITY_DOWN = 46; // ...падение резче: дуга не «лунная»
const APEX_VY = 1.6; // около вершины гравитация ослаблена — короткое «зависание»
const APEX_GRAVITY = 0.55;
const COYOTE_TIME = 0.1; // с после схода с края ещё можно прыгнуть
const JUMP_BUFFER = 0.12; // нажатие чуть раньше приземления не теряется
/** Радиус тела при столкновении с постройками */
export const COLLIDE_R = 0.35;
/** Выше этого от ступни стена не пускает (ступени лестницы — 0.4) */
export const STEP_UP = 0.55;
const STEP_DOWN = 0.5; // опора ушла ниже на столько за кадр — падаем (сошли с уступа)

const CROUCH_RATE = 10; // скорость перехода в присед и обратно (1/с)
const LAND_DIP_RISE = 24; // 1/с: просадка при приземлении нарастает за ~40 мс, а не рывком
const LAND_DIP_FALL = 10; // 1/с: и возвращается плавнее

export class Player {
  /** Ступни */
  x: number;
  y: number;
  z: number;
  /** Горизонтальная скорость в мировых осях (для инерции в воздухе) */
  vx = 0;
  vz = 0;
  vy = 0;
  onGround = true;
  /** Секунд в воздухе */
  airTime = 0;
  /** Импульс приземления 0..1, гаснет за ~0.3 с */
  land = 0;
  /** Сглаженная просадка приземления 0..1 для камеры (land — сырой импульс физики) */
  landDip = 0;
  /** Присед 0..1 (сглаженный) */
  crouch = 0;
  /** Множитель скорости бега от улучшений и гаджетов (его присылает сервер) */
  speedMul = 1;
  /** Фактические скорости вдоль взгляда и вбок (для анимации), юнитов/с */
  speedFwd = 0;
  speedSide = 0;

  private coyote = 0;
  private jumpBuf = 0;
  private prevJumpHeld = false;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** Поставить игрока в точку (возрождение): скорости и приседание обнуляются */
  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = this.vz = this.vy = 0;
    this.onGround = true;
    this.airTime = 0;
    this.land = this.landDip = this.crouch = 0;
  }

  /** Высота глаз над уровнем мира (присед и амортизация приземления опускают взгляд) */
  eyeY(): number {
    return this.y + EYE_HEIGHT - this.crouch * CROUCH_DROP - this.landDip * LAND_DROP;
  }

  /** Горизонтальная скорость (модуль) */
  speedH(): number {
    return Math.hypot(this.vx, this.vz);
  }

  /**
   * Шаг физики. groundAt(x, z) — высота опоры; bound — половина размера мира
   * (позиция клампится в ±bound). solidTopAt(x, z) — верх построек, расширенных
   * на радиус тела (−∞ если пусто): по осям отдельно, чтобы скользить вдоль стен.
   */
  update(
    dt: number,
    input: MoveInput,
    yaw: number,
    groundAt: (x: number, z: number) => number,
    bound: number,
    solidTopAt?: (x: number, z: number) => number,
  ): void {
    // Таймеры
    this.coyote = this.onGround ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    this.jumpBuf = input.jump ? JUMP_BUFFER : Math.max(0, this.jumpBuf - dt);
    this.land += (0 - this.land) * Math.min(1, dt / 0.3);
    this.landDip += (this.land - this.landDip) * Math.min(1, dt * (this.land > this.landDip ? LAND_DIP_RISE : LAND_DIP_FALL));
    this.crouch += ((input.crouch ? 1 : 0) - this.crouch) * Math.min(1, dt * CROUCH_RATE);

    // Целевая горизонтальная скорость в мировых осях
    const max = BASE_SPEED * this.speedMul * (input.sprint ? SPRINT_MULT : 1) * (1 - (1 - CROUCH_MULT) * this.crouch);
    const len = Math.hypot(input.fwd, input.side);
    const k = len > 1 ? 1 / len : 1;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const tx = (sy * input.fwd + cy * input.side) * k * max;
    const tz = (cy * input.fwd - sy * input.side) * k * max;

    // Разгон/торможение: на земле резко, в воздухе слабо (инерция)
    if (this.onGround) {
      const rate = len > 0.01 ? GROUND_ACCEL : GROUND_DECEL;
      const f = Math.min(1, rate * dt);
      this.vx += (tx - this.vx) * f;
      this.vz += (tz - this.vz) * f;
    } else {
      const f = Math.min(1, AIR_ACCEL * dt);
      this.vx += (tx - this.vx) * f;
      this.vz += (tz - this.vz) * f;
      if (len <= 0.01) {
        const d = Math.min(1, AIR_DRAG * dt);
        this.vx -= this.vx * d;
        this.vz -= this.vz * d;
      }
    }

    let nx = clamp(this.x + this.vx * dt, -bound, bound);
    let nz = clamp(this.z + this.vz * dt, -bound, bound);
    if (solidTopAt) {
      const reach = this.y + STEP_UP;
      // Уже внутри расширенного контура (приземлились вплотную) — не запираем, даём выйти
      if (solidTopAt(this.x, this.z) <= reach) {
        if (solidTopAt(nx, this.z) > reach) {
          nx = this.x;
          this.vx = 0;
        }
        if (solidTopAt(nx, nz) > reach) {
          nz = this.z;
          this.vz = 0;
        }
      }
    }
    this.x = nx;
    this.z = nz;

    // Прыжок: буфер + coyote
    if (this.jumpBuf > 0 && this.coyote > 0) {
      this.vy = JUMP_SPEED;
      this.onGround = false;
      this.coyote = 0;
      this.jumpBuf = 0;
      this.airTime = 0;
    }
    // Обрезка взлёта: отпустили клавишу прыжка на подъёме — скорость режется один раз
    if (!input.jumpHeld && this.prevJumpHeld && this.vy > 0) this.vy *= JUMP_CUT;
    this.prevJumpHeld = input.jumpHeld;

    const ground = groundAt(this.x, this.z);
    if (this.onGround) {
      const dy = ground - this.y;
      if (dy < -STEP_DOWN) {
        // Сошли с уступа — падаем
        this.onGround = false;
        this.airTime = 0;
        this.vy = 0;
      } else {
        this.y = ground; // склон или ступенька — идём по рельефу
      }
    }
    if (!this.onGround) {
      // Гравитация: взлёт мягче, падение резче, у вершины — короткое зависание
      let g = this.vy > 0 ? GRAVITY_UP : GRAVITY_DOWN;
      if (Math.abs(this.vy) < APEX_VY) g *= APEX_GRAVITY;
      this.vy -= g * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      if (this.vy <= 0 && this.y <= ground) {
        this.y = ground;
        this.onGround = true;
        this.land = clamp(-this.vy / 14, 0, 1);
        this.vy = 0;
      }
    }

    // Скорости в локальных осях взгляда — для анимации тела
    this.speedFwd = this.vx * sy + this.vz * cy;
    this.speedSide = this.vx * cy - this.vz * sy;
  }
}
