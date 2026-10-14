/**
 * Общие правила игры: константы боя, геометрия хитбоксов, цвета игроков и
 * сетевой протокол. Модуль без DOM и Node-API — его читают и клиент (src/),
 * и сервер (server/gameServer.ts), поэтому числа боя живут только здесь.
 */

// ---------- Игрок ----------

export const MAX_HP = 100;
export const RESPAWN_TIME = 3; // с до возрождения после смерти

/** Глаза над ступнями стоя */
export const EYE_HEIGHT = 1.7;
/** На сколько опускаются глаза и вся верхняя часть тела в полном приседе */
export const CROUCH_DROP = 0.45;
/** Просадка глаз при самом жёстком приземлении (только камера) */
export const LAND_DROP = 0.18;

// ---------- Модель тела: цилиндр + сфера (она же хитбокс) ----------

export const BODY_R = 0.32; // радиус цилиндра-туловища
export const HEAD_R = 0.28; // радиус сферы-головы
export const HEAD_CY = 1.52; // центр сферы над ступнями стоя (макушка 1.8)
/** Верх цилиндра стоя — ровно низ сферы */
export const BODY_TOP = HEAD_CY - HEAD_R;

// ---------- Палочка и заряды ----------

export const DMG_BODY = 50; // попадание в цилиндр
export const DMG_HEAD = 150; // попадание в сферу (> MAX_HP: смерть с одного)
export const BOLT_SPEED = 42; // юнитов/с — у заряда настоящая скорость, хитскана нет
export const BOLT_R = 0.12; // радиус заряда для попаданий
export const BOLT_LIFE = 3.5; // с до исчезновения (≈ 150 юнитов полёта)
export const FIRE_COOLDOWN = 0.25; // с между выстрелами
export const AIM_DIST = 40; // заряд вылетает из руки и сходится с прицелом на этой дистанции

// ---------- Заряженный выстрел (ПКМ): луч-хитскан ----------

export const BEAM_CHARGE_TIME = 3; // с удержания до полного заряда
export const BEAM_DMG_MIN = 10; // урон и цена незаряженного выстрела
export const BEAM_DMG_MAX = 300;
export const BEAM_COST_MIN = 10;
export const BEAM_COST_MAX = 100;
export const BEAM_RANGE = 220; // юнитов; дальше мир заканчивается
export const BEAM_COOLDOWN_MIN = 0.25; // пауза после выстрела: от лёгкого...
export const BEAM_COOLDOWN_MAX = 1; // ...до полностью заряженного
/** Луч пробивает рельеф только при полном заряде */
export const BEAM_PIERCE_AT = 0.999;

/** Урон луча при заряде c (0..1): линейно от минимума к максимуму */
export const beamDamage = (c: number): number => BEAM_DMG_MIN + (BEAM_DMG_MAX - BEAM_DMG_MIN) * c;
/** Базовая цена маны при заряде c (до множителя «экономного выстрела») */
export const beamCost = (c: number): number => BEAM_COST_MIN + (BEAM_COST_MAX - BEAM_COST_MIN) * c;

// ---------- Мана ----------

export const MANA_MAX = 100;
export const MANA_COST = 10; // за выстрел
export const MANA_REGEN = 2.5; // в секунду, пока маны не меньше стоимости выстрела
export const MANA_LOCK_TIME = 3; // с: мана < 10 → через это время восстанавливается вся сразу

// ---------- Цвета: ротация К, С, Ж, затем их смеси ----------

export interface PlayerColor {
  name: string;
  rgb: [number, number, number]; // 0..1
}

export const PLAYER_COLORS: PlayerColor[] = [
  { name: "Красный", rgb: [0.92, 0.13, 0.1] },
  { name: "Синий", rgb: [0.15, 0.32, 0.96] },
  { name: "Жёлтый", rgb: [0.97, 0.86, 0.1] },
  { name: "Фиолетовый", rgb: [0.66, 0.2, 0.86] }, // красный + синий
  { name: "Оранжевый", rgb: [0.98, 0.5, 0.08] }, // красный + жёлтый
  { name: "Зелёный", rgb: [0.14, 0.78, 0.26] }, // синий + жёлтый
  { name: "Белый", rgb: [0.95, 0.95, 0.95] }, // все три
];

