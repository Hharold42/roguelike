/**
 * Математическая модель баланса и каталог улучшений/гаджетов.
 *
 * Идея: сила любого улучшения измеряется ОДНОЙ метрикой — преимуществом в дуэли
 * R = TTK_враг / TTK_я, где TTK — среднее время убийства (с) между двумя игроками.
 * R = 1 — равны, R = 1.04 — я убиваю на ~4% быстрее. Величина каждого улучшения
 * не «на глаз», а ВЫВОДИТСЯ из модели: решателем подбирается параметр (на сколько
 * ускорить, с каким шансом сработать) так, чтобы вклад был ровно равен бюджету
 * ступени (SLIGHT_BUDGET / NORMAL_BUDGET). Поэтому все улучшения одной ступени
 * равноценны, а изменение базовых цифр боя (game.ts) пересчитывает весь каталог.
 *
 * Модель времени убийства (на дистанции D):
 *   p      — вероятность попасть одним зарядом: erf(w / (2√2·σ)), w — ширина цели
 *            с учётом радиуса заряда, σ² = σ0² + (κ·v_цели·D/v_заряда)² — ошибка
 *            упреждения растёт со временем полёта, а значит падает со скоростью
 *            заряда и растёт со скоростью бега цели;
 *   n      — попаданий до убийства: (2 − доля попаданий в голову) + extraHits (щит);
 *   N, L   — магазин: выстрелов подряд до блокировки (с учётом реген) и блокировка;
 *   TTK    = (n/p)·f + (n/p)/N·L + D/v, f — интервал выстрела (затраты на
 *            перезарядку маны размазаны по выстрелам).
 * Итог R усредняется по дистанциям (ближний бой/средняя/дальняя) в логарифме.
 *
 * Модуль без DOM и Node-API: его читают сервер и клиент (HUD), а таблицу
 * баланса печатает scripts/balance.ts (npm run balance).
 */

import { BODY_R, BOLT_R, BOLT_SPEED, FIRE_COOLDOWN, MANA_COST, MANA_LOCK_TIME, MANA_MAX, MANA_REGEN } from "./game";

// ====================================================================
// Характеристики
// ====================================================================

export interface Stats {
  fireInterval: number;
  manaMax: number;
  manaCost: number;
  manaRegen: number;
  lockTime: number;
  boltSpeed: number;
  boltRadius: number;
  /** Множитель скорости бега */
  moveMul: number;
  // Вероятностные перки (шанс на выстрел)
  hitscanChance: number;
  echoChance: number;
  freeChance: number;
  bigChance: number;
  quickLockChance: number;
  /** Сколько лишних попаданий нужно врагу, чтобы убить (щит) */
  extraHits: number;
}

export const BASE_STATS: Readonly<Stats> = {
  fireInterval: FIRE_COOLDOWN,
  manaMax: MANA_MAX,
  manaCost: MANA_COST,
  manaRegen: MANA_REGEN,
  lockTime: MANA_LOCK_TIME,
  boltSpeed: BOLT_SPEED,
  boltRadius: BOLT_R,
  moveMul: 1,
  hitscanChance: 0,
  echoChance: 0,
  freeChance: 0,
  bigChance: 0,
  quickLockChance: 0,
  extraHits: 0,
};

/** Жёсткие пределы характеристик: защита сервера от вырожденных значений при любых сборках */
const LIMITS: Partial<Record<keyof Stats, [number, number]>> = {
  fireInterval: [0.1, 1],
  manaMax: [50, 250],
  manaCost: [4, 20],
  manaRegen: [0.5, 12],
  lockTime: [1, 6],
  boltSpeed: [20, 90],
  moveMul: [0.8, 1.8],
  // Шансы перков при стаках растут, но не доходят до «всегда»
  hitscanChance: [0, 0.6],
  echoChance: [0, 0.8],
  freeChance: [0, 0.8],
  bigChance: [0, 0.9],
  quickLockChance: [0, 0.9],
};

export function clampStats(s: Stats): Stats {
  for (const k of Object.keys(LIMITS) as (keyof Stats)[]) {
    const [lo, hi] = LIMITS[k]!;
    s[k] = Math.min(hi, Math.max(lo, s[k]));
  }
  return s;
}

// ====================================================================
// Механика перков (одинакова для сервера и модели)
// ====================================================================

export const HITSCAN_SPEED = 700; // «хитскан» = заряд такой скорости: долетает за доли тика
export const ECHO_DELAY = 0.12; // с до второго заряда эха
export const ECHO_COST_FACTOR = 0.5; // второй заряд эха стоит половину маны
export const BIG_RADIUS_MULT = 2.5; // крупный заряд: радиус попадания ×
export const QUICK_LOCK_FACTOR = 0.35; // быстрая блокировка: длится столько от обычной

