import type { HeldWeapon } from "./characterModel";
import { itemTitle, type ItemHost } from "./shopItems";
import { upgradeTitle } from "./upgrades";
import { GUN_PRESETS } from "./weapon";
import { weaponTitle, type WeaponId, type WeaponSystem } from "./weapons";

/**
 * Ингредиент рецепта. Бафы и предметы тратятся (их undo вызывается), оружие — забирается (revoke),
 * если не стоит keep (результат — улучшение этого же оружия).
 */
export type Ingredient =
  | { kind: "upgrade"; id: string; count?: number }
  | { kind: "item"; id: string; count?: number }
  | { kind: "weapon"; id: WeaponId; keep?: boolean }
  | { kind: "coupon"; count: number }
  /** Любое из автоматических оружий (тратится последнее полученное) */
  | { kind: "anyWeapon" };

/** Что крафту нужно от игры сверх предметов: автоматика и инвентарь */
export interface CraftHost extends ItemHost {
  weapons: WeaponSystem;
  upgradeCount(id: string): number;
  itemCount(id: string): number;
  coupons: number;
  /** Потратить ингредиент (Game откатывает баф/предмет и убирает оружие) */
  consume(ing: Ingredient): void;
  /** Тени для новых мешей автоматики после grant/makeSwarm */
  refreshShadows(): void;
}

export interface Recipe {
  id: string;
  title: string;
  desc: string;
  gold: number;
  /** Только для этого стартового оружия (само оружие не тратится) */
  onlyWeapon?: HeldWeapon;
  needs: Ingredient[];
  /** Уже скрафчено / больше недоступно — рецепт скрыт */
  done: (host: CraftHost) => boolean;
  craft: (host: CraftHost) => void;
}

const VAMPIRE_LIFESTEAL = 0.08;
const GRENADE_RADIUS = 2;
const DASH_STRIKE = 3;
const GREATSWORD_COOLDOWN_MULT = 1.6;
const GOLDRUSH_MAGNET = 100;

export const RECIPES: readonly Recipe[] = [
  // ---------- Пистолет ----------
  {
    id: "vampire",
    title: "Вампирские пули",
    desc: `${Math.round(VAMPIRE_LIFESTEAL * 100)} % урона пуль (в том числе дрона) лечит вас. Регенерация уходит в рецепт`,
    gold: 2500,
    onlyWeapon: "gun",
    needs: [{ kind: "upgrade", id: "regen" }],
    done: ({ player }) => player.weaponStats.bulletLifesteal > 0,
    craft: ({ player }) => {
      player.weaponStats.bulletLifesteal = VAMPIRE_LIFESTEAL;
    },
  },
  {
    id: "shotgun",
    title: "Дробовик",
    desc: "+5 пуль конусом 25°, дальность 12, урон ×0.6, кулдаун ×2. Пистолет становится дробовиком",
    gold: 1500,
    onlyWeapon: "gun",
    needs: [{ kind: "upgrade", id: "multi", count: 2 }],
    done: ({ gun }) => !gun || gun.preset !== GUN_PRESETS.pistol,
    craft: ({ gun }) => gun?.applyPreset(GUN_PRESETS.shotgun),
  },
  {
    id: "rifle",
    title: "Автомат",
    desc: "Кулдаун ×0.35, но ствол греется вдвое быстрее и разброс до 5°. Пистолет становится автоматом",
    gold: 1500,
    onlyWeapon: "gun",
    needs: [{ kind: "upgrade", id: "rate", count: 2 }],
    done: ({ gun }) => !gun || gun.preset !== GUN_PRESETS.pistol,
    craft: ({ gun }) => gun?.applyPreset(GUN_PRESETS.rifle),
  },
  {
    id: "grenade",
    title: "Гранатомёт",
    desc: `Каждая пуля взрывается радиусом ${GRENADE_RADIUS} при попадании. Мортира уходит в рецепт`,
    gold: 3000,
    onlyWeapon: "gun",
    needs: [{ kind: "weapon", id: "mortar" }],
    done: ({ player }) => player.weaponStats.bulletBlast > 0,
    craft: ({ player }) => {
      player.weaponStats.bulletBlast = GRENADE_RADIUS;
    },
  },

  // ---------- Меч ----------
  {
    id: "dashstrike",
    title: "Рывок-удар",
    desc: `Перед каждым ударом — рывок вперёд на ${DASH_STRIKE} (стены не пускают). Лёгкие ноги уходят в рецепт`,
    gold: 1500,
    onlyWeapon: "sword",
    needs: [{ kind: "upgrade", id: "speed" }],
    done: ({ sword }) => !sword || sword.dash > 0,
    craft: ({ sword }) => sword?.applyMods({ dash: DASH_STRIKE }),
  },
  {
    id: "thunder",
    title: "Громовой клинок",
    desc: "Каждое попадание меча гарантированно бьёт молнией по двум ближайшим. Молния уходит в рецепт",
    gold: 3000,
    onlyWeapon: "sword",
    needs: [{ kind: "weapon", id: "lightning" }],
    done: ({ player }) => player.weaponStats.thunderBlade,
    craft: ({ player, sword }) => {
      player.weaponStats.thunderBlade = true;
      sword?.applyMods({ title: "Громовой клинок" });
    },
  },
  {
    id: "greatsword",
    title: "Двуручник",
    desc: `Удар по полному кругу 360°, кулдаун ×${GREATSWORD_COOLDOWN_MULT}. Два «Тяжёлых снаряда» уходят в рецепт`,
    gold: 2000,
    onlyWeapon: "sword",
    needs: [{ kind: "upgrade", id: "dmg", count: 2 }],
    done: ({ sword }) => !sword || sword.arcDeg >= 360,
    craft: ({ sword }) => sword?.applyMods({ title: "Двуручник", arcDeg: 360, cooldownMult: GREATSWORD_COOLDOWN_MULT }),
  },

  // ---------- Автоматика ----------
  {
    id: "saw",
    title: "Пила",
    desc: "Четыре клинка на радиусе 4 и голубой бумеранг-пила. Бумеранг и клинки уходят в рецепт",
    gold: 2500,
    needs: [{ kind: "weapon", id: "boomerang" }, { kind: "weapon", id: "blades" }],
    done: ({ weapons }) => weapons.has("saw"),
    craft: (host) => {
      host.weapons.grant("saw", host.player);
      host.refreshShadows();
    },
  },
  {
    id: "swarm",
    title: "Рой",
    desc: "Летающий пистолет становится тремя дронами с уроном ×0.6 каждый. Мультивыстрел уходит в рецепт",
    gold: 2000,
    needs: [{ kind: "weapon", id: "drone", keep: true }, { kind: "upgrade", id: "multi" }],
    done: ({ weapons }) => weapons.crafted("drone"),
    craft: (host) => {
      host.weapons.makeSwarm(host.player);
      host.refreshShadows();
    },
  },
  {
    id: "core",
    title: "Ядро",
    desc: "Radiance радиусом 9, враги внутри промахиваются в 50 % случаев. Две «Живучести» уходят в рецепт",
    gold: 3500,
    needs: [{ kind: "weapon", id: "radiance", keep: true }, { kind: "upgrade", id: "hp", count: 2 }],
    done: ({ weapons }) => weapons.crafted("radiance"),
    craft: ({ weapons }) => weapons.makeCore(),
  },
  {
    id: "ion",
    title: "Ионная пушка",
    desc: "Взрывы мортиры оставляют электрическое поле на 3 с (урон ×0.75 каждые полсекунды). Молния уходит в рецепт",
    gold: 3000,
    needs: [{ kind: "weapon", id: "mortar", keep: true }, { kind: "weapon", id: "lightning" }],
    done: ({ weapons }) => weapons.crafted("mortar"),
    craft: ({ weapons }) => weapons.makeIon(),
  },

  // ---------- Предметы ----------
  {
    id: "aegis",
    title: "Аегис",
    desc: "Щит восстанавливает один заряд каждые 30 с, если зарядов нет. Щит и Каменная кожа уходят в рецепт",
    gold: 1000,
    needs: [{ kind: "item", id: "shield" }, { kind: "item", id: "stoneskin" }],
    done: ({ perks }) => perks.aegis,
    craft: ({ perks, player }) => {
      perks.aegis = true;
      player.shield = Math.max(player.shield, 1);
    },
  },
  {
    id: "goldrush",
    title: "Золотая лихорадка",
    desc: "Монеты летят к вам с любого расстояния, +1 золото с врага. Магнит и Жадность уходят в рецепт",
    gold: 1200,
    needs: [{ kind: "item", id: "magnet" }, { kind: "item", id: "greed" }],
    done: ({ perks }) => perks.goldRush,
    craft: (host) => {
      host.perks.goldRush = true;
      host.magnet(GOLDRUSH_MAGNET);
      host.player.goldBonus += 1;
    },
  },
  {
    id: "reforge",
    title: "Перековка",
    desc: "Последнее полученное автоматическое оружие меняется на случайное из ещё не полученных",
    gold: 500,
    needs: [{ kind: "anyWeapon" }, { kind: "coupon", count: 3 }],
    done: ({ weapons }) => weapons.available.length === 0,
    craft: (host) => {
      const pool = host.weapons.available;
      if (!pool.length) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      host.weapons.grant(pick.id, host.player);
      host.refreshShadows();
    },
  },
];

