/**
 * Клиентская сессия: WebSocket к игровому серверу и всё состояние, которое он
 * присылает, — удалённые игроки (со сглаживанием между снимками), летящие
 * заряды (клиент двигает их сам по скорости, сервер лишь сообщает старт и
 * конец), искры попаданий, личные HP/мана и счёт.
 *
 * Сессия ничего не рисует и не знает про DOM: рендер берёт из неё списки,
 * HUD — поля и колбэки (onKill, onClose).
 */

import type { GadgetMsg, HitPart, MeSnap, PlayerSnap, PoseMsg, ServerMsg } from "./shared/game";
import { RADAR_COUNT, RADAR_INTERVAL, RADAR_SHOW, gadgetById, perkById, slightById } from "./shared/balance";
import type { DrawBeam, DrawBolt, DrawGadget, DrawPlayer, DrawSpark } from "./soft/entities";

const CONNECT_TIMEOUT_MS = 5000;
const SMOOTH_RATE = 20; // 1/с: догон удалённого игрока к последнему снимку
const SPARK_GRAVITY = 9;
const WHITE = 6; // индекс «белого» в палитре — цвет по умолчанию

/** Цвет шара-гаджета на карте и стрелки к нему */
export const GADGET_RGB: Record<string, [number, number, number]> = {
  radar: [0.25, 0.9, 1],
  sprint: [0.6, 1, 0.25],
  shield: [1, 0.8, 0.3],
};

/** Пинг радара: враг, замеченный в момент пинга (позиция не обновляется — это «снимок») */
export interface Ping {
  x: number;
  z: number;
  color: number;
  ttl: number;
}

export interface Remote extends DrawPlayer {
  id: number;
  tx: number;
  ty: number;
  tz: number;
  tyaw: number;
  tcrouch: number;
  hp: number;
  alive: boolean;
}

interface BoltView extends DrawBolt {
  id: number;
  owner: number;
  age: number;
}

interface BeamView extends DrawBeam {
  ttl: number;
  maxTtl: number;
}

interface SparkView extends DrawSpark {
  vx: number;
  vy: number;
  vz: number;
  ttl: number;
  maxTtl: number;
}

export interface KillEvent {
  killer: number; // цвет убийцы (индекс палитры)
  victim: number; // цвет жертвы
  part: HitPart;
  /** Убийца или жертва — я */
  mine: boolean;
}

export class Session {
  id = 0;
  seed = 0;
  /** Мой цвет (индекс палитры) */
  color = 0;
  spawn = { x: 0, z: 0 };

  /** Все игроки по последнему снимку (включая меня) — для таблицы счёта */
  scoreboard: PlayerSnap[] = [];
  me: MeSnap = { hp: 100, mana: 100, manaMax: 100, lock: 0, lockTotal: 0, alive: true, respawn: 0, moveMul: 1, slight: {}, perks: [], gadget: null, shield: false, charge: -1 };
  /** Остальные игроки */
  readonly players = new Map<number, Remote>();

  /** Куда сервер поставил меня при возрождении; main забирает и обнуляет */
  respawnAt: { x: number; y: number; z: number } | null = null;

  // Реакции для HUD и палочки (затухают в update)
  hitMarker = 0;
  hitMarkerHead = false;
  damageFlash = 0;
  kick = 0;

  /** Гаджет, лежащий на карте (null — нет) */
  gadget: GadgetMsg | null = null;
  /** Активные пинги радара */
  pings: Ping[] = [];

  onKill: ((e: KillEvent) => void) | null = null;
  /** Я хозяин сервера (первый зашедший): могу добавлять и убирать ботов */
  isHost = false;
  onHost: ((host: boolean) => void) | null = null;
  /** Короткие подсказки: полученные улучшения, сработавшие перки */
  onToast: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  private radarT = 0;
  private ws!: WebSocket;
  private bolts: BoltView[] = [];
  private beams: BeamView[] = [];
  private sparks: SparkView[] = [];
  private myX = 0;
  private myY = 0;
  private myZ = 0;

