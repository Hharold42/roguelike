import type { Player } from "./player";

export interface UpgradeDef {
  id: string;
  title: string;
  desc: string;
  apply: (p: Player) => void;
  /** Откат одного применения — рецепты крафта тратят бафы как ингредиенты */
  undo: (p: Player) => void;
}

const HP_STEP = 25;
const RATE_MULT = 0.82;
const SPEED_MULT = 1.12;
const REGEN_STEP = 0.8;

/**
 * Пул улучшений, из которых игрок выбирает после каждого этапа.
 * Оружейные бафы меняют общие `player.weaponStats` — действуют на все оружия, в том числе купленные позже.
 */
export const UPGRADE_POOL: UpgradeDef[] = [
  {
    id: "hp",
    title: "Живучесть",
    desc: `+${HP_STEP} к макс. HP и лечение на ${HP_STEP}`,
    apply: (p) => {
      p.maxHp += HP_STEP;
      p.hp = Math.min(p.maxHp, p.hp + HP_STEP);
    },
    undo: (p) => {
      p.maxHp = Math.max(HP_STEP, p.maxHp - HP_STEP);
      p.hp = Math.min(p.hp, p.maxHp);
    },
  },
  {
    id: "rate",
    title: "Скорострельность",
    desc: "Все оружия стреляют на 18% быстрее",
    apply: (p) => {
      p.weaponStats.cooldownMult *= RATE_MULT;
    },
    undo: (p) => {
      p.weaponStats.cooldownMult /= RATE_MULT;
    },
  },
  {
    id: "dmg",
    title: "Тяжёлые снаряды",
    desc: "+1 к урону снарядов всех оружий",
    apply: (p) => {
      p.weaponStats.damage += 1;
    },
    undo: (p) => {
      p.weaponStats.damage = Math.max(1, p.weaponStats.damage - 1);
    },
  },
  {
    id: "speed",
    title: "Лёгкие ноги",
    desc: "+12% к скорости бега",
    apply: (p) => {
      p.speedMult *= SPEED_MULT;
    },
    undo: (p) => {
      p.speedMult /= SPEED_MULT;
    },
  },
  {
    id: "multi",
    title: "Мультивыстрел",
    desc: "+1 снаряд за выстрел (веером) у всех оружий",
    apply: (p) => {
      p.weaponStats.projectiles += 1;
    },
    undo: (p) => {
      p.weaponStats.projectiles = Math.max(1, p.weaponStats.projectiles - 1);
    },
  },
  {
    id: "regen",
    title: "Регенерация",
    desc: `+${REGEN_STEP} HP в секунду`,
    apply: (p) => {
      p.regen += REGEN_STEP;
    },
    undo: (p) => {
      p.regen = Math.max(0, p.regen - REGEN_STEP);
    },
  },
];

export function upgradeTitle(id: string): string {
  return UPGRADE_POOL.find((u) => u.id === id)?.title ?? id;
}

/** Случайные count различных улучшений */
export function rollUpgrades(count = 3): UpgradeDef[] {
  const pool = [...UPGRADE_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
