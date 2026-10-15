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

export const DMG_BODY = 70; // урон заряда вблизи (без затухания и крита)
/** Попадание в голову — крит: урон × столько (у заряда вблизи 140 > MAX_HP: смерть с одного) */
export const CRIT_MULT = 2;

/**
 * Затухание урона с дистанцией: до full — полный урон, дальше линейно до доли min
 * на дистанции far, и ниже min не опускается.
 */
export interface Falloff {
  full: number;
  far: number;
  min: number;
}
export const BOLT_FALLOFF: Falloff = { full: 12, far: 100, min: 0.4 };
/** У луча затухание заметно слабее: он хитскан и бьёт на любую дальность */
export const BEAM_FALLOFF: Falloff = { full: 25, far: 220, min: 0.8 };

/** Множитель урона 1..min для дистанции dist */
export function falloffMul(dist: number, f: Falloff): number {
  if (dist <= f.full) return 1;
  if (dist >= f.far) return f.min;
  return 1 - (1 - f.min) * ((dist - f.full) / (f.far - f.full));
}

/** Итоговый урон: база × затухание × крит за голову, целым */
export function hitDamage(base: number, part: "head" | "body", dist: number, f: Falloff): number {
  return Math.max(1, Math.round(base * falloffMul(dist, f) * (part === "head" ? CRIT_MULT : 1)));
}
export const BOLT_SPEED = 42; // юнитов/с — у заряда настоящая скорость, хитскана нет
export const BOLT_R = 0.12; // радиус заряда для попаданий
export const BOLT_LIFE = 3.5; // с до исчезновения (≈ 150 юнитов полёта)
export const FIRE_COOLDOWN = 0.25; // с между выстрелами
export const AIM_DIST = 40; // заряд вылетает из руки и сходится с прицелом на этой дистанции

// ---------- Заряженный выстрел (ПКМ): луч-хитскан ----------

export const BEAM_CHARGE_TIME = 3; // с удержания до полного заряда
export const BEAM_DMG_MIN = 20; // урон незаряженного выстрела (цена — BEAM_COST_MIN)
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

// ---------- Монеты ----------

export const COIN_FIXED = 100; // монет падает с убитого всегда
export const COIN_LOSS = 0.4; // и ещё такая доля его текущих монет (он их теряет)
export const COIN_TTL = 120; // с лежат на земле, пока не подобрали
export const COIN_PICK_R = 1.8; // радиус подбора, юниты

// ---------- Конусный луч (покупка в магазине) ----------

export const CONE_DMG_MULT = 5; // урон луча ×
export const CONE_R0 = 0.3; // радиус конуса у стрелка, юниты
/** Полуугол конуса: без заряда 15°, чем сильнее заряд, тем уже — до 20% (12° при полном) */
export const CONE_ANGLE_DEG = 15;
export const CONE_FOCUS = 0.2;
export const CONE_R_REF = 1.5; // до этого радиуса сечения дальность урон не режет, шире — обратно пропорционально
export const CONE_EDGE_LOSS = 0.9; // потеря урона на самой границе конуса (в центре — 0)
/** Радиус конуса на дистанции d при заряде c (0..1) */
export const coneTan = (c: number): number => Math.tan(((CONE_ANGLE_DEG * (1 - CONE_FOCUS * Math.min(1, Math.max(0, c)))) * Math.PI) / 180);
export const coneRadius = (d: number, c: number): number => CONE_R0 + d * coneTan(c);
/** Множитель по дальности: чем шире сечение конуса (радиус r) в точке попадания, тем слабее удар */
export const coneRangeFactor = (r: number): number => Math.min(1, CONE_R_REF / Math.max(r, 1e-3));
/**
 * Множитель по положению в сечении: rel = расстояние от оси / радиус сечения. На оси потерь
 * нет, на границе — CONE_EDGE_LOSS, между ними линейно.
 */
export const coneAxisFactor = (rel: number): number => 1 - CONE_EDGE_LOSS * Math.min(1, Math.max(0, rel));
/** Итоговая доля урона: по дальности × по удалению от оси */
export const coneFactor = (r: number, rel: number): number => coneRangeFactor(r) * coneAxisFactor(rel);

// ---------- Вампиризм (покупка в магазине) ----------

export const VAMP_HEAL = 0.3; // доля нанесённого урона, возвращаемая атакующему

// ---------- Остановка времени (покупка в магазине) ----------

export const FREEZE_BEAM = 0.5; // с: заморозка от обычного попадания альтернативным выстрелом
export const FREEZE_CONE_MAX = 1; // с: заморозка конусом при попадании ровно по оси вблизи
export const FREEZE_CONE_MIN = 0.15; // с: меньше этого конус не замораживает, если вообще задел

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
  /** Монеты в кармане */
  gold: number;
  /** Купленные в магазине улучшения (id из shop.ts) */
  shop: string[];
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
  | { t: "bot"; op: "add" | "remove" }
  /** Купить улучшение в магазине (сервер проверяет цену) */
  | { t: "buy"; id: string };

export type ServerMsg =
  | { t: "welcome"; id: number; color: number; seed: number; spawn: { x: number; z: number } }
  | { t: "snap"; players: PlayerSnap[]; me: MeSnap }
  /** r — радиус заряда (крупный заряд шире обычного) */
  | { t: "shot"; id: number; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number }
  /** Заряд закончился: попал в игрока (part, victim) или в землю/по таймеру */
  /** Луч (заряженный выстрел): из руки в конечную точку; c — заряд 0..1, pierce — пробил рельеф */
  | { t: "beam"; owner: number; x: number; y: number; z: number; ex: number; ey: number; ez: number; c: number; pierce: boolean; big: boolean; cone?: boolean }
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
  | { t: "gadgetEnd"; id: number; by: number }
  /** Монеты на земле (выпали с убитого) */
  | { t: "coin"; id: number; x: number; y: number; z: number; amount: number }
  /** Игрок застыл на dur секунд: не двигается, не поворачивает камеру и не стреляет */
  | { t: "freeze"; id: number; dur: number }
  /** Монеты исчезли: by — кто подобрал (0 — истекли) */
  | { t: "coinGone"; id: number; by: number; amount: number };