// ====================================================================
// Модель времени убийства
// ====================================================================

const MODEL = {
  headFraction: 0.15, // доля попаданий в голову (убивает с одного)
  aimNoise: 0.15, // σ0: ошибка прицеливания без учёта упреждения, юниты
  leadError: 0.25, // κ: доля скорости цели, которую стрелок не предугадал
  baseMove: 6, // скорость бега, юнитов/с
  /** Дистанции боя и их вес в среднем */
  bands: [
    { d: 8, w: 0.3 },
    { d: 20, w: 0.45 },
    { d: 40, w: 0.25 },
  ],
};

/** erf — аппроксимация Абрамовица–Стегуна 7.1.26 (|ошибка| < 1.5e-7) */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** Вероятность попасть зарядом: радиус заряда, скорость (Infinity — мгновенно), дистанция, скорость бега цели */
function hitProb(radius: number, speed: number, dist: number, targetMove: number): number {
  const w = 2 * (BODY_R + radius);
  const flight = Number.isFinite(speed) ? dist / speed : 0;
  const sigma = Math.sqrt(MODEL.aimNoise ** 2 + (MODEL.leadError * MODEL.baseMove * targetMove * flight) ** 2);
  return erf(w / (2 * Math.SQRT2 * sigma));
}

/**
 * Магазин: сколько выстрелов подряд (дробное — гладко по параметрам) и какова
 * ожидаемая блокировка после него. Мана тратится по ожидаемой цене выстрела
 * (бесплатные выстрелы дешевле, эхо дороже), реген идёт, пока маны ≥ цены.
 */
export function magazine(s: Stats): { shots: number; lock: number; period: number } {
  const cEff = s.manaCost * (1 - s.freeChance) * (1 + ECHO_COST_FACTOR * s.echoChance);
  let mana = s.manaMax;
  let n = 0;
  for (let guard = 0; guard < 1000; guard++) {
    n++;
    mana -= cEff;
    if (mana < s.manaCost) break;
    mana = Math.min(s.manaMax, mana + s.manaRegen * s.fireInterval);
  }
  // Дробная часть: остаток маны после последнего выстрела — доля следующего
  const shots = n + Math.max(0, mana) / cEff;
  const lock = s.lockTime * (1 - s.quickLockChance * (1 - QUICK_LOCK_FACTOR));
  return { shots, lock, period: (shots - 1) * s.fireInterval + lock };
}

/** Среднее время убийства att → def на дистанции dist, с */
export function ttk(att: Stats, def: Stats, dist: number): number {
  const pNormal = hitProb(att.boltRadius, att.boltSpeed, dist, def.moveMul);
  const pHit = hitProb(att.boltRadius, Infinity, dist, def.moveMul);
  const pBig = hitProb(att.boltRadius * BIG_RADIUS_MULT, att.boltSpeed, dist, def.moveMul);
  const q = att.hitscanChance + att.bigChance;
  const p = (1 - q) * pNormal + att.hitscanChance * pHit + att.bigChance * pBig;
  const hits = 2 - MODEL.headFraction + def.extraHits;
  const events = hits / (p * (1 + att.echoChance)); // эхо — лишний заряд за тот же выстрел
  const mag = magazine(att);
  const flight = (1 - att.hitscanChance) * (dist / att.boltSpeed);
  return events * att.fireInterval + (events / mag.shots) * mag.lock + flight;
}

/** Преимущество в дуэли против базового игрока: R > 1 — убиваю быстрее, чем он меня */
export function duelAdvantage(me: Stats, enemy: Stats = BASE_STATS as Stats): number {
  let logR = 0;
  for (const { d, w } of MODEL.bands) logR += w * Math.log(ttk(enemy, me, d) / ttk(me, enemy, d));
  return Math.exp(logR);
}

/** Прибавка силы относительно базового игрока: 0.04 — «+4%» */
export function power(s: Stats): number {
  return duelAdvantage(s) - 1;
}

// ====================================================================
// Бюджеты и решатель
// ====================================================================

/** Вклад одной «лёгкой» стопки в R */
export const SLIGHT_BUDGET = 0.04;
/** Вклад «нормального» перка (за смерть) */
export const NORMAL_BUDGET = 0.09;
/** Лёгкие стопки: всего за жизнь и на одну характеристику (от вырождения в одну сторону) */
export const SLIGHT_MAX_STACKS = 5;
export const SLIGHT_MAX_PER_DEF = 3;
/** «Сила × секунды» гаджета: время действия выводится как бюджет / сила */
export const GADGET_BUDGET = 12;
/** Допущение для радара (не боевая характеристика, моделью не измеряется): эквивалент +30% к R */
export const RADAR_EQUIV_POWER = 0.3;

