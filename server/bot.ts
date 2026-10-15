/**
 * Мозг бота. Бот — обычный игрок на сервере: у него та же физика (класс Player
 * из клиента — те же разгон, прыжок, присед), тот же хитбокс и мана, а выстрелы
 * идут через общий tryShoot. Читерства нет: бот не знает будущего, он видит
 * позиции и (как любой игрок) направление взгляда врагов, а скорость и манеру
 * движения цели выводит сам из истории её позиций.
 *
 * Что он умеет:
 *  – выбирает цель (дальность, прямая видимость, кто его ранил, хп цели);
 *  – двигается: держит дистанцию, стрейфится случайными рывками, прыгает,
 *    приседает, уходит от края карты, бежит к гаджету, когда не до боя;
 *  – уклоняется от летящих зарядов: перебирает манёвры (шаг влево/вправо, прыжок,
 *    присед и их сочетания), прогоняет каждый по предсказанному пути и
 *    выбирает тот, при котором заряд пролетает мимо хитбокса с запасом;
 *  – целится с человеческой инерцией (ограниченная угловая скорость, дрожь,
 *    задержка на захват новой цели) и стреляет на упреждение. Первые выстрелы
 *    по цели — осторожное упреждение; пока они летят, бот сверяет, где цель
 *    оказалась на самом деле, и ведёт счёт ошибкам трёх моделей движения
 *    (на месте / равномерно / повторяющийся стрейф). После нескольких
 *    проверенных выстрелов он берёт ту модель, которая реально точнее, и
 *    подстраивает коэффициент упреждения.
 *
 * Стоимость: на бота за тик — O(враги + заряды), без аллокаций в горячем пути
 * кроме коротких массивов; сотни операций, не мешает сервису.
 */

import { BASE_SPEED, GRAVITY_DOWN, GRAVITY_UP, GROUND_ACCEL, AIR_ACCEL, JUMP_SPEED, Player, SPRINT_MULT, type MoveInput } from "../src/player";
import { BEAM_DMG_MAX, BEAM_DMG_MIN, BEAM_FALLOFF, CROUCH_DROP, beamCost, falloffMul } from "../src/shared/game";
import { BASE_STATS } from "../src/shared/balance";
import { segmentVsBody } from "../src/shared/hitbox";

// ---------- Что бот видит и что возвращает ----------

export interface BotBody {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  hp: number;
  alive: boolean;
}

export interface BotBolt {
  id: number;
  owner: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
}

export interface BotCtx {
  /** Монотонное время сервера, с */
  now: number;
  selfId: number;
  self: {
    hp: number;
    mana: number;
    lock: number;
    cooldown: number;
    manaCost: number;
    boltSpeed: number;
    moveMul: number;
    /** Идёт заряд луча и сколько набрано (0..1; сервер уже учёл потолок по мане) */
    charging: boolean;
    charge: number;
  };
  enemies: readonly BotBody[];
  bolts: readonly BotBolt[];
  gadget: { x: number; y: number; z: number } | null;
  /** Монеты на земле: боты их подбирают */
  coins: readonly { x: number; z: number }[];
  /** Опора под ступнями на высоте y (земля, постройки, летающие платформы) */
  groundAt: (x: number, z: number, y: number) => number;
  /** Не пускает ли постройка тело бота в точку (стены останавливают) */
  blocked: (x: number, z: number, y: number) => boolean;
  /** Твёрдая ли точка мира (земля, стена, платформа) — для линии видимости */
  blockedAt: (x: number, y: number, z: number) => boolean;
  /** Половина размера мира (невидимая стена) */
  bound: number;
}

export interface BotOut {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  shoot: boolean;
  /** Альтернативный выстрел: держать заряд / отпустить (выстрелить) / сорвать без выстрела */
  beam: "none" | "hold" | "release" | "cancel";
}

// ---------- Вспомогательное ----------

/** Зрение бота: дальность (меньше дальности тумана игрока), полуугол поля зрения, слух выстрелов */
const SIGHT_RANGE = 90;
const SIGHT_CONE = 1.4; // рад (~80° в каждую сторону)
const ALERT_RANGE = 140;
const HEAR_BOLT = 70;
/** Сколько секунд после потери из виду бот ещё «чувствует» врага (звук, инерция) */
const MEMORY = 1.0;

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const gauss = (): number => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;

type Model = "static" | "linear" | "pattern";
type Vec3 = [number, number, number];

/** Высота полёта с прыжка/падения (по тем же гравитациям, что в Player; без «зависания» у вершины) */
function ballistic(y0: number, vy0: number, t: number, ground: number): number {
  let y: number;
  if (vy0 > 0) {
    const tu = vy0 / GRAVITY_UP;
    if (t <= tu) y = y0 + vy0 * t - 0.5 * GRAVITY_UP * t * t;
    else {
      const td = t - tu;
      y = y0 + (vy0 * vy0) / (2 * GRAVITY_UP) - 0.5 * GRAVITY_DOWN * td * td;
    }
  } else y = y0 + vy0 * t - 0.5 * GRAVITY_DOWN * t * t;
  return y < ground ? ground : y;
}

// ---------- Слежение за целью и обучение упреждению ----------

interface Pending {
  tHit: number;
  /** Где цель была в момент выстрела */
  bx: number;
  by: number;
  bz: number;
  /** Предсказанные каждой моделью положения (ступни) в момент попадания; pattern — null, если не было */
  pred: Record<Model, Vec3 | null>;
  /** Скорость цели в момент выстрела, T — время полёта */
  vx: number;
  vz: number;
  T: number;
}

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
}

