import type { HeldWeapon } from "./characterModel";
import type { Player } from "./player";
import type { Gun, Sword } from "./weapon";

/**
 * Постоянные перки игрока, которые не живут в WeaponStats: их читает Game каждый кадр / на событиях.
 * Предметы магазина только выставляют поля; логика (ярость, шипы, второе дыхание…) — в game.ts.
 */
export interface Perks {
  /** Ярость: каждое убийство −3 % к кулдаунам на 5 с, до 10 стаков */
  rage: boolean;
  /** Охлаждение: убийство сбрасывает нагрев ствола на 3 с */
  cooling: boolean;
  /** Второе дыхание: один раз вместо смерти — 50 % HP */
  secondWind: boolean;
  /** Аегис (крафт): щит восстанавливается сам */
  aegis: boolean;
  /** Золотая лихорадка (крафт) — только флаг «уже есть» */
  goldRush: boolean;
  /** Доля отражённого урона (шипы) */
  thorns: number;
  /** Множитель входящего урона (каменная кожа: 0.85) */
  armor: number;
  /** HP за убийство (вампиризм) */
  vampirism: number;
  /** Доля пустых секторов на колесе (0.5; счастливая монета — 0.4 до первого пусто) */
  emptyShare: number;
  /** Веса оружий на колесе на следующее вращение (весы) */
  weaponWeightMult: number;
  /** Насколько дорожает каждое вращение */
  spinStep: number;
  /** Шанс боссов на следующем утешительном колесе (пробирка), null — обычный */
  bossChanceNext: number | null;
  /** Множитель золота с врага (кошелёк) */
  goldMult: number;
}

export function defaultPerks(spinStep: number): Perks {
  return {
    rage: false,
    cooling: false,
    secondWind: false,
    aegis: false,
    goldRush: false,
    thorns: 0,
    armor: 1,
    vampirism: 0,
    emptyShare: 0.5,
    weaponWeightMult: 1,
    spinStep,
    bossChanceNext: null,
    goldMult: 1,
  };
}

/** Что предмет может сделать с игрой — реализует Game */
export interface ItemHost {
  player: Player;
  perks: Perks;
  primaryKind: HeldWeapon;
  /** Оружие в руке (одно из двух — не null) */
  gun: Gun | null;
  sword: Sword | null;
  /** Убить всех врагов в радиусе от игрока; возвращает число убитых */
  killAround(radius: number): number;
  /** Замедлить всех врагов в радиусе (mult — множитель скорости) */
  slowAround(radius: number, mult: number, seconds: number): void;
  /** Временный баф (name — для HUD): apply сейчас, undo через seconds */
  timedBuff(name: string, seconds: number, apply: () => void, undo: () => void): void;
  /** Следующее вращение колеса бесплатно */
  freeSpin(): void;
  /** Умножить радиус притяжения монет */
  magnet(mult: number): void;
}

/**
 * Предмет колеса и/или магазина. weight — относительный шанс на колесе (0 — только в магазине);
 * price — цена в магазине (0 — только на колесе). undo — откат (рецепты тратят предмет как ингредиент);
 * предметы с undo учитываются в инвентаре. once — уникальный: пока owned(host), в магазине не продаётся.
 */
export interface ShopItem {
  id: string;
  title: string;
  desc: string;
  weight: number;
  price: number;
  /** Только для этого стартового оружия */
  requires?: HeldWeapon;
  once?: boolean;
  owned?: (host: ItemHost) => boolean;
  apply: (host: ItemHost) => void;
  undo?: (host: ItemHost) => void;
}

const ADRENALINE_TIME = 20; // с
const ADRENALINE_MULT = 0.7; // кулдауны всех оружий
const BOMB_RADIUS = 12;
const SHIELD_CHARGES = 3;
const MAGNET_MULT = 1.5;
const CRIT_STEP = 0.1;
const THORNS = 0.3;
const ARMOR_MULT = 0.85;
const ADRENKIT_HEAL = 30;
const ADRENKIT_TIME = 10;
const ADRENKIT_SPEED = 1.2;
const LUCKY_EMPTY_SHARE = 0.4;
const SCALES_MULT = 1.5;
const BUYOUT_STEP = 30;
const WALLET_MULT = 1.25;
const VIAL_BOSS_CHANCE = 0.1;
const FREEZE_RADIUS = 15;
const FREEZE_MULT = 0.3;
const FREEZE_TIME = 4;
export const COOLING_TIME = 3;
export const RAGE_STACK = 0.03;
export const RAGE_MAX = 10;
export const RAGE_TIME = 5;
export const AEGIS_RECHARGE = 30;
export const VIAL_GOLD_MULT = 3;

