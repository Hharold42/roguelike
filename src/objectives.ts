/**
 * Цели этапов. План — это данные; выполнение и проверка условий — в game.ts.
 *
 * survive — продержаться до конца таймера (классический этап);
 * reach   — добраться до маяка, пока не вышло время (мир ведёт игрока через карту).
 */

export type ObjectiveType = "survive" | "reach";

export interface ObjectivePlan {
  type: ObjectiveType;
  /** Подпись цели в HUD и во флэше начала этапа */
  title: string;
  /** Секунд на этап */
  timeLimit: number;
  /** reach: маяк ставится на таком расстоянии от игрока (в момент начала этапа) */
  minDist: number;
  maxDist: number;
  /** reach: радиус засчитывания у маяка */
  radius: number;
  /** reach: золото за успех = bonusBase + bonusPerStage × номер этапа */
  bonusBase: number;
  bonusPerStage: number;
}

const SURVIVE_TIME = 30; // классический этап-выживание
const REACH_TIME = 75; // на дорогу к маяку — с запасом: путь ещё зачищают
const REACH_EVERY = 3; // каждый третий этап — маяк
const REACH_MIN_DIST = 70; // за краем загруженных чанков: идти через мир
const REACH_MAX_DIST = 100; // но не через полкарты
const REACH_RADIUS = 4;
const REACH_BONUS_BASE = 30;
const REACH_BONUS_PER_STAGE = 5;

/**
 * План этапа. Штурмы (каждый bossEvery) — всегда выживание: там и так есть чем заняться.
 * Из остальных каждый REACH_EVERY-й — маяк.
 */
export function planForStage(stage: number, bossEvery: number): ObjectivePlan {
  if (stage % bossEvery !== 0 && stage % REACH_EVERY === 0) {
    return {
      type: "reach",
      title: "Доберитесь до маяка",
      timeLimit: REACH_TIME,
      minDist: REACH_MIN_DIST,
      maxDist: REACH_MAX_DIST,
      radius: REACH_RADIUS,
      bonusBase: REACH_BONUS_BASE,
      bonusPerStage: REACH_BONUS_PER_STAGE,
    };
  }
  return {
    type: "survive",
    title: "Переживите этап",
    timeLimit: SURVIVE_TIME,
    minDist: 0,
    maxDist: 0,
    radius: 0,
    bonusBase: 0,
    bonusPerStage: 0,
  };
}
