/**
 * Состояние движения персонажа за кадр — то, что физика (Player) сообщает анимации (CharacterModel).
 * Анимация ничего не решает сама: она только читает эти числа.
 */
export interface MotionState {
  /** Есть заметная горизонтальная скорость */
  moving: boolean;
  /** Скорость вдоль взгляда, юнитов/с; отрицательная — идём спиной */
  speed: number;
  /** Боковая составляющая скорости, -1..1 от максимальной (вправо положительная) */
  strafe: number;
  /** В воздухе */
  airborne: boolean;
  /** Вертикальная скорость, юнитов/с */
  vy: number;
  /** Секунд с момента отрыва от земли */
  airTime: number;
  /** Импульс приземления 0..1: резко появляется в момент касания и гаснет за ~0.3 с */
  land: number;
  /** Присед 0..1 (сглаженный) */
  crouch: number;
  /** Скорость поворота корпуса, рад/с */
  yawRate: number;
}

export function idleState(): MotionState {
  return { moving: false, speed: 0, strafe: 0, airborne: false, vy: 0, airTime: 0, land: 0, crouch: 0, yawRate: 0 };
}

export function walkState(speed: number): MotionState {
  return { ...idleState(), moving: speed !== 0, speed };
}

/** Плавная ступенька 0..1 */
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
