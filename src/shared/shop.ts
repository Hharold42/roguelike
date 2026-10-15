/**
 * Магазин: улучшения за монеты. Каталог общий для клиента (список и цены в
 * окне магазина) и сервера (проверка и списание). Куплено один раз — остаётся
 * навсегда, смерть не отнимает.
 */

import type { Stats } from "./balance";
import { CONE_DMG_MULT, CONE_EDGE_LOSS, FREEZE_BEAM, FREEZE_CONE_MAX, VAMP_HEAL } from "./game";

export interface ShopItem {
  id: string;
  title: string;
  desc: string;
  price: number;
}

/** Бонус «Лёгкая поступь»: множитель скорости бега */
export const SWIFT_MOVE_MUL = 1.12;
/** Бонус «Глубокий резервуар»: прибавка к ёмкости маны и множитель её восстановления */
export const DEEP_MANA_BONUS = 50;
export const DEEP_REGEN_MUL = 1.3;

export const SHOP_ITEMS: readonly ShopItem[] = [
  {
    id: "cone",
    title: "Конусный луч",
    desc: `Альтернативный выстрел бьёт конусом: урон ×${CONE_DMG_MULT}, задевает всех в конусе. Урон падает с дальностью (сечение шире) и с удалением от оси: на оси потерь по сечению нет, на границе −${Math.round(CONE_EDGE_LOSS * 100)}%`,
    price: 300,
  },
  {
    id: "freeze",
    title: "Остановка времени",
    desc: `Враг, в которого попал альтернативный выстрел, застывает на ${FREEZE_BEAM} с: не двигается (в воздухе тоже), не крутит камеру и не стреляет. С конусом заморозка слабеет так же, как урон, а попадание по оси вблизи держит ${FREEZE_CONE_MAX} с`,
    price: 400,
  },
  {
    id: "vamp",
    title: "Вампиризм",
    desc: `Каждое попадание лечит вас на ${Math.round(VAMP_HEAL * 100)}% нанесённого урона (не больше, чем осталось у врага)`,
    price: 250,
  },
  {
    id: "mana",
    title: "Глубокий резервуар",
    desc: `Запас маны +${DEEP_MANA_BONUS}, восстановление ×${DEEP_REGEN_MUL}: можно дольше заряжать луч и чаще стрелять`,
    price: 200,
  },
  {
    id: "swift",
    title: "Лёгкая поступь",
    desc: `Скорость бега +${Math.round((SWIFT_MOVE_MUL - 1) * 100)}%: проще догнать, уйти от луча и сменить укрытие`,
    price: 150,
  },
];

export const shopItemById = (id: string): ShopItem | undefined => SHOP_ITEMS.find((i) => i.id === id);

/** Применить купленное к характеристикам (после общего clamp — пределы перков на покупки не действуют) */
export function applyShopStats(s: Stats, owned: ReadonlySet<string>): void {
  if (owned.has("mana")) {
    s.manaMax += DEEP_MANA_BONUS;
    s.manaRegen *= DEEP_REGEN_MUL;
  }
  if (owned.has("swift")) s.moveMul *= SWIFT_MOVE_MUL;
}
