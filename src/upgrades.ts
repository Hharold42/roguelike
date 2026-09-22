import type { Player } from "./player";

export interface UpgradeDef {
  id: string;
  title: string;
  desc: string;
  apply: (p: Player) => void;
}

/**
 * Пул улучшений, из которых игрок выбирает после каждого этапа.
 * Оружейные бафы меняют общие `player.weaponStats` — действуют на все оружия, в том числе купленные позже.
 */
export const UPGRADE_POOL: UpgradeDef[] = [
  {
    id: "hp",
    title: "Живучесть",
    desc: "+25 к макс. HP и лечение на 25",
    apply: (p) => {
      p.maxHp += 25;
      p.hp = Math.min(p.maxHp, p.hp + 25);
    },
  },
  {
    id: "rate",
    title: "Скорострельность",
    desc: "Все оружия стреляют на 18% быстрее",
    apply: (p) => {
      p.weaponStats.cooldownMult *= 0.82;
    },
  },
  {
    id: "dmg",
    title: "Тяжёлые снаряды",
    desc: "+1 к урону снарядов всех оружий",
    apply: (p) => {
      p.weaponStats.damage += 1;
    },
  },
  {
    id: "speed",
    title: "Лёгкие ноги",
    desc: "+12% к скорости бега",
    apply: (p) => {
      p.speedMult *= 1.12;
    },
  },
  {
    id: "multi",
    title: "Мультивыстрел",
    desc: "+1 снаряд за выстрел (веером) у всех оружий",
    apply: (p) => {
      p.weaponStats.projectiles += 1;
    },
  },
  {
    id: "regen",
    title: "Регенерация",
    desc: "+0.8 HP в секунду",
    apply: (p) => {
      p.regen += 0.8;
    },
  },
];

/** Случайные count различных улучшений */
export function rollUpgrades(count = 3): UpgradeDef[] {
  const pool = [...UPGRADE_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