/** Решить f(x) = target на [lo, hi] бисекцией (f монотонно растёт); null — цель недостижима */
function solve(f: (x: number) => number, target: number, lo: number, hi: number): number | null {
  if (f(hi) < target) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const copy = (s: Readonly<Stats>): Stats => ({ ...s });

// ====================================================================
// Лёгкие улучшения (за убийство)
// ====================================================================

interface SlightRule {
  id: string;
  title: string;
  /** Применить стопку величины x (доля улучшения) к характеристикам */
  apply: (s: Stats, x: number) => void;
  /** Описание для HUD по рассчитанному x */
  desc: (x: number) => string;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

const SLIGHT_RULES: SlightRule[] = [
  { id: "rate", title: "Скорострельность", apply: (s, x) => (s.fireInterval /= 1 + x), desc: (x) => `выстрелы чаще на ${pct(x)}` },
  { id: "mana", title: "Ёмкость маны", apply: (s, x) => (s.manaMax *= 1 + x), desc: (x) => `мана +${pct(x)}` },
  { id: "regen", title: "Поток маны", apply: (s, x) => (s.manaRegen *= 1 + x), desc: (x) => `реген маны +${pct(x)}` },
  { id: "reload", title: "Быстрая перезарядка", apply: (s, x) => (s.lockTime *= 1 - x), desc: (x) => `блокировка короче на ${pct(x)}` },
  { id: "velocity", title: "Резвые заряды", apply: (s, x) => (s.boltSpeed *= 1 + x), desc: (x) => `скорость заряда +${pct(x)}` },
  { id: "thrift", title: "Экономный выстрел", apply: (s, x) => (s.manaCost *= 1 - x), desc: (x) => `выстрел дешевле на ${pct(x)}` },
  { id: "agility", title: "Лёгкие ноги", apply: (s, x) => (s.moveMul *= 1 + x), desc: (x) => `бег быстрее на ${pct(x)}` },
];

export interface SlightDef {
  id: string;
  title: string;
  /** Величина одной стопки, выведенная из бюджета */
  x: number;
  desc: string;
  /** Сколько R даёт одна стопка (проверка) */
  power: number;
  apply: (s: Stats) => void;
}

function buildSlight(): SlightDef[] {
  const out: SlightDef[] = [];
  for (const r of SLIGHT_RULES) {
    const x = solve(
      (v) => {
        const s = copy(BASE_STATS);
        r.apply(s, v);
        return power(clampStats(s));
      },
      SLIGHT_BUDGET,
      0,
      1,
    );
    if (x === null) continue; // характеристика слишком слабая, чтобы дать бюджет честно, — не в пуле
    const s = copy(BASE_STATS);
    r.apply(s, x);
    out.push({ id: r.id, title: r.title, x, desc: r.desc(x), power: power(clampStats(s)), apply: (t) => r.apply(t, x) });
  }
  return out;
}

export const SLIGHT_DEFS: SlightDef[] = buildSlight();

// ====================================================================
// Нормальные улучшения (за смерть): вероятностные перки
// ====================================================================

interface PerkRule {
  id: string;
  title: string;
  stat: keyof Pick<Stats, "hitscanChance" | "echoChance" | "freeChance" | "bigChance" | "quickLockChance">;
  desc: (n: number) => string;
}

const PERK_RULES: PerkRule[] = [
  { id: "hitscan", title: "Мгновенный разряд", stat: "hitscanChance", desc: (n) => `1 из ${n} зарядов летит мгновенно` },
  { id: "echo", title: "Эхо", stat: "echoChance", desc: (n) => `1 из ${n} выстрелов — второй заряд через ${Math.round(ECHO_DELAY * 1000)} мс (за ${pct(ECHO_COST_FACTOR)} маны)` },
  { id: "free", title: "Бесплатный заряд", stat: "freeChance", desc: (n) => `1 из ${n} выстрелов не тратит ману` },
  { id: "big", title: "Крупный заряд", stat: "bigChance", desc: (n) => `1 из ${n} зарядов в ${BIG_RADIUS_MULT} раза шире` },
  { id: "quick", title: "Вспышка маны", stat: "quickLockChance", desc: (n) => `1 из ${n} блокировок маны в ${Math.round(1 / QUICK_LOCK_FACTOR)} раза короче` },
];

export interface PerkDef {
  id: string;
  title: string;
  /** Шанс срабатывания на выстрел = 1/oneIn (oneIn — целое, как «1 к N»), выведен из бюджета */
  oneIn: number;
  chance: number;
  desc: string;
  power: number;
  apply: (s: Stats) => void;
}

function buildPerks(): PerkDef[] {
  const out: PerkDef[] = [];
  for (const r of PERK_RULES) {
    const q = solve(
      (v) => {
        const s = copy(BASE_STATS);
        s[r.stat] = v;
        return power(s);
      },
      NORMAL_BUDGET,
      0,
      0.95,
    );
    if (q === null) continue;
    const oneIn = Math.max(2, Math.round(1 / q)); // «1 к N» — целое N; фактический шанс пересчитан
    const chance = 1 / oneIn;
    const s = copy(BASE_STATS);
    s[r.stat] = chance;
    out.push({ id: r.id, title: r.title, oneIn, chance, desc: r.desc(oneIn), power: power(s), // Стаки: каждый такой перк — ещё один независимый бросок, шансы складываются как «хотя бы один сработал»
    apply: (t) => (t[r.stat] = 1 - (1 - t[r.stat]) * (1 - chance)) });
  }
  return out;
}

export const PERK_DEFS: PerkDef[] = buildPerks();

// ====================================================================
// Гаджеты (пассивки без влияния на стрельбу, мощные, но временные)
// ====================================================================

export interface GadgetDef {
  id: string;
  title: string;
  desc: string;
  /** Сила (R−1) пока гаджет действует */
  power: number;
  /** Время действия, с: бюджет / сила, в разумных пределах */
  duration: number;
  /** Влияние на характеристики (null — только клиентский эффект/особая логика) */
  apply: ((s: Stats) => void) | null;
}

const SPRINT_MUL = 1.35;

function gadgetDuration(pw: number): number {
  return Math.round(Math.min(60, Math.max(12, GADGET_BUDGET / pw)));
}

function buildGadgets(): GadgetDef[] {
  const sprint = copy(BASE_STATS);
  sprint.moveMul = SPRINT_MUL;
  const shield = copy(BASE_STATS);
  shield.extraHits = 1;
  const pSprint = power(sprint);
  const pShield = power(shield);
  return [
    {
      id: "radar",
      title: "Радар",
      desc: "раз в 3 с стрелки к двум ближайшим врагам",
      power: RADAR_EQUIV_POWER,
      duration: gadgetDuration(RADAR_EQUIV_POWER),
      apply: null,
    },
    {
      id: "sprint",
      title: "Скороход",
      desc: `бег быстрее на ${pct(SPRINT_MUL - 1)}`,
      power: pSprint,
      duration: gadgetDuration(pSprint),
      apply: (s) => (s.moveMul *= SPRINT_MUL),
    },
    {
      id: "shield",
      title: "Щит",
      desc: "поглощает следующее попадание целиком",
      power: pShield,
      // Щит сгорает от первого попадания — на карте ему отведено не больше этого времени
      duration: gadgetDuration(pShield),
      apply: null,
    },
  ];
}

export const GADGET_DEFS: GadgetDef[] = buildGadgets();

export const RADAR_INTERVAL = 3; // с между пингами
export const RADAR_COUNT = 2; // сколько ближайших врагов показывать
export const RADAR_SHOW = 1.4; // с стрелки держатся на экране

/** Гаджеты на карте: интервал появления, время жизни без подбора, радиус подбора */
export const GADGET_SPAWN_INTERVAL = 40;
export const GADGET_LIFETIME = 35;
export const GADGET_PICKUP_R = 1.8;
/** Гаджет возникает не ближе стольких юнитов от любого живого игрока и как можно ровнее по дальности для всех */
export const GADGET_MIN_DIST = 30;

// ====================================================================
// Сборка итоговых характеристик
// ====================================================================

export interface Loadout {
  /** Стопки лёгких улучшений по id */
  slight: Record<string, number>;
  /** Перки за смерти: копятся и не сбрасываются */
  perks: string[];
  gadget: string | null;
}

export const slightById = (id: string): SlightDef | undefined => SLIGHT_DEFS.find((d) => d.id === id);
export const perkById = (id: string): PerkDef | undefined => PERK_DEFS.find((d) => d.id === id);
export const gadgetById = (id: string): GadgetDef | undefined => GADGET_DEFS.find((d) => d.id === id);

/** Итоговые характеристики игрока по его набору улучшений */
export function computeStats(l: Loadout): Stats {
  const s = copy(BASE_STATS);
  for (const [id, n] of Object.entries(l.slight)) {
    const d = slightById(id);
    if (d) for (let i = 0; i < n; i++) d.apply(s);
  }
  for (const id of l.perks) perkById(id)?.apply(s);
  if (l.gadget) gadgetById(l.gadget)?.apply?.(s);
  return clampStats(s);
}

/** Всего лёгких стопок */
export function slightTotal(l: Loadout): number {
  return Object.values(l.slight).reduce((a, b) => a + b, 0);
}