/** Цвет CSS (#rrggbb) по индексу палитры */
export function colorCss(index: number): string {
  const c = PLAYER_COLORS[index % PLAYER_COLORS.length].rgb;
  const h = (v: number): string => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

// ---------- Геометрия хитбоксов ----------

/** Центр сферы-головы и верх цилиндра зависят от приседа (0..1) */
export function headCenterY(feetY: number, crouch: number): number {
  return feetY + HEAD_CY - CROUCH_DROP * crouch;
}
export function bodyTopY(feetY: number, crouch: number): number {
  return feetY + BODY_TOP - CROUCH_DROP * crouch;
}

/** Куда смотрит игрок: единичный вектор по yaw (0 — вдоль +Z, дальше к +X) и pitch (> 0 — вверх) */
export function lookDir(yaw: number, pitch: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const cp = Math.cos(pitch);
  out[0] = Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = Math.cos(yaw) * cp;
  return out;
}

// ---------- Протокол ----------

/** Что клиент сообщает о себе (движение клиентское, бой — на сервере) */
export interface PoseMsg {
  x: number; // ступни
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number; // 0..1
}

export interface PlayerSnap {
  id: number;
  color: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  /** Управляется сервером (бот) */
  bot: boolean;
  /** Заряд луча 0..1 (0 — не заряжает): остальные видят свечение на палочке */
  chg: number;
}

/** Личное состояние получателя */
export interface MeSnap {
  hp: number;
  mana: number;
  /** Ёмкость маны с учётом улучшений */
  manaMax: number;
  /** Сколько секунд осталось до полного восстановления маны (0 — не заблокирован) */
  lock: number;
  /** Полная длина текущей блокировки (для прогресса) */
  lockTotal: number;
  alive: boolean;
  /** Секунд до возрождения (если мёртв) */
  respawn: number;
  /** Множитель скорости бега (улучшения, гаджеты) */
  moveMul: number;
  /** Лёгкие улучшения: стопки по id (за убийства, копятся) */
  slight: Record<string, number>;
  /** Нормальные улучшения за смерти (копятся) */
  perks: string[];
  /** Активный гаджет и сколько секунд ему осталось */
  gadget: { id: string; left: number } | null;
  /** Щит заряжен */
  shield: boolean;
  /** Заряд луча 0..1 (-1 — не заряжаю) */
  charge: number;
}

/** Гаджет, лежащий на карте */
export interface GadgetMsg {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  /** Секунд до исчезновения, если никто не подберёт */
  ttl: number;
}

export type HitPart = "head" | "body";

/** Максимум ботов на сервере */
export const MAX_BOTS = 7;

/** Команда хозяина (первого зашедшего игрока): добавить бота или убрать последнего */
export type ClientMsg =
  | ({ t: "pose" } & PoseMsg)
  | ({ t: "shoot" } & PoseMsg)
  /** ПКМ нажата: начать заряд луча (время заряда считает сервер) */
  | ({ t: "charge" } & PoseMsg)
  /** ПКМ отпущена: выстрелить лучом по набранному заряду */
  | ({ t: "release" } & PoseMsg)
  /** Заряд сорван (смерть, потеря фокуса) без выстрела */
  | { t: "cancel" }
  | { t: "bot"; op: "add" | "remove" };

export type ServerMsg =
  | { t: "welcome"; id: number; color: number; seed: number; spawn: { x: number; z: number } }
  | { t: "snap"; players: PlayerSnap[]; me: MeSnap }
  /** r — радиус заряда (крупный заряд шире обычного) */
  | { t: "shot"; id: number; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number }
  /** Заряд закончился: попал в игрока (part, victim) или в землю/по таймеру */
  /** Луч (заряженный выстрел): из руки в конечную точку; c — заряд 0..1, pierce — пробил рельеф */
  | { t: "beam"; owner: number; x: number; y: number; z: number; ex: number; ey: number; ez: number; c: number; pierce: boolean; big: boolean }
  | { t: "pend"; id: number; x: number; y: number; z: number; part: HitPart | null; victim: number }
  /** absorbed — попадание поглотил щит (урона нет) */
  | { t: "hit"; attacker: number; victim: number; part: HitPart; dmg: number; hp: number; absorbed: boolean }
  | { t: "kill"; killer: number; victim: number; part: HitPart }
  | { t: "spawn"; id: number; x: number; y: number; z: number }
  /** Улучшение получил именно этот игрок: slight — за убийство (stacks — сколько стопок), normal — за смерть,
   *  gadget — подобран гаджет, refill — лёгкие стопки на потолке, награда — полная мана */
  | { t: "upgrade"; tier: "slight" | "normal" | "gadget" | "refill"; id: string; stacks: number }
  /** Сработал вероятностный перк (только владельцу — для подсказки) */
  | { t: "proc"; id: string }
  /** Права хозяина: только он управляет ботами; при уходе хозяина права переходят следующему игроку */
  | { t: "host"; host: boolean }
  /** Сообщение сервера этому игроку (отказ команды и т. п.) */
  | { t: "note"; text: string }
  | ({ t: "gadget" } & GadgetMsg)
  /** Гаджет с карты исчез: by — кто подобрал (0 — истёк) */
  | { t: "gadgetEnd"; id: number; by: number };
