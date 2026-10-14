/**
 * Игровой сервер PvP: подключился — стал отдельным игроком.
 *
 * Модель авторитета: движение клиентское (клиент гоняет Player и шлёт позу),
 * а бой целиком на сервере — мана, перезарядка, полёт зарядов, попадания,
 * урон, смерти, возрождения, улучшения и гаджеты. Хитскана нет: выстрел рождает
 * заряд со скоростью, сервер двигает его по тикам (мелкими подшагами) и проверяет
 * отрезок пути на пересечение с хитбоксами (сфера-голова, цилиндр-туловище) и
 * землёй, так что быстрый заряд не «пролетает» сквозь игрока между тиками.
 * (Перк «Мгновенный разряд» — это заряд скоростью HITSCAN_SPEED, а не отдельный луч.)
 *
 * Прогрессия (числа — из src/shared/balance.ts, выведены из модели баланса):
 *   убил → лёгкое улучшение (стопка, копятся, до потолка),
 *   умер → ещё один нормальный вероятностный перк (копятся, повторы стакаются),
 *   всё набранное сохраняется после смерти,
 *   по карте появляются гаджеты — на равном удалении от всех игроков.
 *
 * Сервер живёт внутри dev/preview-сервера Vite (server/vitePlugin.ts).
 */

import type { WebSocket, WebSocketServer } from "ws";
import { Terrain } from "../src/terrain";
import { ColumnMap, WORLD_SIZE } from "../src/soft/columnMap";
import { segmentVsBody, type Hit } from "../src/shared/hitbox";
import { BotBrain } from "./bot";
import {
  AIM_DIST,
  BEAM_CHARGE_TIME,
  BEAM_COOLDOWN_MAX,
  BEAM_COOLDOWN_MIN,
  BEAM_COST_MIN,
  BEAM_PIERCE_AT,
  BEAM_RANGE,
  beamCost,
  beamDamage,
  BODY_R,
  BOLT_LIFE,
  CROUCH_DROP,
  DMG_BODY,
  DMG_HEAD,
  EYE_HEIGHT,
  HEAD_R,
  MAX_BOTS,
  MAX_HP,
  PLAYER_COLORS,
  RESPAWN_TIME,
  bodyTopY,
  headCenterY,
  lookDir,
  type ClientMsg,
  type GadgetMsg,
  type HitPart,
  type MeSnap,
  type PlayerSnap,
  type PoseMsg,
  type ServerMsg,
} from "../src/shared/game";
import {
  BASE_STATS,
  BIG_RADIUS_MULT,
  ECHO_COST_FACTOR,
  ECHO_DELAY,
  GADGET_DEFS,
  GADGET_LIFETIME,
  GADGET_MIN_DIST,
  GADGET_PICKUP_R,
  GADGET_SPAWN_INTERVAL,
  HITSCAN_SPEED,
  PERK_DEFS,
  QUICK_LOCK_FACTOR,
  SLIGHT_DEFS,
  SLIGHT_MAX_PER_DEF,
  SLIGHT_MAX_STACKS,
  computeStats,
  gadgetById,
  perkById,
  slightById,
  slightTotal,
  type Loadout,
  type Stats,
} from "../src/shared/balance";

const TICK_HZ = 30;
const WORLD_BOUND = WORLD_SIZE / 2 - 2; // та же невидимая стена, что у клиента
const SPAWN_MARGIN = 8; // подальше от края при возрождении
const BOLT_STEP = 1.2; // макс. длина подшага заряда, юниты (быстрые заряды дробятся)

interface PlayerState {
  id: number;
  /** null — бот (сокета нет) */
  ws: WebSocket | null;
  bot: BotBrain | null;
  color: number;
  // поза (от клиента)
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  // бой (авторитет сервера)
  hp: number;
  mana: number;
  /** > 0 — мана < стоимости выстрела; по истечении восстанавливается вся сразу */
  lock: number;
  lockTotal: number;
  cooldown: number;
  alive: boolean;
  respawn: number;
  kills: number;
  deaths: number;
  // прогрессия
  loadout: Loadout;
  stats: Stats;
  gadgetLeft: number;
  shield: boolean;
  /** Секунд до второго заряда «Эха» (< 0 — нет) */
  echoT: number;
  /** Идёт заряд луча (ПКМ удерживается); chargeT — набрано секунд */
  charging: boolean;
  chargeT: number;
  /** Секунд до второго луча «Эха» (< 0 — нет) и его заряд */
  beamEchoT: number;
  beamEchoC: number;
}