const VEL_WINDOW = 0.15; // с: окно оценки скорости (около 5 тиков)
const MIN_VALIDATED = 2; // столько выстрелов нужно проверить, прежде чем выбирать модель по точности
const PATTERN_MIN_FLIPS = 3;

class Tracker {
  samples: Sample[] = [];
  vx = 0;
  vy = 0;
  vz = 0;
  grounded = true;
  /** Моменты смены направления боковой скорости (для поиска периода стрейфа) */
  flips: number[] = [];
  lastSign = 0;
  lastFlipT = -9;
  latMag = 5;
  /** Скользящая ошибка каждой модели, юниты (NaN — ещё нет данных) */
  err: Record<Model, number> = { static: NaN, linear: NaN, pattern: NaN };
  validated = 0;
  /** Эффективный множитель упреждения для равномерного движения */
  gain = 1;
  pending: Pending[] = [];
  shots = 0;

  reset(): void {
    this.samples.length = 0;
    this.vx = this.vy = this.vz = 0;
    this.flips.length = 0;
    this.lastSign = 0;
    this.lastFlipT = -9;
    this.pending.length = 0;
    this.err = { static: NaN, linear: NaN, pattern: NaN };
    this.validated = 0;
    this.gain = 1;
    this.shots = 0;
  }

  get pos(): Sample {
    return this.samples[this.samples.length - 1];
  }

  /** Новый замер позиции (раз в тик); perp — вправо от линии «бот → цель» */
  observe(now: number, b: BotBody, perpX: number, perpZ: number, groundAt: (x: number, z: number, y: number) => number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && Math.hypot(b.x - last.x, b.z - last.z) > 8) this.reset(); // возрождение — новая «жизнь»
    this.samples.push({ t: now, x: b.x, y: b.y, z: b.z });
    while (this.samples.length > 2 && now - this.samples[0].t > 0.6) this.samples.shift();
    // Скорость по окну: дубли поз (клиент шлёт 30 Гц, тик 30 Гц) сглаживаются
    let i = 0;
    while (i < this.samples.length - 1 && now - this.samples[i].t > VEL_WINDOW) i++;
    const a = this.samples[i];
    const dt = now - a.t;
    if (dt >= 0.06) {
      this.vx = (b.x - a.x) / dt;
      this.vy = (b.y - a.y) / dt;
      this.vz = (b.z - a.z) / dt;
    }
    this.grounded = b.y - groundAt(b.x, b.z, b.y) < 0.12;

    // Смены боковой скорости — по ним ищем период стрейфа
    const vlat = this.vx * perpX + this.vz * perpZ;
    if (Math.abs(vlat) > 1.2) {
      const sign = vlat > 0 ? 1 : -1;
      this.latMag += (Math.abs(vlat) - this.latMag) * 0.15;
      if (this.lastSign !== 0 && sign !== this.lastSign && now - this.lastFlipT > 0.15) {
        this.flips.push(now);
        this.lastFlipT = now;
        if (this.flips.length > 8) this.flips.shift();
      }
      this.lastSign = sign;
    }
  }

  /** Период (полупериод между разворотами) стрейфа, если цель ходит ритмично; 0 — не ритмично */
  patternPeriod(now: number): number {
    const f = this.flips;
    let n = 0;
    while (n < f.length && now - f[f.length - 1 - n] < 4) n++;
    if (n < PATTERN_MIN_FLIPS) return 0;
    const first = f.length - n;
    let sum = 0;
    for (let i = first + 1; i < f.length; i++) sum += f[i] - f[i - 1];
    const k = n - 1;
    const mean = sum / k;
    let v = 0;
    for (let i = first + 1; i < f.length; i++) v += (f[i] - f[i - 1] - mean) ** 2;
    const cv = Math.sqrt(v / k) / mean;
    if (cv > 0.4 || mean < 0.2 || mean > 3) return 0;
    if (now - this.lastFlipT > mean * 2.2) return 0; // ритм оборвался
    return mean;
  }

  /** Положение ступней цели через T секунд по модели */
  predict(model: Model, T: number, now: number, perpX: number, perpZ: number, groundAt: (x: number, z: number, y: number) => number): Vec3 {
    const p = this.pos;
    let x = p.x;
    let z = p.z;
    if (model === "linear") {
      const g = this.validated < MIN_VALIDATED ? 0.55 : this.gain;
      x += this.vx * T * g;
      z += this.vz * T * g;
    } else if (model === "pattern") {
      const period = this.patternPeriod(now);
      const vlat = this.vx * perpX + this.vz * perpZ;
      // Вдоль линии (не боковая) часть скорости — равномерно, боковая — с разворотами
      x += (this.vx - vlat * perpX) * T;
      z += (this.vz - vlat * perpZ) * T;
      let sign = this.lastSign !== 0 ? this.lastSign : vlat >= 0 ? 1 : -1;
      let seg = Math.max(0.05, (period || 1) - (now - this.lastFlipT));
      let left = T;
      let lat = 0;
      while (left > 1e-6) {
        const d = Math.min(left, seg);
        lat += sign * this.latMag * 0.92 * d; // 0.92 — потеря на разгоне после разворота
        left -= d;
        sign = -sign;
        seg = period || 1;
      }
      x += lat * perpX;
      z += lat * perpZ;
    }
    const gr = groundAt(x, z, p.y);
    let y = p.y;
    if (model !== "static" && !this.grounded) y = ballistic(p.y, this.vy, T, gr);
    else if (this.grounded) y = gr;
    return [x, y, z];
  }

  /** Лучшая сейчас модель: пока данных мало — осторожное равномерное, потом та, что точнее по факту */
  bestModel(now: number): Model {
    if (this.validated < MIN_VALIDATED) return "linear";
    let best: Model = "linear";
    let bestErr = this.err.linear;
    if (this.err.static < bestErr * 0.9) {
      best = "static";
      bestErr = this.err.static;
    }
    if (this.patternPeriod(now) > 0 && this.err.pattern < bestErr * 0.85) best = "pattern";
    return best;
  }

  /** Ошибка выбранной сейчас модели, юниты (для уверенности) */
  errOf(model: Model): number {
    return this.validated < MIN_VALIDATED ? 1.5 : this.err[model];
  }

  /** Сверить прошедшие выстрелы с тем, где цель оказалась в момент попадания */
  settle(now: number): void {
    const p = this.samples.length ? this.pos : null;
    if (!p) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i];
      if (now < q.tHit) continue;
      this.pending.splice(i, 1);
      const upd = (m: Model): void => {
        const pr = q.pred[m];
        if (!pr) return;
        const e = Math.hypot(pr[0] - p.x, pr[1] - p.y, pr[2] - p.z);
        this.err[m] = Number.isNaN(this.err[m]) ? e : this.err[m] * 0.6 + e * 0.4;
      };
      upd("static");
      upd("linear");
      upd("pattern");
      // Коэффициент упреждения: какую долю расчётного смещения цель реально прошла вдоль своей скорости
      const sp = Math.hypot(q.vx, q.vz);
      if (sp * q.T > 1) {
        const ux = q.vx / sp;
        const uz = q.vz / sp;
        const r = clamp(((p.x - q.bx) * ux + (p.z - q.bz) * uz) / (sp * q.T), 0, 1.8);
        this.gain += (r - this.gain) * 0.35;
      }
      this.validated++;
    }
  }
}