  /** Подключиться к серверу и дождаться welcome (иначе ошибка по таймауту) */
  static connect(): Promise<Session> {
    return new Promise((resolve, reject) => {
      const s = new Session();
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      s.ws = ws;
      const timer = window.setTimeout(() => {
        ws.close();
        reject(new Error("сервер не ответил"));
      }, CONNECT_TIMEOUT_MS);
      let welcomed = false;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        if (msg.t === "welcome") {
          welcomed = true;
          window.clearTimeout(timer);
          s.id = msg.id;
          s.seed = msg.seed;
          s.color = msg.color;
          s.spawn = msg.spawn;
          resolve(s);
          return;
        }
        if (welcomed) s.handle(msg);
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        if (!welcomed) reject(new Error("не удалось подключиться"));
      };
      ws.onclose = () => {
        window.clearTimeout(timer);
        if (!welcomed) reject(new Error("соединение закрыто"));
        else s.onClose?.();
      };
    });
  }

  // ---------- Отправка ----------

  sendPose(p: PoseMsg): void {
    this.myX = p.x;
    this.myY = p.y;
    this.myZ = p.z;
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "pose", ...p }));
  }

  /** Выстрел: сервер сам решает, хватает ли маны и прошла ли перезарядка */
  sendShoot(p: PoseMsg): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "shoot", ...p }));
  }

  /** Команда хозяина: добавить бота / убрать последнего (сервер проверяет права) */
  sendBot(op: "add" | "remove"): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "bot", op }));
  }

  /** ПКМ нажата: начать заряд луча (время заряда считает сервер) */
  sendCharge(p: PoseMsg): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "charge", ...p }));
  }

  /** ПКМ отпущена: выстрел лучом по набранному заряду */
  sendRelease(p: PoseMsg): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "release", ...p }));
  }

  /** Заряд сорван без выстрела */
  sendCancel(): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "cancel" }));
  }

  // ---------- Приём ----------

  private colorOf(id: number): number {
    return id === this.id ? this.color : (this.players.get(id)?.color ?? WHITE);
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case "snap":
        this.applySnap(msg.players, msg.me);
        break;
      case "shot": {
        this.bolts.push({ id: msg.id, owner: msg.owner, color: this.colorOf(msg.owner), x: msg.x, y: msg.y, z: msg.z, vx: msg.vx, vy: msg.vy, vz: msg.vz, r: msg.r, age: 0 });
        if (msg.owner === this.id) this.kick = 1;
        break;
      }
      case "beam": {
        const ttl = 0.22 + 0.3 * msg.c; // сильный луч держится дольше
        this.beams.push({ ax: msg.x, ay: msg.y, az: msg.z, bx: msg.ex, by: msg.ey, bz: msg.ez, c: msg.c, pierce: msg.pierce, big: msg.big, color: this.colorOf(msg.owner), life: 1, ttl, maxTtl: ttl });
        this.burst(msg.ex, msg.ey, msg.ez, this.colorOf(msg.owner), Math.round(6 + 34 * msg.c), 2.5 + 4 * msg.c);
        if (msg.owner === this.id) this.kick = 1;
        break;
      }
      case "pend": {
        const i = this.bolts.findIndex((b) => b.id === msg.id);
        const color = i >= 0 ? this.bolts[i].color : WHITE;
        if (i >= 0) this.bolts.splice(i, 1);
        this.burst(msg.x, msg.y, msg.z, color, msg.part === "head" ? 18 : msg.part === "body" ? 11 : 6, 3.2);
        break;
      }
      case "hit": {
        if (msg.attacker === this.id) {
          this.hitMarker = 0.28;
          this.hitMarkerHead = msg.part === "head";
        }
        if (msg.victim === this.id) {
          if (msg.absorbed) this.onToast?.("◆ Щит поглотил попадание");
          else this.damageFlash = Math.min(1, 0.45 + msg.dmg / 150);
        }
        const r = this.players.get(msg.victim);
        if (r) r.flash = 1;
        break;
      }
      case "kill": {
        const v = msg.victim === this.id ? { x: this.myX, y: this.myY, z: this.myZ } : this.players.get(msg.victim);
        if (v) this.burst(v.x, v.y + 1.1, v.z, this.colorOf(msg.victim), 40, 5.5);
        this.onKill?.({ killer: this.colorOf(msg.killer), victim: this.colorOf(msg.victim), part: msg.part, mine: msg.killer === this.id || msg.victim === this.id });
        break;
      }
      case "spawn": {
        if (msg.id === this.id) {
          this.respawnAt = { x: msg.x, y: msg.y, z: msg.z };
        } else {
          const r = this.players.get(msg.id);
          if (r) {
            r.x = r.tx = msg.x;
            r.y = r.ty = msg.y;
            r.z = r.tz = msg.z;
          }
        }
        break;
      }
      case "host":
        this.isHost = msg.host;
        this.onHost?.(msg.host);
        break;
      case "note":
        this.onToast?.(msg.text);
        break;
      case "gadget":
        this.gadget = { id: msg.id, kind: msg.kind, x: msg.x, y: msg.y, z: msg.z, ttl: msg.ttl };
        break;
      case "gadgetEnd":
        if (this.gadget && this.gadget.id === msg.id) this.gadget = null;
        break;
      case "upgrade":
        this.onToast?.(this.upgradeText(msg.tier, msg.id, msg.stacks));
        break;
      case "proc": {
        const title = perkById(msg.id)?.title;
        if (title) this.onToast?.(`✦ ${title}!`);
        break;
      }
      default:
        break;
    }
  }

  private upgradeText(tier: "slight" | "normal" | "gadget" | "refill", id: string, stacks: number): string {
    if (tier === "slight") {
      const d = slightById(id);
      return d ? `▲ ${d.title} ×${stacks}: ${d.desc}` : "▲ Улучшение";
    }
    if (tier === "normal") {
      const d = perkById(id);
      return d ? `★ Перк — ${d.title}${stacks > 1 ? ` ×${stacks}` : ""}: ${d.desc}${stacks > 1 ? " (шанс растёт)" : ""}` : "★ Новый перк";
    }
    if (tier === "gadget") {
      const d = gadgetById(id);
      return d ? `◆ ${d.title} на ${d.duration} с: ${d.desc}` : "◆ Гаджет";
    }
    return "▲ Улучшения на пределе — мана восстановлена";
  }

  private applySnap(list: PlayerSnap[], me: MeSnap): void {
    this.scoreboard = list;
    this.me = me;
    const seen = new Set<number>();
    for (const s of list) {
      if (s.id === this.id) continue;
      seen.add(s.id);
      let r = this.players.get(s.id);
      if (!r) {
        r = { id: s.id, color: s.color, x: s.x, y: s.y, z: s.z, yaw: s.yaw, crouch: s.crouch, flash: 0, charge: 0, tx: s.x, ty: s.y, tz: s.z, tyaw: s.yaw, tcrouch: s.crouch, hp: s.hp, alive: s.alive };
        this.players.set(s.id, r);
      }
      r.color = s.color;
      r.tx = s.x;
      r.ty = s.y;
      r.tz = s.z;
      r.tyaw = s.yaw;
      r.tcrouch = s.crouch;
      r.hp = s.hp;
      r.alive = s.alive;
      r.charge = s.chg;
    }
    for (const id of this.players.keys()) if (!seen.has(id)) this.players.delete(id);
  }

  /** Россыпь искр цвета color из точки: n штук, скорость до speed */
  private burst(x: number, y: number, z: number, color: number, n: number, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 2 - 0.6; // чуть больше вверх
      const h = Math.sqrt(Math.max(0, 1 - e * e * 0.5));
      const v = speed * (0.35 + Math.random() * 0.65);
      const ttl = 0.35 + Math.random() * 0.45;
      this.sparks.push({ x, y, z, color, life: 1, vx: Math.cos(a) * h * v, vy: e * v, vz: Math.sin(a) * h * v, ttl, maxTtl: ttl });
    }
  }

  // ---------- Кадр ----------

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * SMOOTH_RATE);
    for (const r of this.players.values()) {
      r.x += (r.tx - r.x) * k;
      r.y += (r.ty - r.y) * k;
      r.z += (r.tz - r.z) * k;
      r.crouch += (r.tcrouch - r.crouch) * k;
      // yaw по кратчайшей дуге
      let d = r.tyaw - r.yaw;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      r.yaw += d * k;
      if (r.flash > 0) r.flash = Math.max(0, r.flash - dt * 5);
    }
    for (const b of this.bolts) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.age += dt;
    }
    // Страховка: если pend потерялся, заряд не живёт вечно
    this.bolts = this.bolts.filter((b) => b.age < 6);
    for (const s of this.sparks) {
      s.vy -= SPARK_GRAVITY * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.ttl -= dt;
      s.life = Math.max(0, s.ttl / s.maxTtl);
    }
    this.sparks = this.sparks.filter((s) => s.ttl > 0);
    for (const bm of this.beams) {
      bm.ttl -= dt;
      bm.life = Math.max(0, bm.ttl / bm.maxTtl);
    }
    this.beams = this.beams.filter((bm) => bm.ttl > 0);
    this.updateRadar(dt);
    if (this.gadget) this.gadget.ttl -= dt;
    if (this.hitMarker > 0) this.hitMarker -= dt;
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);
    if (this.kick > 0) this.kick = Math.max(0, this.kick - dt * 6);
  }

  /** Радар: раз в RADAR_INTERVAL с «снимок» позиций ближайших врагов; стрелки гаснут за RADAR_SHOW с */
  private updateRadar(dt: number): void {
    for (const p of this.pings) p.ttl -= dt;
    this.pings = this.pings.filter((p) => p.ttl > 0);
    if (this.me.gadget?.id !== "radar" || !this.me.alive) {
      this.radarT = 0; // подобрали — первый пинг сразу
      return;
    }
    this.radarT -= dt;
    if (this.radarT > 0) return;
    this.radarT = RADAR_INTERVAL;
    const near = this.alivePlayers()
      .map((r) => ({ r, d: Math.hypot(r.x - this.myX, r.z - this.myZ) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, RADAR_COUNT);
    this.pings = near.map(({ r }) => ({ x: r.x, z: r.z, color: r.color, ttl: RADAR_SHOW }));
  }

  /** Моё положение (обновляется при каждой отправке позы) — для стрелок HUD */
  get myPos(): { x: number; z: number } {
    return { x: this.myX, z: this.myZ };
  }

  /** Гаджет на карте для рендера */
  gadgetList(): DrawGadget[] {
    const g = this.gadget;
    return g ? [{ x: g.x, y: g.y, z: g.z, rgb: GADGET_RGB[g.kind] ?? [1, 1, 1] }] : [];
  }

  /** Живые удалённые игроки для рендера */
  alivePlayers(): Remote[] {
    const out: Remote[] = [];
    for (const r of this.players.values()) if (r.alive) out.push(r);
    return out;
  }

  get boltList(): readonly DrawBolt[] {
    return this.bolts;
  }

  get beamList(): readonly DrawBeam[] {
    return this.beams;
  }

  get sparkList(): readonly DrawSpark[] {
    return this.sparks;
  }
}