/** Читаемое имя ингредиента с количеством */
export function ingredientTitle(ing: Ingredient): string {
  switch (ing.kind) {
    case "upgrade":
      return (ing.count ?? 1) > 1 ? `${upgradeTitle(ing.id)} ×${ing.count}` : upgradeTitle(ing.id);
    case "item":
      return (ing.count ?? 1) > 1 ? `${itemTitle(ing.id)} ×${ing.count}` : itemTitle(ing.id);
    case "weapon":
      return weaponTitle(ing.id) + (ing.keep ? " (остаётся)" : "");
    case "coupon":
      return `Купон ×${ing.count}`;
    case "anyWeapon":
      return "Любое автоматическое оружие";
  }
}

/** Есть ли ингредиент у игрока */
export function hasIngredient(host: CraftHost, ing: Ingredient): boolean {
  switch (ing.kind) {
    case "upgrade":
      return host.upgradeCount(ing.id) >= (ing.count ?? 1);
    case "item":
      return host.itemCount(ing.id) >= (ing.count ?? 1);
    case "weapon":
      return host.weapons.has(ing.id);
    case "coupon":
      return host.coupons >= ing.count;
    case "anyWeapon":
      return host.weapons.owned.length > 0;
  }
}

/** Рецепты, которые вообще показываются: под стартовое оружие и ещё не сделанные */
export function visibleRecipes(host: CraftHost): Recipe[] {
  return RECIPES.filter((r) => (!r.onlyWeapon || r.onlyWeapon === host.primaryKind) && !r.done(host));
}

export function canCraft(host: CraftHost, r: Recipe): boolean {
  return host.player.gold >= r.gold && r.needs.every((ing) => hasIngredient(host, ing));
}

/** Списать золото и ингредиенты, применить результат. false — не хватает чего-то */
export function craft(host: CraftHost, r: Recipe): boolean {
  if (!canCraft(host, r)) return false;
  host.player.gold -= r.gold;
  for (const ing of r.needs) host.consume(ing);
  r.craft(host);
  return true;
}