// ---------- Бот ----------

type Dodge = "none" | "left" | "right" | "jump" | "jumpL" | "jumpR" | "crouch";
const DODGES: readonly Dodge[] = ["none", "crouch", "left", "right", "jump", "jumpL", "jumpR"];
const DODGE_COST: Record<Dodge, number> = { none: 0, crouch: 0.6, left: 1, right: 1, jump: 1.4, jumpL: 1.8, jumpR: 1.8 };
const MARGINS = [0.3, 0.12, 0];

interface Threat {
  bolt: BotBolt;
  tc: number;
}

export class BotBrain {
  readonly player: Player;
  private yaw = 0;
  private pitch = 0;
  private readonly skill: number;
  private readonly reaction: number;
  private readonly wMax: number;
  private readonly sigma: number;
  private readonly acquireDelay: number;
  private readonly hiRange: number;
  private readonly loRange = 11;

  private readonly trackers = new Map<number, Tracker>();
  private target = 0;
  private nextRetarget = 0;
  private fireAfter = 0;
  private noiseT = 0;
  private noiseYaw = 0;
  private noisePitch = 0;

  private strafeSign = 1;
  private strafeUntil = 0;
  private strafeK = 1;
  private hopAt = 0;
  private jumpHoldUntil = 0;
  private crouchUntil = 0;
  private nextCrouch = 0;
  private wp: { x: number; z: number } | null = null;
  private wpUntil = 0;

  private dodge: Dodge = "none";
  private dodgeUntil = 0;
  private readonly seen = new Map<number, number>();
  private hurtBy = 0;
  private hurtT = -99;

  /** skill 0..1: реакция, скорость наведения, дрожь прицела */
  constructor(x: number, y: number, z: number, skill = 0.85) {
    this.skill = clamp(skill, 0.1, 1);
    this.reaction = 0.07 + (1 - this.skill) * 0.35;
    this.wMax = 5 + this.skill * 9;
    this.sigma = (1.1 - this.skill) * 0.018;
    this.acquireDelay = 0.12 + (1 - this.skill) * 0.45;
    this.hiRange = rnd(22, 28);
    this.player = new Player(x, y, z);
    this.yaw = Math.random() * Math.PI * 2;
  }

  /** Возрождение: новая жизнь с чистой памятью о манёврах */
  respawn(x: number, y: number, z: number): void {
    this.player.teleport(x, y, z);
    this.dodge = "none";
    this.beamOn = false;
    this.seen.clear();
    this.seenSince.clear();
    this.lastSeen.clear();
    this.wp = null;
    this.target = 0;
    this.pitch = 0;
  }

  /** По боту попали: запомнить стрелявшего — он станет приоритетной целью */
  noteHit(attacker: number, now: number): void {
    this.hurtBy = attacker;
    this.hurtT = now;
  }

  // ---------- Главный шаг ----------

