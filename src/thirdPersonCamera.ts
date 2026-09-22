import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Terrain } from "./terrain";

const SENSITIVITY = 0.0022; // рад на пиксель мыши
const PITCH_MIN = -0.3; // чуть снизу
const PITCH_MAX = 1.35; // почти сверху
const DIST_MIN = 2;
const DIST_MAX = 14;
const DIST_DEFAULT = 6;
const ZOOM_STEP = 1.12; // множитель дистанции на один щелчок колеса
const TARGET_HEIGHT = 0.9; // точка, вокруг которой крутимся: над центром капсулы (плечи/голова)
const SHOULDER_OFFSET = 0.7; // сдвиг цели вправо: смотрим «через правое плечо», персонаж левее центра
const CLEARANCE = 0.35; // зазор камеры от земли и стен
const PROBE_STEP = 0.4; // шаг проверки перекрытий вдоль луча камеры
const FOLLOW_Y_RATE = 9; // 1/с: сглаживание вертикального следования (прыжки, ступеньки)
const FOLLOW_Y_SNAP = 4; // разрыв больше этого — телепорт, догоняем сразу

/**
 * Камера от третьего лица в духе Genshin: вращается мышью вокруг персонажа
 * (курсор захватывается по клику), колесо — дистанция, персонаж всегда в кадре.
 * Если между персонажем и камерой стена или склон — камера подтягивается ближе.
 */
export class ThirdPersonCamera {
  readonly camera: FreeCamera;
  /** Азимут камеры (куда смотрит «вперёд» по горизонтали), рад */
  yaw = 0;
  /** Подъём камеры над целью, рад */
  pitch = 0.4;

  private wantDistance = DIST_DEFAULT;
  private distance = DIST_DEFAULT;
  private readonly target = new Vector3();
  private followY = NaN;
  private readonly canvas: HTMLCanvasElement;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new FreeCamera("cam", new Vector3(0, 5, -6), scene);
    this.camera.minZ = 0.1;
    this.camera.fov = 0.9;

    canvas.addEventListener("mousemove", (e) => {
      // Захвачен курсор — вращаем всегда; иначе — только с зажатой ПКМ (запасной режим)
      if (!this.locked && !(e.buttons & 2)) return;
      this.yaw += e.movementX * SENSITIVITY;
      this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch + e.movementY * SENSITIVITY));
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const k = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        this.wantDistance = Math.min(DIST_MAX, Math.max(DIST_MIN, this.wantDistance * k));
      },
      { passive: false },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Захватить курсор (по клику игрока) */
  lock(): void {
    if (!this.locked) this.canvas.requestPointerLock?.();
  }

  /** Отпустить курсор (меню, смерть) */
  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Горизонтальное направление «вперёд» камеры (единичный вектор) */
  forward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Горизонтальное направление «вправо» камеры */
  right(): Vector3 {
    return new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Полное направление взгляда камеры (с наклоном) — для прицела */
  lookDirection(): Vector3 {
    return this.target.subtract(this.camera.position).normalize();
  }

  /**
   * Поставить камеру за персонажем с учётом рельефа и стен.
   * anchor — центр капсулы игрока.
   */
  update(dt: number, anchor: Vector3, terrain: Terrain): void {
    // Через плечо: цель смещена вправо от персонажа (в системе камеры)
    const r = this.right();
    // По вертикали цель догоняет игрока с запаздыванием: прыжок и приземление не дёргают камеру.
    // Большой разрыв (телепорт, первый кадр) — прыгаем сразу.
    const wantY = anchor.y + TARGET_HEIGHT;
    if (!Number.isFinite(this.followY) || Math.abs(wantY - this.followY) > FOLLOW_Y_SNAP) this.followY = wantY;
    else this.followY += (wantY - this.followY) * Math.min(1, dt * FOLLOW_Y_RATE);
    this.target.set(anchor.x + r.x * SHOULDER_OFFSET, this.followY, anchor.z + r.z * SHOULDER_OFFSET);

    // Направление от цели к камере
    const cp = Math.cos(this.pitch);
    const back = new Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);

    // Ищем первое перекрытие вдоль луча: земля/склон или стена выше камеры
    let maxDist = this.wantDistance;
    for (let d = PROBE_STEP; d <= this.wantDistance; d += PROBE_STEP) {
      const px = this.target.x + back.x * d;
      const py = this.target.y + back.y * d;
      const pz = this.target.z + back.z * d;
      const ground = terrain.getHeight(px, pz);
      const wallTop = terrain.wallTopAt(px, pz);
      if (py < ground + CLEARANCE || (wallTop !== null && py < wallTop + CLEARANCE)) {
        maxDist = Math.max(DIST_MIN * 0.5, d - PROBE_STEP);
        break;
      }
    }

    // Подтягиваемся быстро, отъезжаем обратно плавно
    const rate = maxDist < this.distance ? 25 : 6;
    this.distance += (maxDist - this.distance) * Math.min(1, dt * rate);

    this.camera.position.set(
      this.target.x + back.x * this.distance,
      this.target.y + back.y * this.distance,
      this.target.z + back.z * this.distance,
    );
    // Страховка от земли в самой точке камеры
    const g = terrain.getHeight(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < g + CLEARANCE) this.camera.position.y = g + CLEARANCE;
    this.camera.setTarget(this.target);
  }
}