export const SHOP_ITEMS: readonly ShopItem[] = [
  // ---------- Колесо + магазин ----------
  {
    id: "medkit",
    title: "Аптечка",
    desc: "Лечит 50 HP",
    weight: 6,
    price: 60,
    apply: ({ player }) => {
      player.hp = Math.min(player.maxHp, player.hp + 50);
    },
  },
  {
    id: "heart",
    title: "Сердце",
    desc: "+20 к макс. HP и лечение на 20",
    weight: 4,
    price: 150,
    apply: ({ player }) => {
      player.maxHp += 20;
      player.hp = Math.min(player.maxHp, player.hp + 20);
    },
  },
  {
    id: "goldbag",
    title: "Мешок золота",
    desc: "+100 золота",
    weight: 5,
    price: 0,
    apply: ({ player }) => {
      player.gold += 100;
    },
  },
  {
    id: "boots",
    title: "Сапоги",
    desc: "+10% к скорости бега",
    weight: 4,
    price: 150,
    apply: ({ player }) => {
      player.speedMult *= 1.1;
    },
  },
  {
    id: "shield",
    title: "Щит",
    desc: `Поглощает следующие ${SHIELD_CHARGES} удара по игроку`,
    weight: 4,
    price: 120,
    apply: ({ player }) => {
      player.shield += SHIELD_CHARGES;
    },
    undo: ({ player }) => {
      player.shield = Math.max(0, player.shield - SHIELD_CHARGES);
    },
  },
  {
    id: "magnet",
    title: "Магнит",
    desc: `Монеты притягиваются с в ${MAGNET_MULT} раза большего расстояния`,
    weight: 3,
    price: 100,
    apply: (host) => host.magnet(MAGNET_MULT),
    undo: (host) => host.magnet(1 / MAGNET_MULT),
  },
  {
    id: "greed",
    title: "Жадность",
    desc: "+1 золото с каждого врага",
    weight: 3,
    price: 200,
    apply: ({ player }) => {
      player.goldBonus += 1;
    },
    undo: ({ player }) => {
      player.goldBonus = Math.max(0, player.goldBonus - 1);
    },
  },
  {
    id: "adrenaline",
    title: "Адреналин",
    desc: `Все оружия на 30% быстрее в течение ${ADRENALINE_TIME} с`,
    weight: 4,
    price: 90,
    apply: (host) =>
      host.timedBuff(
        "Адреналин",
        ADRENALINE_TIME,
        () => (host.player.weaponStats.cooldownMult *= ADRENALINE_MULT),
        () => (host.player.weaponStats.cooldownMult /= ADRENALINE_MULT),
      ),
  },
  {
    id: "bomb",
    title: "Бомба",
    desc: `Убивает всех врагов в радиусе ${BOMB_RADIUS} (золото выпадает)`,
    weight: 4,
    price: 120,
    apply: (host) => host.killAround(BOMB_RADIUS),
  },
  {
    id: "coupon",
    title: "Купон",
    desc: "Следующее вращение колеса бесплатно, или −50 % на одну покупку в магазине",
    weight: 3,
    price: 0,
    apply: (host) => host.freeSpin(),
  },

  // ---------- Только магазин: оружейные ----------
  {
    id: "crit",
    title: "Крит",
    desc: `+${Math.round(CRIT_STEP * 100)} % шанс критического удара (урон ×3) у всех оружий`,
    weight: 0,
    price: 250,
    apply: ({ player }) => {
      player.weaponStats.critChance = Math.min(1, player.weaponStats.critChance + CRIT_STEP);
    },
  },
  {
    id: "pierce",
    title: "Пробитие",
    desc: "Пули пробивают ещё одного врага (урон ×0.5 за каждое пробитие)",
    weight: 0,
    price: 250,
    requires: "gun",
    apply: ({ player }) => {
      player.weaponStats.pierce += 1;
    },
  },
  {
    id: "ricochet",
    title: "Рикошет",
    desc: "Пуля, попав в стену или землю, отскакивает в ближайшего врага",
    weight: 0,
    price: 200,
    requires: "gun",
    once: true,
    owned: ({ player }) => player.weaponStats.ricochet,
    apply: ({ player }) => {
      player.weaponStats.ricochet = true;
    },
  },
  {
    id: "rage",
    title: "Ярость",
    desc: `Каждое убийство −${Math.round(RAGE_STACK * 100)} % к кулдаунам на ${RAGE_TIME} с, до ${RAGE_MAX} стаков`,
    weight: 0,
    price: 250,
    once: true,
    owned: ({ perks }) => perks.rage,
    apply: ({ perks }) => {
      perks.rage = true;
    },
  },
  {
    id: "heavyblade",
    title: "Тяжёлый клинок",
    desc: "Сектор меча 180°, урон ×1.33, кулдаун ×1.3",
    weight: 0,
    price: 300,
    requires: "sword",
    once: true,
    owned: ({ sword }) => !!sword && sword.arcDeg >= 180,
    apply: ({ sword }) => sword?.applyMods({ title: "Тяжёлый клинок", arcDeg: 180, damageMult: 4 / 3, cooldownMult: 1.3 }),
  },
  {
    id: "cooling",
    title: "Охлаждение",
    desc: `Убийство сбрасывает нагрев ствола: ${COOLING_TIME} с без разброса`,
    weight: 0,
    price: 200,
    requires: "gun",
    once: true,
    owned: ({ perks }) => perks.cooling,
    apply: ({ perks }) => {
      perks.cooling = true;
    },
  },

  // ---------- Только магазин: живучесть ----------
  {
    id: "secondwind",
    title: "Второе дыхание",
    desc: "Один раз вместо смерти — 50 % HP и щит на один удар",
    weight: 0,
    price: 400,
    once: true,
    owned: ({ perks }) => perks.secondWind,
    apply: ({ perks }) => {
      perks.secondWind = true;
    },
  },
  {
    id: "thorns",
    title: "Шипы",
    desc: `${Math.round(THORNS * 100)} % полученного урона возвращается ударившему`,
    weight: 0,
    price: 250,
    once: true,
    owned: ({ perks }) => perks.thorns > 0,
    apply: ({ perks }) => {
      perks.thorns = THORNS;
    },
  },
  {
    id: "stoneskin",
    title: "Каменная кожа",
    desc: `−${Math.round((1 - ARMOR_MULT) * 100)} % входящего урона`,
    weight: 0,
    price: 300,
    apply: ({ perks }) => {
      perks.armor *= ARMOR_MULT;
    },
    undo: ({ perks }) => {
      perks.armor /= ARMOR_MULT;
    },
  },
  {
    id: "vampirism",
    title: "Вампиризм",
    desc: "+1 HP за каждое убийство",
    weight: 0,
    price: 200,
    apply: ({ perks }) => {
      perks.vampirism += 1;
    },
  },
  {
    id: "adrenkit",
    title: "Адреналиновая аптечка",
    desc: `Лечит ${ADRENKIT_HEAL} HP и +${Math.round((ADRENKIT_SPEED - 1) * 100)} % скорости на ${ADRENKIT_TIME} с`,
    weight: 0,
    price: 100,
    apply: (host) => {
      host.player.hp = Math.min(host.player.maxHp, host.player.hp + ADRENKIT_HEAL);
      host.timedBuff(
        "Адреналиновая аптечка",
        ADRENKIT_TIME,
        () => (host.player.speedMult *= ADRENKIT_SPEED),
        () => (host.player.speedMult /= ADRENKIT_SPEED),
      );
    },
  },

  // ---------- Только магазин: экономика и колесо ----------
  {
    id: "luckycoin",
    title: "Счастливая монета",
    desc: `Пустые секторы колеса сжимаются до ${Math.round(LUCKY_EMPTY_SHARE * 100)} % — до первого «пусто»`,
    weight: 0,
    price: 150,
    once: true,
    owned: ({ perks }) => perks.emptyShare < 0.5,
    apply: ({ perks }) => {
      perks.emptyShare = LUCKY_EMPTY_SHARE;
    },
  },
  {
    id: "scales",
    title: "Весы",
    desc: `Вес всех оружий на колесе ×${SCALES_MULT} на следующее вращение`,
    weight: 0,
    price: 150,
    once: true,
    owned: ({ perks }) => perks.weaponWeightMult > 1,
    apply: ({ perks }) => {
      perks.weaponWeightMult = SCALES_MULT;
    },
  },
  {
    id: "buyout",
    title: "Скупка",
    desc: `Цена вращения растёт на ${BUYOUT_STEP} вместо 50`,
    weight: 0,
    price: 200,
    once: true,
    owned: ({ perks }) => perks.spinStep <= BUYOUT_STEP,
    apply: ({ perks }) => {
      perks.spinStep = BUYOUT_STEP;
    },
  },
  {
    id: "wallet",
    title: "Кошелёк",
    desc: `Золото с врага ×${WALLET_MULT}`,
    weight: 0,
    price: 300,
    apply: ({ perks }) => {
      perks.goldMult *= WALLET_MULT;
    },
  },
  {
    id: "vial",
    title: "Пробирка",
    desc: `Следующее утешительное колесо: боссы с шансом ${Math.round(VIAL_BOSS_CHANCE * 100)} %, но несут ×${VIAL_GOLD_MULT} золота`,
    weight: 0,
    price: 150,
    once: true,
    owned: ({ perks }) => perks.bossChanceNext !== null,
    apply: ({ perks }) => {
      perks.bossChanceNext = VIAL_BOSS_CHANCE;
    },
  },
  {
    id: "freeze",
    title: "Заморозка",
    desc: `Все враги в радиусе ${FREEZE_RADIUS} замедляются до ${Math.round(FREEZE_MULT * 100)} % на ${FREEZE_TIME} с`,
    weight: 0,
    price: 100,
    apply: (host) => host.slowAround(FREEZE_RADIUS, FREEZE_MULT, FREEZE_TIME),
  },
];

export function itemTitle(id: string): string {
  return SHOP_ITEMS.find((it) => it.id === id)?.title ?? id;
}

/** Что можно купить сейчас: есть цена, подходит оружию, уникальное ещё не куплено */
export function purchasableItems(host: ItemHost): ShopItem[] {
  return SHOP_ITEMS.filter(
    (it) => it.price > 0 && (!it.requires || it.requires === host.primaryKind) && !(it.once && it.owned?.(host)),
  );
}