  update(dt: number, ctx: BotCtx): BotOut {
    const pl = this.player;
    const now = ctx.now;
    pl.speedMul = ctx.self.moveMul;
    const ex = pl.x;
    const ez = pl.z;

    // 1. Наблюдение за врагами
    const alive = new Set<number>();
    this.perceive(ctx, now, ex, pl.eyeY(), ez);
    for (const e of ctx.enemies) {
      if (!e.alive || !this.isTracked(e.id, now)) continue; // не замечен — не наблюдаем
      alive.add(e.id);
      let tr = this.trackers.get(e.id);
      if (!tr) this.trackers.set(e.id, (tr = new Tracker()));
      const dx = e.x - ex;
      const dz = e.z - ez;
      const d = Math.hypot(dx, dz) || 1;
      tr.observe(now, e, dz / d, -dx / d, ctx.groundAt);
      tr.settle(now);
    }
    for (const id of this.trackers.keys()) if (!alive.has(id)) this.trackers.delete(id);

    // 2. Цель
    const eyeY = pl.eyeY();
    if (now >= this.nextRetarget && !this.beamOn) { // во время заряда луча цель не меняем
      this.nextRetarget = now + 0.2;
      this.pickTarget(ctx, ex, eyeY, ez, now);
    }
    const tb = ctx.enemies.find((e) => e.id === this.target && e.alive && this.isTracked(e.id, now)) ?? null;
    const tr = tb ? this.trackers.get(tb.id)! : null;

    // 3. Прицел и выстрел
    let shoot = false;
    let dist = 0;
    let los = false;
    if (tb && tr) {
      dist = Math.hypot(tb.x - ex, tb.z - ez);
      los = this.hasLOS(ctx, ex, eyeY, ez, tb.x, tb.y + 1.2 - CROUCH_DROP * tb.crouch, tb.z);
      if (this.beamOn) this.aimBeam(dt, tb, ex, eyeY, ez, dist, now);
      else shoot = this.aim(dt, ctx, tb, tr, ex, eyeY, ez, dist, los, now);
    }
    const beam = this.beamStep(ctx, tb, dist, los, now);

    // 4. Движение: уклонение важнее намерений
    const input = this.unstick(this.movement(ctx, tb, tr, dist, los, now), now);

    // 5. Физика и вывод
    pl.update(dt, input, this.yaw, ctx.groundAt, ctx.bound, ctx.blocked);
    return { x: pl.x, y: pl.y, z: pl.z, yaw: this.yaw, pitch: this.pitch, crouch: pl.crouch, shoot, beam };
  }

  // ---------- Восприятие ----------

  /** Начало непрерывного наблюдения за врагом (для задержки опознания) и время последнего взгляда */
  private readonly seenSince = new Map<number, { since: number; looked: number }>();
  /** Где и когда враг был замечен в последний раз */
  private readonly lastSeen = new Map<number, { t: number; x: number; z: number }>();
  private nextPerceive = 0;

  /** Враг «на сопровождении»: замечен сейчас или потерян из виду не дольше MEMORY с назад */
  private isTracked(id: number, now: number): boolean {
    const s = this.lastSeen.get(id);
    return s !== undefined && now - s.t < MEMORY;
  }