interface Bolt {
  id: number;
  owner: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  life: number;
}

interface WorldGadget extends GadgetMsg {
  ttl: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * Точка появления гаджета: одинаково далеко от всех живых игроков. Из набора
 * случайных кандидатов берётся тот, у кого минимален разброс дальностей
 * (max − min) при минимальной дальности не меньше minDist; одиночке — точка
 * на «прогулочной» дистанции. Если подходящих нет — самая далёкая от всех.
 */
export function pickGadgetSpot(
  players: readonly { x: number; z: number }[],
  bound: number,
  minDist = GADGET_MIN_DIST,
  candidates = 600,
  rnd: () => number = Math.random,
): { x: number; z: number; spread: number; minD: number } {
  let best: { x: number; z: number; spread: number; minD: number; score: number } | null = null;
  let fallback: { x: number; z: number; spread: number; minD: number; score: number } | null = null;
  for (let i = 0; i < candidates; i++) {
    const x = (rnd() * 2 - 1) * bound;
    const z = (rnd() * 2 - 1) * bound;
    let lo = Infinity;
    let hi = 0;
    for (const p of players) {
      const d = Math.hypot(p.x - x, p.z - z);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    if (!players.length) {
      lo = hi = 0;
    }
    const spread = hi - lo;
    // Одиночке слегка предпочитаем дистанцию ~45: достаточно далеко, чтобы бежать, и не на краю мира
    const score = spread + (players.length === 1 ? 0.02 * Math.abs(lo - 45) : 0);
    const cand = { x, z, spread, minD: lo, score };
    if (lo >= minDist && (!best || score < best.score)) best = cand;
    if (!fallback || lo > fallback.minD) fallback = cand;
  }
  const r = best ?? fallback!;
  return { x: r.x, z: r.z, spread: r.spread, minD: r.minD };
}

export class GameServer {
  readonly seed: number;
  private readonly map: ColumnMap;
  private readonly players = new Map<number, PlayerState>();
  private bolts: Bolt[] = [];
  private nextPlayerId = 1;
  private nextBoltId = 1;
  private nextGadgetId = 1;
  private colorCursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  /** Время сервера, с (монотонно; для ботов) */
  private clock = 0;
  /** id хозяина — первого зашедшего человека: только он управляет ботами */
  private hostId = 0;
  private gadget: WorldGadget | null = null;
  private gadgetTimer = GADGET_SPAWN_INTERVAL;

  constructor(seed?: number) {
    this.seed = seed ?? Math.floor(Math.random() * 1e9);
    const terrain = new Terrain(this.seed);
    this.map = new ColumnMap(terrain);
    this.map.bakeWorld();
  }

  /** Подписаться на подключения WebSocket-сервера и запустить тики */
  attach(wss: WebSocketServer): void {
    wss.on("connection", (ws) => this.onConnect(ws));
    if (!this.timer) {
      this.lastTick = Date.now();
      this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- Подключения ----------

  /** Цвет по ротации К → С → Ж → смеси; занятые пропускаем, пока есть свободные */
  private pickColor(): number {
    const n = PLAYER_COLORS.length;
    const used = new Set<number>();
    for (const p of this.players.values()) used.add(p.color);
    let c = this.colorCursor % n;
    for (let i = 0; i < n && used.has(c); i++) c = (c + 1) % n;
    this.colorCursor = c + 1;
    return c;
  }

  /** Новый игрок (человек с сокетом или бот без него) в лучшей точке появления */
  private createPlayer(ws: WebSocket | null): PlayerState {
    const spawn = this.pickSpawn();
    const loadout: Loadout = { slight: {}, perks: [], gadget: null };
    const p: PlayerState = {
      id: this.nextPlayerId++,
      ws,
      bot: null,
      color: this.pickColor(),
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      pitch: 0,
      crouch: 0,
      hp: MAX_HP,
      mana: BASE_STATS.manaMax,
      lock: 0,
      lockTotal: 0,
      cooldown: 0,
      alive: true,
      respawn: 0,
      kills: 0,
      deaths: 0,
      loadout,
      stats: computeStats(loadout),
      gadgetLeft: 0,
      shield: false,
      echoT: -1,
      charging: false,
      chargeT: 0,
      beamEchoT: -1,
      beamEchoC: 0,
    };
    this.players.set(p.id, p);
    console.info(`[game] +${ws ? "игрок" : "бот"} #${p.id} (${PLAYER_COLORS[p.color].name}), всего ${this.players.size}`);
    return p;
  }

  private onConnect(ws: WebSocket): void {
    const p = this.createPlayer(ws);
    // Первый зашедший (или первый после ухода хозяина) становится хозяином: он управляет ботами
    if (!this.players.has(this.hostId)) this.hostId = p.id;
    this.send(p, { t: "welcome", id: p.id, color: p.color, seed: this.seed, spawn: { x: p.x, z: p.z } });
    this.send(p, { t: "host", host: p.id === this.hostId });
    if (this.gadget) this.send(p, { t: "gadget", ...this.gadget });

    ws.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.onMessage(p, msg);
    });
    const drop = (): void => {
      if (!this.players.delete(p.id)) return;
      console.info(`[game] -игрок #${p.id}, осталось ${this.players.size}`);
      this.afterHumanLeft(p.id);
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  /** Ушёл человек: права хозяина — следующему по порядку; людей не осталось — боты уходят */
  private afterHumanLeft(leftId: number): void {
    const humans = [...this.players.values()].filter((q) => !q.bot);
    if (humans.length === 0) {
      for (const q of [...this.players.values()]) this.players.delete(q.id);
      this.hostId = 0;
      console.info("[game] людей не осталось — боты убраны");
      return;
    }
    if (leftId === this.hostId) {
      const next = humans.reduce((a, b) => (a.id < b.id ? a : b));
      this.hostId = next.id;
      this.send(next, { t: "host", host: true });
      this.send(next, { t: "note", text: "Вы теперь хозяин: B — добавить бота, N — убрать" });
    }
  }

  private onMessage(p: PlayerState, msg: ClientMsg): void {
    if (!msg) return;
    if (msg.t === "bot") {
      this.onBotCommand(p, msg.op);
      return;
    }
    if (msg.t === "cancel") {
      p.charging = false;
      return;
    }
    if (msg.t !== "pose" && msg.t !== "shoot" && msg.t !== "charge" && msg.t !== "release") return;
    if (!p.alive || !this.applyPose(p, msg)) return;
    if (msg.t === "shoot") this.tryShoot(p);
    else if (msg.t === "charge") this.startCharge(p);
    else if (msg.t === "release") this.releaseCharge(p);
  }

  // ---------- Боты ----------

  private botCount(): number {
    let n = 0;
    for (const q of this.players.values()) if (q.bot) n++;
    return n;
  }

  private onBotCommand(p: PlayerState, op: unknown): void {
    if (p.id !== this.hostId) {
      this.send(p, { t: "note", text: "Ботами управляет только хозяин сервера" });
      return;
    }
    if (op === "add") {
      if (this.botCount() >= MAX_BOTS) {
        this.send(p, { t: "note", text: `Ботов уже максимум (${MAX_BOTS})` });
        return;
      }
      const b = this.createPlayer(null);
      // Небольшой разброс мастерства: реакции и точность у ботов чуть разные
      b.bot = new BotBrain(b.x, b.y, b.z, 0.8 + Math.random() * 0.17);
    } else if (op === "remove") {
      let last: PlayerState | null = null;
      for (const q of this.players.values()) if (q.bot) last = q;
      if (!last) {
        this.send(p, { t: "note", text: "Ботов нет" });
        return;
      }
      this.players.delete(last.id);
      console.info(`[game] -бот #${last.id}, осталось ${this.players.size}`);
    }
  }

  /** Тик ботов: мозг решает, куда идти и стрелять ли; сервер применяет это как позу и выстрел */
  private tickBots(dt: number): void {
    const bodies = [...this.players.values()];
    for (const p of bodies) {
      if (!p.bot || !p.alive) continue;
      const out = p.bot.update(dt, {
        now: this.clock,
        selfId: p.id,
        self: { hp: p.hp, mana: p.mana, lock: p.lock, cooldown: p.cooldown, manaCost: p.stats.manaCost, boltSpeed: p.stats.boltSpeed, moveMul: p.stats.moveMul },
        enemies: bodies.filter((q) => q !== p && q.alive),
        bolts: this.bolts,
        gadget: this.gadget,
        groundAt: (x, z) => this.map.heightAt(x, z),
        bound: WORLD_BOUND,
      });
      p.x = out.x;
      p.y = out.y;
      p.z = out.z;
      p.yaw = out.yaw;
      p.pitch = out.pitch;
      p.crouch = out.crouch;
      if (out.shoot) this.tryShoot(p);
    }
  }

  /** Принять позу клиента с проверкой чисел и границ мира */
  private applyPose(p: PlayerState, m: PoseMsg): boolean {
    if (![m.x, m.y, m.z, m.yaw, m.pitch, m.crouch].every(finite)) return false;
    p.x = clamp(m.x, -WORLD_BOUND, WORLD_BOUND);
    p.z = clamp(m.z, -WORLD_BOUND, WORLD_BOUND);
    p.y = clamp(m.y, -50, 50);
    p.yaw = m.yaw;
    p.pitch = clamp(m.pitch, -1.6, 1.6);
    p.crouch = clamp(m.crouch, 0, 1);
    return true;
  }

  // ---------- Улучшения ----------

  /** Пересчитать характеристики; выросшая ёмкость маны сразу заполнена */
  private recompute(p: PlayerState): void {
    const oldMax = p.stats.manaMax;
    p.stats = computeStats(p.loadout);
    if (p.stats.manaMax > oldMax) p.mana += p.stats.manaMax - oldMax;
    p.mana = Math.min(p.mana, p.stats.manaMax);
  }

  /** Награда за убийство: случайная лёгкая стопка; на потолке — полная мана */
  private rewardKill(p: PlayerState): void {
    const l = p.loadout;
    const open = SLIGHT_DEFS.filter((d) => (l.slight[d.id] ?? 0) < SLIGHT_MAX_PER_DEF);
    if (slightTotal(l) >= SLIGHT_MAX_STACKS || open.length === 0) {
      p.mana = p.stats.manaMax;
      p.lock = 0;
      this.send(p, { t: "upgrade", tier: "refill", id: "", stacks: 0 });
      return;
    }
    const def = pick(open);
    l.slight[def.id] = (l.slight[def.id] ?? 0) + 1;
    this.recompute(p);
    this.send(p, { t: "upgrade", tier: "slight", id: def.id, stacks: l.slight[def.id] });
  }

  /**
   * Смерть: ничего не теряется (лёгкие стопки, перки и гаджет остаются), а к ним
   * добавляется ещё один случайный нормальный перк. Повторный перк — это стак:
   * шанс срабатывания растёт (до предела в clampStats).
   */
  private rewardDeath(p: PlayerState): void {
    const l = p.loadout;
    p.beamEchoT = -1;
    p.echoT = -1; // недолетевшее «эхо» с прошлой жизни не стреляет после возрождения
    const def = pick(PERK_DEFS);
    l.perks.push(def.id);
    this.send(p, { t: "upgrade", tier: "normal", id: def.id, stacks: l.perks.filter((id) => id === def.id).length });
    this.recompute(p);
  }

  // ---------- Гаджеты на карте ----------

  private spawnGadget(): void {
    const alive = [...this.players.values()].filter((q) => q.alive);
    if (alive.length === 0) return; // некому — подождём
    const spot = pickGadgetSpot(alive, WORLD_BOUND - 6);
    const def = pick(GADGET_DEFS);
    this.gadget = { id: this.nextGadgetId++, kind: def.id, x: spot.x, y: this.map.heightAt(spot.x, spot.z), z: spot.z, ttl: GADGET_LIFETIME };
    console.info(`[game] гаджет «${def.title}» в (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}), разброс дальностей ${spot.spread.toFixed(1)} ю, ближайший игрок ${spot.minD.toFixed(0)} ю`);
    this.broadcast({ t: "gadget", ...this.gadget });
  }

  private endGadget(by: number): void {
    if (!this.gadget) return;
    this.broadcast({ t: "gadgetEnd", id: this.gadget.id, by });
    this.gadget = null;
    this.gadgetTimer = GADGET_SPAWN_INTERVAL;
  }

  private tickGadgets(dt: number): void {
    // Действующие у игроков
    for (const p of this.players.values()) {
      if (p.loadout.gadget && p.alive) {
        p.gadgetLeft -= dt;
        if (p.gadgetLeft <= 0) {
          p.loadout.gadget = null;
          p.gadgetLeft = 0;
          p.shield = false;
          this.recompute(p);
        }
      }
    }
    // На карте
    if (!this.gadget) {
      this.gadgetTimer -= dt;
      if (this.gadgetTimer <= 0) {
        this.gadgetTimer = GADGET_SPAWN_INTERVAL;
        this.spawnGadget();
      }
      return;
    }
    this.gadget.ttl -= dt;
    if (this.gadget.ttl <= 0) {
      this.endGadget(0);
      return;
    }
    // Подбор: ближайший из вошедших в радиус
    let taker: PlayerState | null = null;
    let best = GADGET_PICKUP_R;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - this.gadget.x, p.z - this.gadget.z);
      if (d < best && Math.abs(p.y - this.gadget.y) < 3) {
        best = d;
        taker = p;
      }
    }
    if (taker) {
      const def = gadgetById(this.gadget.kind);
      if (def) {
        taker.loadout.gadget = def.id;
        taker.gadgetLeft = def.duration;
        taker.shield = def.id === "shield";
        this.recompute(taker);
        this.send(taker, { t: "upgrade", tier: "gadget", id: def.id, stacks: 1 });
      }
      this.endGadget(taker.id);
    }
  }

  // ---------- Мана и выстрел ----------

  /**
   * Мана: пока её не меньше стоимости выстрела — растёт на manaRegen в секунду.
   * Упала ниже — выстрелы закрыты, и ровно через lockTotal она возвращается
   * сразу вся.
   */
  private updateMana(p: PlayerState, dt: number): void {
    const st = p.stats;
    if (p.lock > 0) {
      p.lock -= dt;
      if (p.lock <= 0) {
        p.lock = 0;
        p.mana = st.manaMax;
      }
    } else if (p.mana >= st.manaCost) {
      p.mana = Math.min(st.manaMax, p.mana + st.manaRegen * dt);
    }
  }

  /** Бросок кубика перка: сработал — владельцу уходит подсказка */
  private roll(p: PlayerState, chance: number, id: string): boolean {
    if (chance <= 0 || Math.random() >= chance) return false;
    this.send(p, { t: "proc", id });
    return true;
  }

  /** После траты маны: упала ниже стоимости выстрела — блокировка (может оказаться «вспышкой») */
  private afterSpend(p: PlayerState): void {
    if (p.mana >= p.stats.manaCost) return;
    const quick = this.roll(p, p.stats.quickLockChance, "quick");
    p.lockTotal = p.stats.lockTime * (quick ? QUICK_LOCK_FACTOR : 1);
    p.lock = p.lockTotal;
  }

  private tryShoot(p: PlayerState): void {
    const st = p.stats;
    if (p.charging || p.cooldown > 0 || p.lock > 0 || p.mana < st.manaCost) return; // пока заряжается луч, заряды не летят
    p.cooldown = st.fireInterval;
    if (!this.roll(p, st.freeChance, "free")) p.mana -= st.manaCost;
    this.afterSpend(p);

    const hitscan = this.roll(p, st.hitscanChance, "hitscan");
    const big = this.roll(p, st.bigChance, "big");
    this.spawnBolt(p, hitscan ? HITSCAN_SPEED : st.boltSpeed, big ? st.boltRadius * BIG_RADIUS_MULT : st.boltRadius);
    if (this.roll(p, st.echoChance, "echo")) p.echoT = ECHO_DELAY;
  }

  /** Второй заряд «Эха»: за часть маны, из текущей позы; пропускается, если маны нет или идёт блокировка */
  private fireEcho(p: PlayerState): void {
    const st = p.stats;
    const cost = st.manaCost * ECHO_COST_FACTOR;
    if (!p.alive || p.lock > 0 || p.mana < cost) return;
    p.mana -= cost;
    this.afterSpend(p);
    this.spawnBolt(p, st.boltSpeed, st.boltRadius);
  }

  private spawnBolt(p: PlayerState, speed: number, radius: number): void {
    // Заряд вылетает из руки (справа-снизу от глаз) и сходится с прицелом на AIM_DIST
    const eyeY = p.y + EYE_HEIGHT - CROUCH_DROP * p.crouch;
    const d = lookDir(p.yaw, p.pitch);
    const cy = Math.cos(p.yaw);
    const sy = Math.sin(p.yaw);
    const cp = Math.cos(p.pitch);
    const sp = Math.sin(p.pitch);
    const rx = cy;
    const rz = -sy; // right
    const ux = -sy * sp;
    const uy = cp;
    const uz = -cy * sp; // up
    const ox = p.x + d[0] * 0.5 + rx * 0.16 - ux * 0.14;
    const oy = eyeY + d[1] * 0.5 - uy * 0.14;
    const oz = p.z + d[2] * 0.5 + rz * 0.16 - uz * 0.14;
    let vx = p.x + d[0] * AIM_DIST - ox;
    let vy = eyeY + d[1] * AIM_DIST - oy;
    let vz = p.z + d[2] * AIM_DIST - oz;
    const k = speed / Math.hypot(vx, vy, vz);
    vx *= k;
    vy *= k;
    vz *= k;

    const bolt: Bolt = { id: this.nextBoltId++, owner: p.id, x: ox, y: oy, z: oz, vx, vy, vz, r: radius, life: BOLT_LIFE };
    this.broadcast({ t: "shot", id: bolt.id, owner: p.id, x: ox, y: oy, z: oz, vx, vy, vz, r: radius });
    // Путь «глаз → рука»: вплотную к цели заряд не должен рождаться внутри неё
    const first = this.sweepPlayers(bolt.owner, p.x, eyeY, p.z, ox, oy, oz, radius);
    if (first) {
      const t = first.hit.t;
      this.finishBolt(bolt, first.p, first.hit, p.x + (ox - p.x) * t, eyeY + (oy - eyeY) * t, p.z + (oz - p.z) * t);
    } else this.bolts.push(bolt);
  }

  // ---------- Заряженный выстрел (луч) ----------

  /** Множитель цены от «экономного выстрела» (манакост относительно базового) */
  private costMul(p: PlayerState): number {
    return p.stats.manaCost / BASE_STATS.manaCost;
  }

  private startCharge(p: PlayerState): void {
    if (p.charging || p.cooldown > 0 || p.lock > 0 || p.mana < BEAM_COST_MIN * this.costMul(p)) return;
    p.charging = true;
    p.chargeT = 0;
  }

  /** Заряд 0..1; ограничен маной: больше, чем она позволяет оплатить, не набрать */
  private chargeOf(p: PlayerState): number {
    const byTime = Math.min(1, p.chargeT / BEAM_CHARGE_TIME);
    const affordable = (p.mana / this.costMul(p) - BEAM_COST_MIN) / (beamCost(1) - BEAM_COST_MIN);
    return Math.max(0, Math.min(byTime, affordable));
  }

  private releaseCharge(p: PlayerState): void {
    if (!p.charging) return;
    const c = this.chargeOf(p);
    p.charging = false;
    if (p.lock > 0 || p.mana < BEAM_COST_MIN * this.costMul(p)) return;
    const st = p.stats;
    // Перки действуют и на луч: «бесплатный» не тратит ману, «крупный» расширяет, «эхо» даёт второй луч
    if (!this.roll(p, st.freeChance, "free")) p.mana = Math.max(0, p.mana - beamCost(c) * this.costMul(p));
    // Скорострельность сокращает паузу так же, как у обычных зарядов
    p.cooldown = (BEAM_COOLDOWN_MIN + (BEAM_COOLDOWN_MAX - BEAM_COOLDOWN_MIN) * c) * (st.fireInterval / BASE_STATS.fireInterval);
    this.afterSpend(p);
    this.fireBeam(p, c, this.roll(p, st.bigChance, "big"));
    if (this.roll(p, st.echoChance, "echo")) {
      p.beamEchoT = ECHO_DELAY;
      p.beamEchoC = c;
    }
  }

  /** Второй луч «Эха»: за часть маны, из текущей позы; пропускается, если маны нет или идёт блокировка */
  private fireBeamEcho(p: PlayerState): void {
    const cost = beamCost(p.beamEchoC) * this.costMul(p) * ECHO_COST_FACTOR;
    if (!p.alive || p.lock > 0 || p.mana < cost) return;
    p.mana -= cost;
    this.afterSpend(p);
    this.fireBeam(p, p.beamEchoC, false);
  }

  /**
   * Луч: мгновенный отрезок от глаз по взгляду. Попадает в первого игрока на пути;
   * рельеф закрывает луч, кроме полного заряда — тот прошивает землю насквозь.
   * Урон — по заряду (10…300), без множителя за голову.
   */
  private fireBeam(p: PlayerState, c: number, big: boolean): void {
    const eyeY = p.y + EYE_HEIGHT - CROUCH_DROP * p.crouch;
    const d = lookDir(p.yaw, p.pitch);
    const pierce = c >= BEAM_PIERCE_AT;
    // Дальность: у закрытого рельефом луча — до первой точки под землёй
    let len = BEAM_RANGE;
    if (!pierce) {
      for (let s = 1; s <= BEAM_RANGE; s += 1) {
        if (eyeY + d[1] * s < this.map.heightAt(p.x + d[0] * s, p.z + d[2] * s)) {
          len = s - 0.5;
          break;
        }
      }
    }
    const ex = p.x + d[0] * len;
    const ey = eyeY + d[1] * len;
    const ez = p.z + d[2] * len;
    const r = (0.04 + 0.1 * c) * (big ? BIG_RADIUS_MULT : 1); // толстый луч прощает неточность
    const first = this.sweepPlayers(p.id, p.x, eyeY, p.z, ex, ey, ez, r);
    const endT = first ? first.hit.t : 1;

    // Визуально луч выходит из руки (как заряд) и приходит в ту же точку
    const cy = Math.cos(p.yaw);
    const sy = Math.sin(p.yaw);
    const cp = Math.cos(p.pitch);
    const sp = Math.sin(p.pitch);
    const ox = p.x + d[0] * 0.5 + cy * 0.16 + sy * sp * 0.14;
    const oy = eyeY + d[1] * 0.5 - cp * 0.14;
    const oz = p.z + d[2] * 0.5 - sy * 0.16 + cy * sp * 0.14;
    this.broadcast({ t: "beam", owner: p.id, x: ox, y: oy, z: oz, ex: p.x + (ex - p.x) * endT, ey: eyeY + (ey - eyeY) * endT, ez: p.z + (ez - p.z) * endT, c, pierce, big });
    if (first) this.dealDamage(p.id, first.p, first.hit.part, beamDamage(c));
  }

  // ---------- Попадания ----------

  /** Первое пересечение отрезка a→b с хитбоксами живых игроков, кроме владельца заряда */
  private sweepPlayers(owner: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): { p: PlayerState; hit: Hit } | null {
    let best: { p: PlayerState; hit: Hit } | null = null;
    for (const p of this.players.values()) {
      if (!p.alive || p.id === owner) continue;
      const hit = segmentVsPlayer(ax, ay, az, bx, by, bz, p, r);
      if (hit && (!best || hit.t < best.hit.t)) best = { p, hit };
    }
    return best;
  }

  private finishBolt(b: Bolt, victim: PlayerState | null, hit: Hit | null, x: number, y: number, z: number): void {
    this.broadcast({ t: "pend", id: b.id, x, y, z, part: hit ? hit.part : null, victim: victim ? victim.id : 0 });
    if (!victim || !hit) return;
    this.dealDamage(b.owner, victim, hit.part, hit.part === "head" ? DMG_HEAD : DMG_BODY);
  }

  /** Попадание: щит, урон, смерть и награды — общий путь для заряда и луча */
  private dealDamage(owner: number, victim: PlayerState, part: HitPart, dmg: number): void {
    // Щит поглощает попадание целиком и сгорает
    if (victim.shield) {
      victim.bot?.noteHit(owner, this.clock);
      victim.shield = false;
      victim.loadout.gadget = null;
      victim.gadgetLeft = 0;
      this.recompute(victim);
      this.broadcast({ t: "hit", attacker: owner, victim: victim.id, part, dmg: 0, hp: victim.hp, absorbed: true });
      return;
    }

    victim.bot?.noteHit(owner, this.clock);
    victim.hp = Math.max(0, victim.hp - dmg);
    this.broadcast({ t: "hit", attacker: owner, victim: victim.id, part, dmg, hp: victim.hp, absorbed: false });
    if (victim.hp > 0) return;
    victim.alive = false;
    victim.charging = false;
    victim.respawn = RESPAWN_TIME;
    victim.deaths++;
    this.rewardDeath(victim);
    const killer = this.players.get(owner);
    if (killer) {
      killer.kills++;
      this.rewardKill(killer);
    }
    this.broadcast({ t: "kill", killer: owner, victim: victim.id, part });
  }

  /** Один подшаг заряда; false — заряд закончился */
  private moveBolt(b: Bolt, dt: number): boolean {
    const nx = b.x + b.vx * dt;
    const ny = b.y + b.vy * dt;
    const nz = b.z + b.vz * dt;

    // Игроки: самое раннее пересечение за подшаг
    const hit = this.sweepPlayers(b.owner, b.x, b.y, b.z, nx, ny, nz, b.r);
    // Земля: три пробы вдоль отрезка (рельеф плавный, подшаг короткий)
    let groundT = 2;
    for (let i = 1; i <= 3; i++) {
      const s = i / 3;
      const px = b.x + (nx - b.x) * s;
      const pz = b.z + (nz - b.z) * s;
      if (b.y + (ny - b.y) * s < this.map.heightAt(px, pz)) {
        groundT = s;
        break;
      }
    }
    const out = Math.abs(nx) > WORLD_SIZE / 2 || Math.abs(nz) > WORLD_SIZE / 2;

    if (hit && hit.hit.t <= groundT) {
      const t = hit.hit.t;
      this.finishBolt(b, hit.p, hit.hit, b.x + (nx - b.x) * t, b.y + (ny - b.y) * t, b.z + (nz - b.z) * t);
      return false;
    }
    if (groundT <= 1) {
      this.finishBolt(b, null, null, b.x + (nx - b.x) * groundT, b.y + (ny - b.y) * groundT, b.z + (nz - b.z) * groundT);
      return false;
    }
    if (out) {
      this.finishBolt(b, null, null, nx, ny, nz);
      return false;
    }
    b.x = nx;
    b.y = ny;
    b.z = nz;
    return true;
  }

  /** Шаг заряда за тик: быстрые заряды дробятся на подшаги ≤ BOLT_STEP */
  private stepBolt(b: Bolt, dt: number): boolean {
    b.life -= dt;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const n = Math.max(1, Math.ceil((speed * dt) / BOLT_STEP));
    for (let i = 0; i < n; i++) if (!this.moveBolt(b, dt / n)) return false;
    if (b.life <= 0) {
      this.finishBolt(b, null, null, b.x, b.y, b.z);
      return false;
    }
    return true;
  }

  // ---------- Возрождение ----------

  /** Случайная точка подальше от живых игроков (лучшая из нескольких попыток) */
  private pickSpawn(): { x: number; y: number; z: number } {
    const R = WORLD_BOUND - SPAWN_MARGIN;
    let best = { x: 0, y: 0, z: 0 };
    let bestD = -1;
    for (let i = 0; i < 12; i++) {
      const x = (Math.random() * 2 - 1) * R;
      const z = (Math.random() * 2 - 1) * R;
      let nearest = Infinity;
      for (const p of this.players.values()) if (p.alive) nearest = Math.min(nearest, Math.hypot(p.x - x, p.z - z));
      if (nearest > bestD) {
        bestD = nearest;
        best = { x, y: this.map.heightAt(x, z), z };
      }
    }
    return best;
  }

  private respawnPlayer(p: PlayerState): void {
    const s = this.pickSpawn();
    p.x = s.x;
    p.y = s.y;
    p.z = s.z;
    p.crouch = 0;
    p.hp = MAX_HP;
    p.mana = p.stats.manaMax;
    p.lock = 0;
    p.cooldown = 0;
    p.alive = true;
    p.respawn = 0;
    p.bot?.respawn(s.x, s.y, s.z);
    this.broadcast({ t: "spawn", id: p.id, x: s.x, y: s.y, z: s.z });
  }

  // ---------- Тик ----------

  private tick(): void {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.clock += dt;

    for (const p of this.players.values()) {
      if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt);
      if (p.alive) {
        this.updateMana(p, dt);
        if (p.charging) {
          if (p.lock > 0) p.charging = false; // мана ушла в блокировку — заряд сорван
          else p.chargeT += dt;
        }
        if (p.beamEchoT >= 0) {
          p.beamEchoT -= dt;
          if (p.beamEchoT < 0) this.fireBeamEcho(p);
        }
        if (p.echoT >= 0) {
          p.echoT -= dt;
          if (p.echoT < 0) this.fireEcho(p);
        }
      } else {
        p.respawn -= dt;
        if (p.respawn <= 0) this.respawnPlayer(p);
      }
    }
    this.tickBots(dt);
    this.tickGadgets(dt);
    this.bolts = this.bolts.filter((b) => this.stepBolt(b, dt));

    // Снимок мира: общая часть одна на всех, «я» — персональная
    const list: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      list.push({ id: p.id, color: p.color, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths, bot: p.bot !== null, chg: p.charging ? this.chargeOf(p) : 0 });
    }
    for (const p of this.players.values()) {
      if (!p.ws) continue; // боту снимок не нужен — он смотрит на мир напрямую
      const l = p.loadout;
      const me: MeSnap = {
        hp: p.hp,
        mana: p.mana,
        manaMax: p.stats.manaMax,
        lock: p.lock,
        lockTotal: p.lockTotal,
        alive: p.alive,
        respawn: Math.max(0, p.respawn),
        moveMul: p.stats.moveMul,
        slight: l.slight,
        perks: l.perks,
        gadget: l.gadget ? { id: l.gadget, left: Math.max(0, p.gadgetLeft) } : null,
        shield: p.shield,
        charge: p.charging ? this.chargeOf(p) : -1,
      };
      this.send(p, { t: "snap", players: list, me });
    }
  }

  // ---------- Сеть ----------

  private send(p: PlayerState, msg: ServerMsg): void {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(text);
  }
}

/** Отрезок a→b против игрока (геометрия хитбоксов — src/shared/hitbox.ts) */
function segmentVsPlayer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, p: PlayerState, boltR: number): Hit | null {
  return segmentVsBody(ax, ay, az, bx, by, bz, p.x, p.y, p.z, p.crouch, boltR);
}