  /**
   * Зрение и слух: бот не знает, где враги, пока их не заметит. Заметить можно в пределах
   * SIGHT_RANGE, в поле зрения (конус) и по прямой видимости; опознание занимает долю секунды
   * (дальше — дольше). Вне конуса и дальше — только по слуху: враг, стреляющий рядом, и тот,
   * кто только что попал в бота, обнаруживаются сразу (но видимость всё равно нужна).
   */
  private perceive(ctx: BotCtx, now: number, ex: number, eyeY: number, ez: number): void {
    if (now < this.nextPerceive) return;
    this.nextPerceive = now + 0.1;
    const heard = new Set<number>();
    for (const b of ctx.bolts) {
      if (b.owner !== ctx.selfId && Math.hypot(b.x - ex, b.z - ez) < HEAR_BOLT) heard.add(b.owner);
    }
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      const dx = e.x - ex;
      const dz = e.z - ez;
      const dist = Math.hypot(dx, dz);
      const alerted = heard.has(e.id) || (e.id === this.hurtBy && now - this.hurtT < 1.5);
      const range = alerted ? ALERT_RANGE : SIGHT_RANGE * (1 - 0.25 * e.crouch);
      let seen = dist <= range;
      if (seen && !alerted && dist > 8 && Math.abs(wrap(Math.atan2(dx, dz) - this.yaw)) > SIGHT_CONE) seen = false;
      if (seen && !this.hasLOS(ctx, ex, eyeY, ez, e.x, e.y + 1.2 - CROUCH_DROP * e.crouch, e.z)) seen = false;

      const st = this.seenSince.get(e.id);
      if (!seen) {
        if (st && now - st.looked > 0.35) this.seenSince.delete(e.id);
        continue;
      }
      if (!st) {
        this.seenSince.set(e.id, { since: now, looked: now });
        continue;
      }
      st.looked = now;
      // Опознание: чем дальше враг, тем дольше; плохие бойцы медлят больше
      if (now - st.since >= 0.12 + dist / 170 + this.acquireDelay * 0.5) {
        this.lastSeen.set(e.id, { t: now, x: e.x, z: e.z });
      }
    }
  }

  // ---------- Цель ----------

  private pickTarget(ctx: BotCtx, ex: number, ey: number, ez: number, now: number): void {
    let best = 0;
    let bestScore = Infinity;
    for (const e of ctx.enemies) {
      if (!e.alive || !this.isTracked(e.id, now)) continue;
      const d = Math.hypot(e.x - ex, e.z - ez);
      let s = d;
      if (!this.hasLOS(ctx, ex, ey, ez, e.x, e.y + 1.2, e.z)) s += 25;
      if (e.hp <= 50) s -= 10;
      if (e.id === this.hurtBy && now - this.hurtT < 3) s -= 18;
      if (e.id === this.target) s -= 8; // гистерезис — не метаться между целями
      if (s < bestScore) {
        bestScore = s;
        best = e.id;
      }
    }
    if (best !== this.target) {
      if (best === 0) {
        // Цель потеряна из виду — идём искать туда, где её видели в последний раз
        const last = this.lastSeen.get(this.target);
        if (last) {
          this.wp = { x: last.x + rnd(-5, 5), z: last.z + rnd(-5, 5) };
          this.wpUntil = now + 8;
        }
      }
      this.target = best;
      this.fireAfter = now + this.acquireDelay; // время «увидеть» новую цель
    }
  }

  /** Прямая видимость: рельеф между глазами и точкой (проба вдоль отрезка) */
  private hasLOS(ctx: BotCtx, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    // Шаг ≤ ~1.6: стена толщиной 2 не проскакивается между пробами
    const n = Math.min(90, Math.max(2, Math.ceil(d / 1.5)));
    for (let i = 1; i < n; i++) {
      const s = i / n;
      const x = ax + (bx - ax) * s;
      const z = az + (bz - az) * s;
      if (ctx.blockedAt(x, ay + (by - ay) * s - 0.15, z)) return false;
    }
    return true;
  }

  // ---------- Прицеливание ----------

  /** Навести прицел с упреждением; true — пора стрелять */
  private aim(dt: number, ctx: BotCtx, tb: BotBody, tr: Tracker, ex: number, ey: number, ez: number, dist: number, los: boolean, now: number): boolean {
    const dx = tb.x - ex;
    const dz = tb.z - ez;
    const dl = Math.hypot(dx, dz) || 1;
    const perpX = dz / dl;
    const perpZ = -dx / dl;

    const model = tr.bestModel(now);
    const confident = tr.validated >= 3 && tr.errOf(model) < 0.45 && dist < 38;
    // Уверенно — в голову (150), иначе в середину тела: цилиндр высокий и прощает промах
    const aimH = (confident ? 1.5 : 1.15) - CROUCH_DROP * tb.crouch;

    // Упреждение: решаем «время полёта = расстояние до будущей точки / скорость заряда»
    const speed = ctx.self.boltSpeed;
    let T = Math.hypot(dx, dz) / speed;
    let p: Vec3 = [tb.x, tb.y, tb.z];
    for (let i = 0; i < 4; i++) {
      p = tr.predict(model, T, now, perpX, perpZ, ctx.groundAt);
      T = Math.hypot(p[0] - ex, p[1] + aimH - ey, p[2] - ez) / speed;
    }
    const tx = p[0] - ex;
    const ty = p[1] + aimH - ey;
    const tz = p[2] - ez;
    const desYaw = Math.atan2(tx, tz);
    const desPitch = Math.atan2(ty, Math.hypot(tx, tz));

    const err = this.steer(dt, desYaw, desPitch, now);
    const tol = clamp(Math.atan2(0.3, Math.max(dist, 4)), 0.012, 0.09);

    const s = ctx.self;
    const ready = s.cooldown <= 0 && s.lock <= 0 && s.mana >= s.manaCost;
    if (!ready || !los || now < this.fireAfter || err > tol || T > 1.8 || dist > 85) return false;

    // Выстрел: запоминаем, что предсказывали каждой моделью, — проверим, когда заряд долетит
    const pr: Record<Model, Vec3 | null> = {
      static: tr.predict("static", T, now, perpX, perpZ, ctx.groundAt),
      linear: tr.predict("linear", T, now, perpX, perpZ, ctx.groundAt),
      pattern: tr.patternPeriod(now) > 0 ? tr.predict("pattern", T, now, perpX, perpZ, ctx.groundAt) : null,
    };
    if (tr.pending.length < 8) {
      const here = tr.pos;
      tr.pending.push({ tHit: now + T, bx: here.x, by: here.y, bz: here.z, pred: pr, vx: tr.vx, vz: tr.vz, T });
    }
    tr.shots++;
    return true;
  }

  /**
   * Довернуть прицел к нужным углам: дрожь, ограничение угловой скорости.
   * Возвращает угловую ошибку до идеального направления (без шума), рад.
   */
  private steer(dt: number, desYaw: number, desPitch: number, now: number): number {
    // Дрожь прицела: медленный шум, перерисовывается ~7 раз в секунду
    if (now >= this.noiseT) {
      this.noiseT = now + 0.14;
      this.noiseYaw = gauss() * this.sigma;
      this.noisePitch = gauss() * this.sigma;
    }
    // Быстро вблизи цели, медленно при больших поворотах
    const stepMax = this.wMax * dt;
    const ey1 = wrap(desYaw + this.noiseYaw - this.yaw);
    const ep1 = desPitch + this.noisePitch - this.pitch;
    this.yaw += clamp(ey1 * Math.min(1, 14 * dt), -stepMax, stepMax);
    this.pitch = clamp(this.pitch + clamp(ep1 * Math.min(1, 14 * dt), -stepMax, stepMax), -1.4, 1.4);
    const errYaw = wrap(desYaw - this.yaw) * Math.cos(this.pitch);
    return Math.hypot(errYaw, desPitch - this.pitch);
  }

  // ---------- Альтернативный выстрел: заряженный луч ----------

  private beamOn = false;
  private beamStart = 0;
  private beamNeed = 0;
  private beamPierce = false;
  private beamTarget = 0;
  private beamErr = 1;
  private beamTol = 0.05;
  private nextBeam = 0;

  /** Прицел под луч: хитскан мгновенный — упреждение не нужно, целимся в текущую точку цели */
  private aimBeam(dt: number, tb: BotBody, ex: number, ey: number, ez: number, dist: number, now: number): void {
    const tx = tb.x - ex;
    const ty = tb.y + 1.05 - CROUCH_DROP * tb.crouch - ey;
    const tz = tb.z - ez;
    this.beamErr = this.steer(dt, Math.atan2(tx, tz), Math.atan2(ty, Math.hypot(tx, tz)), now);
    // Допуск: тело (0.32) + радиус луча (толще при большом заряде)
    this.beamTol = clamp(Math.atan2(0.3 + 0.1 * this.beamNeed, Math.max(dist, 4)) * 0.8, 0.01, 0.1);
  }

  /**
   * Решение по лучу. Хитскан выгоден там, где заряды долго летят и цель успевает
   * уйти (дальний бой при прямой видимости), и единственный способ достать
   * цель за холмом — полный заряд, который прошивает рельеф. Урон луча зависит
   * от заряда, поэтому бот держит ровно столько, сколько нужно, чтобы убить
   * (хп цели + запас), и не тратит ману сверх.
   */
  private beamStep(ctx: BotCtx, tb: BotBody | null, dist: number, los: boolean, now: number): BotOut["beam"] {
    const s = ctx.self;
    if (this.beamOn) {
      // Сервер мог не принять заряд или сорвать его (блокировка маны, смерть)
      if (!s.charging && now - this.beamStart > 0.2) {
        this.beamOn = false;
        return "none";
      }
      if (!tb || tb.id !== this.beamTarget) {
        this.beamOn = false;
        this.nextBeam = now + 1;
        return "cancel";
      }
      const elapsed = now - this.beamStart;
      if (s.charge >= this.beamNeed - 0.02) {
        // Заряд набран — ждём, пока прицел сядет на цель; прошивающему видимость не нужна
        if (this.beamErr < this.beamTol && (los || this.beamPierce)) {
          this.beamOn = false;
          this.nextBeam = now + rnd(2, 4);
          return "release";
        }
        if (elapsed > this.beamNeed * 3 + 1.3) {
          this.beamOn = false;
          this.nextBeam = now + 1.5;
          return "cancel"; // так и не навёлся — не тратим ману
        }
      } else if (elapsed > 4.5) {
        this.beamOn = false;
        this.nextBeam = now + 2;
        return "cancel"; // мана не позволяет набрать нужное
      }
      return "hold";
    }

    if (!tb || now < this.nextBeam || s.cooldown > 0 || s.lock > 0) return "none";
    this.nextBeam = now + rnd(0.6, 1.4); // следующая попытка решения — не каждый тик
    const k = s.manaCost / BASE_STATS.manaCost;
    let c = 0;
    let pierce = false;
    if (los && dist >= 26 && dist <= 130) {
      // Нужный урон с запасом, с поправкой на затухание по дальности (крит за голову в расчёт не берём)
      const need = (tb.hp + 5) / falloffMul(dist, BEAM_FALLOFF);
      c = clamp((need - BEAM_DMG_MIN) / (BEAM_DMG_MAX - BEAM_DMG_MIN), 0.04, 1);
      if (Math.random() > 0.65 || s.mana < beamCost(c) * k + 15) return "none";
    } else if (!los && dist <= 70) {
      c = 1;
      pierce = true;
      if (Math.random() > 0.5 || s.mana < beamCost(1) * k * 0.98) return "none";
    } else return "none";
    this.beamOn = true;
    this.beamStart = now;
    this.beamNeed = c;
    this.beamPierce = pierce;
    this.beamTarget = tb.id;
    this.beamErr = 1;
    return "hold";
  }

  // ---------- Движение ----------

  private movement(ctx: BotCtx, tb: BotBody | null, tr: Tracker | null, dist: number, los: boolean, now: number): MoveInput {
    const pl = this.player;
    const ex = pl.x;
    const ez = pl.z;

    // Угроза от летящих зарядов
    const threats = this.findThreats(ctx, now);
    if (threats.length) this.chooseDodge(ctx, threats, now);
    else if (now > this.dodgeUntil) this.dodge = "none";

    if (this.dodge !== "none" && now <= this.dodgeUntil) return this.dodgeInput(threats, now);

    // Обычное намерение
    let wx = 0;
    let wz = 0;
    let sprint = false;
    let jump = false;
    let crouch = now < this.crouchUntil;

    const gadget = ctx.gadget;
    const gd = gadget ? Math.hypot(gadget.x - ex, gadget.z - ez) : Infinity;
    const busy = tb !== null && los && dist < 16;

    let cd = Infinity;
    let coin: { x: number; z: number } | null = null;
    for (const c of ctx.coins) {
      const d = Math.hypot(c.x - ex, c.z - ez);
      if (d < cd) {
        cd = d;
        coin = c;
      }
    }

    if (gadget && gd < 75 && !busy) {
      wx = (gadget.x - ex) / (gd || 1);
      wz = (gadget.z - ez) / (gd || 1);
      sprint = true;
      this.maybeHop(now, true);
    } else if (coin && cd < 50 && !busy) {
      wx = (coin.x - ex) / (cd || 1);
      wz = (coin.z - ez) / (cd || 1);
      sprint = true;
      this.maybeHop(now, true);
    } else if (tb && tr) {
      const ux = (tb.x - ex) / (dist || 1);
      const uz = (tb.z - ez) / (dist || 1);
      const rx = uz; // вправо от линии на цель
      const rz = -ux;

      // Стрейф: случайные развороты и паузы (ритм не ловится по периоду)
      const aimed = this.enemyAimsAtMe(tb, ex, ez, dist);
      if (now >= this.strafeUntil) {
        if (Math.random() < 0.75) this.strafeSign = -this.strafeSign;
        const pause = Math.random() < 0.15;
        this.strafeK = pause ? 0.15 : rnd(0.7, 1);
        this.strafeUntil = now + (pause ? rnd(0.12, 0.25) : rnd(0.3, 1.0)) * (aimed ? 0.65 : 1);
      }
      const locked = ctx.self.lock > 0 || ctx.self.mana < ctx.self.manaCost;
      let radial = 0;
      if (!los) radial = 1;
      else if (dist > this.hiRange + 4) radial = 1;
      else if (dist < this.loRange || locked) radial = -0.8;
      wx = ux * radial + rx * this.strafeSign * this.strafeK * (los ? 0.9 : 0.3);
      wz = uz * radial + rz * this.strafeSign * this.strafeK * (los ? 0.9 : 0.3);
      sprint = radial > 0.5 && dist > 24;

      // Прыжки и приседания «на нерве»: сбивают чужое упреждение
      if (dist > 7) this.maybeHop(now, false);
      if ((aimed || locked) && dist > 12 && now >= this.nextCrouch) {
        this.crouchUntil = now + rnd(0.25, 0.6);
        this.nextCrouch = now + rnd(1.0, 2.5);
        crouch = true;
      }
    } else {
      // Нет целей: бродим к случайной точке или туда, где недавно кто-то был
      if (!this.wp || now > this.wpUntil || Math.hypot(this.wp.x - ex, this.wp.z - ez) < 4) {
        const R = ctx.bound - 12;
        this.wp = { x: rnd(-R, R), z: rnd(-R, R) };
        this.wpUntil = now + rnd(5, 9);
      }
      const d = Math.hypot(this.wp.x - ex, this.wp.z - ez) || 1;
      wx = (this.wp.x - ex) / d;
      wz = (this.wp.z - ez) / d;
      sprint = true;
      this.maybeHop(now, true);
    }

    // Отталкиваемся от края карты
    const margin = 12;
    const ax = Math.abs(ex) - (ctx.bound - margin);
    if (ax > 0) wx -= Math.sign(ex) * clamp(ax / margin, 0, 1) * 1.6;
    const az = Math.abs(ez) - (ctx.bound - margin);
    if (az > 0) wz -= Math.sign(ez) * clamp(az / margin, 0, 1) * 1.6;

    // Прыжок по таймеру (выставляется maybeHop)
    if (this.hopNow) {
      jump = true;
      this.hopNow = false;
    }
    return this.toInput(wx, wz, sprint, jump, now < this.jumpHoldUntil, crouch);
  }

  private hopNow = false;

  // Застревание у стен: бот упёрся — обходит боком с прыжком, при повторе меняет путь
  private stuckCheckAt = 0;
  private stuckX = 0;
  private stuckZ = 0;
  private stuckCount = 0;
  private unstickUntil = 0;
  private unstickSide = 1;

  private unstick(input: MoveInput, now: number): MoveInput {
    const pl = this.player;
    if (now < this.unstickUntil) {
      return { fwd: input.fwd * 0.2, side: this.unstickSide, jump: false, jumpHeld: true, crouch: false, sprint: false };
    }
    if (now >= this.stuckCheckAt) {
      const wants = Math.abs(input.fwd) + Math.abs(input.side) > 0.5;
      const moved = Math.hypot(pl.x - this.stuckX, pl.z - this.stuckZ);
      this.stuckCheckAt = now + 0.5;
      this.stuckX = pl.x;
      this.stuckZ = pl.z;
      if (wants && moved < 0.8) {
        this.stuckCount++;
        this.unstickSide = Math.random() < 0.5 ? -1 : 1;
        this.unstickUntil = now + rnd(0.5, 0.9);
        if (this.stuckCount >= 2) this.wp = null; // не помогает — выбрать другую точку
        return { fwd: 0, side: this.unstickSide, jump: true, jumpHeld: true, crouch: false, sprint: false };
      }
      if (moved > 2) this.stuckCount = 0;
    }
    return input;
  }

  private maybeHop(now: number, running: boolean): void {
    if (now < this.hopAt || !this.player.onGround) return;
    this.hopAt = now + (running ? rnd(1.5, 4) : rnd(1.1, 3.2));
    this.hopNow = true;
    this.jumpHoldUntil = now + rnd(0.2, 0.55);
  }

  /** Враг целится в меня: его взгляд направлен на мою грудь с малой угловой ошибкой */
  private enemyAimsAtMe(e: BotBody, ex: number, ez: number, dist: number): boolean {
    if (dist < 4) return false;
    const toMe = Math.atan2(ex - e.x, ez - e.z);
    return Math.abs(wrap(toMe - e.yaw)) < 0.12;
  }

  private toInput(wx: number, wz: number, sprint: boolean, jump: boolean, jumpHeld: boolean, crouch: boolean): MoveInput {
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const len = Math.hypot(wx, wz);
    const k = len > 1 ? 1 / len : 1;
    return { fwd: (wx * sy + wz * cy) * k, side: (wx * cy - wz * sy) * k, jump, jumpHeld, crouch, sprint };
  }

  // ---------- Уклонение ----------

  /** Заряды врагов, которые пролетят близко к боту в ближайшие ~0.9 с и которые бот уже «заметил» */
  private findThreats(ctx: BotCtx, now: number): Threat[] {
    const pl = this.player;
    const out: Threat[] = [];
    const present = new Set<number>();
    for (const b of ctx.bolts) {
      if (b.owner === ctx.selfId) continue;
      present.add(b.id);
      const rx = b.x - pl.x;
      const ry = b.y - (pl.y + 0.8);
      const rz = b.z - pl.z;
      const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
      const tc = -(rx * b.vx + ry * b.vy + rz * b.vz) / v2;
      if (tc < 0.04 || tc > 0.9) continue;
      const cx = rx + b.vx * tc;
      const cy = ry + b.vy * tc;
      const cz = rz + b.vz * tc;
      if (cx * cx + cy * cy + cz * cz > 3.2 * 3.2) continue; // пролетит далеко — не угроза
      let first = this.seen.get(b.id);
      if (first === undefined) {
        first = now;
        this.seen.set(b.id, now);
      }
      if (now - first < this.reaction) continue; // ещё «не осознал»
      out.push({ bolt: b, tc });
    }
    for (const id of this.seen.keys()) if (!present.has(id)) this.seen.delete(id);
    out.sort((a, b) => a.tc - b.tc);
    if (out.length > 4) out.length = 4;
    return out;
  }

  /** Положение бота через t секунд при манёвре act (разгон к целевой скорости, прыжок — баллистикой) */
  private selfPath(act: Dodge, t: number, dirX: number, dirZ: number): { x: number; y: number; z: number; crouch: number } {
    const pl = this.player;
    const jump = act === "jump" || act === "jumpL" || act === "jumpR";
    const side = act === "left" || act === "jumpL" ? 1 : act === "right" || act === "jumpR" ? -1 : 0;
    const air = !pl.onGround || jump;
    const a = air ? AIR_ACCEL : GROUND_ACCEL;
    const vmax = BASE_SPEED * pl.speedMul * SPRINT_MULT;
    const e = (1 - Math.exp(-a * t)) / a;
    let x: number;
    let z: number;
    if (side !== 0) {
      const tx = dirX * side * vmax;
      const tz = dirZ * side * vmax;
      x = pl.x + tx * t + (pl.vx - tx) * e;
      z = pl.z + tz * t + (pl.vz - tz) * e;
    } else {
      // Продолжает как шла: скорость почти не меняется на таком коротком интервале
      x = pl.x + pl.vx * t;
      z = pl.z + pl.vz * t;
    }
    // Опора под ногами при приземлении неизвестна — считаем её на нынешнем уровне (на краю обрыва ниже)
    const y = air ? ballistic(pl.y, jump && pl.onGround ? JUMP_SPEED : pl.vy, t, pl.onGround ? pl.y : pl.y - 2) : pl.y;
    const crouch = act === "crouch" ? 1 - Math.exp(-10 * t) : pl.crouch * Math.exp(-4 * t);
    return { x, y, z, crouch };
  }

  /** Оценка манёвра: 0 — заденет, 1..3 — пролетит мимо с растущим запасом (минимум по всем угрозам) */
  private scoreDodge(act: Dodge, threats: Threat[], dirX: number, dirZ: number): number {
    if ((act === "jump" || act === "jumpL" || act === "jumpR") && !this.player.onGround) return 0; // в воздухе второго прыжка нет
    const horizon = threats[threats.length - 1].tc + 0.12;
    const N = 8;
    let worst = 3;
    for (const th of threats) {
      const b = th.bolt;
      let lvl = 3;
      for (let m = 0; m < MARGINS.length; m++) {
        let hit = false;
        for (let i = 0; i < N && !hit; i++) {
          const t0 = (horizon * i) / N;
          const t1 = (horizon * (i + 1)) / N;
          const s = this.selfPath(act, (t0 + t1) / 2, dirX, dirZ);
          hit = segmentVsBody(b.x + b.vx * t0, b.y + b.vy * t0, b.z + b.vz * t0, b.x + b.vx * t1, b.y + b.vy * t1, b.z + b.vz * t1, s.x, s.y, s.z, s.crouch, b.r + MARGINS[m]) !== null;
        }
        if (hit) {
          lvl = m;
          break;
        }
      }
      worst = Math.min(worst, lvl);
    }
    return worst;
  }

  private chooseDodge(_ctx: BotCtx, threats: Threat[], now: number): void {
    // Поперёк самого срочного заряда (по горизонтали); «влево» — против часовой
    const b = threats[0].bolt;
    const vh = Math.hypot(b.vx, b.vz);
    let dirX = 1;
    let dirZ = 0;
    if (vh > 1e-3) {
      dirX = -b.vz / vh;
      dirZ = b.vx / vh;
    }
    const noneScore = this.scoreDodge("none", threats, dirX, dirZ);
    if (noneScore >= 3) {
      if (now > this.dodgeUntil) this.dodge = "none";
      return; // и так пролетит с запасом
    }
    let bestAct: Dodge = "none";
    let bestVal = -Infinity;
    for (const act of DODGES) {
      const score = this.scoreDodge(act, threats, dirX, dirZ);
      // Цена манёвра и небольшая случайность; текущий манёвр удерживаем — иначе бот дёргается
      const val = score * 10 - DODGE_COST[act] + (act === this.dodge && now <= this.dodgeUntil ? 0.8 : 0) + Math.random() * 0.3;
      if (val > bestVal) {
        bestVal = val;
        bestAct = act;
      }
    }
    this.dodge = bestAct;
    this.dodgeUntil = now + threats[threats.length - 1].tc + 0.12;
    this.dodgeDir = [dirX, dirZ];
    if (bestAct === "jump" || bestAct === "jumpL" || bestAct === "jumpR") {
      if (this.player.onGround) this.hopNow = true;
      this.jumpHoldUntil = now + 0.5;
    }
  }

  private dodgeDir: [number, number] = [1, 0];

  private dodgeInput(_threats: Threat[], now: number): MoveInput {
    const [dx, dz] = this.dodgeDir;
    const act = this.dodge;
    const side = act === "left" || act === "jumpL" ? 1 : act === "right" || act === "jumpR" ? -1 : 0;
    const jump = this.hopNow;
    this.hopNow = false;
    const wx = dx * side;
    const wz = dz * side;
    const moving = side !== 0;
    // Без бокового шага продолжаем бежать как бежали (не стопорим бота)
    const keep = !moving ? Math.hypot(this.player.vx, this.player.vz) : 0;
    const kx = keep > 0.1 ? this.player.vx / keep : 0;
    const kz = keep > 0.1 ? this.player.vz / keep : 0;
    return this.toInput(moving ? wx : kx, moving ? wz : kz, true, jump, now < this.jumpHoldUntil, act === "crouch");
  }
}