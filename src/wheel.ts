/** Приз на колесе. weight — относительный шанс; за каждым призом идёт пустой сектор такого же размера */
export interface WheelSlot {
  id: string;
  title: string;
  desc: string;
  weight: number;
  color: string;
}

export interface WheelState {
  /** Цена следующего вращения */
  price: number;
  gold: number;
  /** Следующее вращение бесплатно (купон) */
  free: boolean;
}

export interface WheelCallbacks {
  state: () => WheelState;
  /** Списать цену вращения; false — денег нет, крутить нельзя */
  pay: () => boolean;
  /** Колесо остановилось: приз или null (пустой сектор) */
  result: (slot: WheelSlot | null) => void;
  close: () => void;
}

interface Segment {
  slot: WheelSlot | null;
  /** Границы сектора в локальных углах колеса: 0 — вверх (под стрелкой), по часовой */
  a0: number;
  a1: number;
  color: string;
}

const SPIN_TIME = 4.2; // с
const MIN_TURNS = 5; // полных оборотов до остановки
const R = 250; // радиус колеса, px
const R_IN = 54; // радиус ступицы
const EMPTY_COLORS = ["#1b1b27", "#22222f"];
const TAU = Math.PI * 2;

/**
 * Колесо фортуны: canvas 2D. Каждый второй сектор пустой; размер сектора пропорционален весу приза,
 * так что шанс приза = его доля среди призов × 50 %. Остановка — равномерный случайный угол,
 * то есть колесо честное: что нарисовано, то и выпадает.
 */
export interface WheelOptions {
  /** Префикс id элементов: `${prefix}Overlay`, `${prefix}Canvas`, `${prefix}Spin`, … */
  prefix?: string;
  /** Каждый второй сектор пустой (проигрыш). Иначе на колесе только призы */
  empties?: boolean;
  /** Крутится само сразу после открытия, кнопки «крутить» нет */
  autoSpin?: boolean;
}

const AUTO_SPIN_DELAY = 0.45; // с после открытия

export class FortuneWheel {
  /** Открытые колёса, верхнее — последнее: клавиши слушает только оно */
  private static stack: FortuneWheel[] = [];

  private overlay: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private spinBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private priceEl: HTMLElement;
  private resultEl: HTMLElement;
  private legendEl: HTMLElement;
  private readonly empties: boolean;
  private readonly autoSpin: boolean;

  private segments: Segment[] = [];
  private rotation = 0;
  private spinning = false;
  private highlight = -1;
  private cb: WheelCallbacks | null = null;
  private raf = 0;
  private autoTimer = 0;
  /** Сколько раз колесо крутили (для HUD и тестов) */
  spins = 0;
  /** Доля пустых секторов (0.5 — каждый второй такого же размера; «Счастливая монета» сжимает до 0.4) */
  emptyShare = 0.5;
  /** Пробел/Enter крутят колесо только когда открыта его вкладка (магазин делит с ним экран) */
  keysEnabled = true;

  constructor(opts: WheelOptions = {}) {
    const p = opts.prefix ?? "wheel";
    this.empties = opts.empties ?? true;
    this.autoSpin = opts.autoSpin ?? false;
    this.overlay = document.getElementById(`${p}Overlay`)!;
    this.canvas = document.getElementById(`${p}Canvas`) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.spinBtn = document.getElementById(`${p}Spin`) as HTMLButtonElement;
    this.closeBtn = document.getElementById(`${p}Close`) as HTMLButtonElement;
    this.priceEl = document.getElementById(`${p}Price`)!;
    this.resultEl = document.getElementById(`${p}Result`)!;
    this.legendEl = document.getElementById(`${p}Legend`)!;
    if (this.autoSpin) this.spinBtn.style.display = "none";

    this.spinBtn.onclick = () => this.spin();
    this.closeBtn.onclick = () => this.close();
    window.addEventListener("keydown", (e) => {
      if (!this.isTop || e.repeat) return;
      if (e.code === "Escape") this.close();
      if ((e.code === "Space" || e.code === "Enter") && !this.autoSpin && this.keysEnabled) this.spin();
    });
  }

  get isOpen(): boolean {
    return this.cb !== null;
  }

  /** Это колесо сверху (поверх него не открыто другое) */
  get isTop(): boolean {
    return this.isOpen && FortuneWheel.stack[FortuneWheel.stack.length - 1] === this;
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  open(slots: WheelSlot[], cb: WheelCallbacks): void {
    this.cb = cb;
    FortuneWheel.stack.push(this);
    this.highlight = -1;
    this.resultEl.textContent = "";
    this.resultEl.classList.remove("win", "lose");
    this.setSlots(slots);
    this.overlay.style.display = "flex";
    this.refreshUi();
    if (this.autoSpin) this.autoTimer = window.setTimeout(() => this.spin(), AUTO_SPIN_DELAY * 1000);
  }

  /** Обновить набор призов (например, оружие выиграно и ушло с колеса) — поворот сохраняется */
  setSlots(slots: WheelSlot[]): void {
    const sum = slots.reduce((s, x) => s + x.weight, 0);
    const prizeShare = this.empties ? 1 - this.emptyShare : 1;
    // Пустой сектор за призом — пропорционален ему: суммарно пустые занимают ровно emptyShare колеса
    const emptyRatio = this.empties ? this.emptyShare / prizeShare : 0;
    this.segments = [];
    let a = 0;
    slots.forEach((slot, i) => {
      const w = (slot.weight / sum) * prizeShare * TAU;
      this.segments.push({ slot, a0: a, a1: a + w, color: slot.color });
      a += w;
      if (this.empties) {
        this.segments.push({ slot: null, a0: a, a1: a + w * emptyRatio, color: EMPTY_COLORS[i % 2] });
        a += w * emptyRatio;
      }
    });
    this.renderLegend(slots, sum);
    this.draw();
  }

  close(): void {
    if (!this.cb || this.spinning) return;
    const cb = this.cb;
    this.cb = null;
    FortuneWheel.stack = FortuneWheel.stack.filter((w) => w !== this);
    this.overlay.style.display = "none";
    cancelAnimationFrame(this.raf);
    clearTimeout(this.autoTimer);
    cb.close();
  }

  /**
   * Крутить. landAngle — локальный угол остановки (для тестов), иначе случайный;
   * duration 0 — мгновенно. Возвращает false, если крутится или нечем платить.
   */
  spin(landAngle?: number, duration = SPIN_TIME): boolean {
    if (!this.cb || this.spinning || this.segments.length === 0) return false;
    if (!this.cb.pay()) return false;
    this.spins++;
    this.spinning = true;
    this.highlight = -1;
    this.resultEl.textContent = "";
    this.resultEl.classList.remove("win", "lose");
    this.refreshUi();

    const theta = landAngle === undefined ? Math.random() * TAU : ((landAngle % TAU) + TAU) % TAU;
    // Под стрелкой оказывается локальный угол (−rotation mod 2π): подбираем конечный поворот
    // с этим углом, не меньше MIN_TURNS оборотов вперёд от текущего
    const k = Math.ceil((this.rotation + TAU * MIN_TURNS + theta) / TAU);
    const finalRot = -theta + TAU * k;
    const startRot = this.rotation;
    const delta = finalRot - startRot;

    if (duration <= 0) {
      this.rotation = finalRot;
      this.finish();
      return true;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / (duration * 1000));
      const eased = 1 - Math.pow(1 - t, 3);
      this.rotation = startRot + delta * eased;
      this.draw();
      if (t < 1) this.raf = requestAnimationFrame(tick);
      else this.finish();
    };
    this.raf = requestAnimationFrame(tick);
    return true;
  }

  /** Сектор под стрелкой при текущем повороте */
  private segmentUnderPointer(): number {
    const theta = (((-this.rotation) % TAU) + TAU) % TAU;
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (theta >= s.a0 && theta < s.a1) return i;
    }
    return this.segments.length - 1;
  }

  private finish(): void {
    this.spinning = false;
    const i = this.segmentUnderPointer();
    this.highlight = i;
    const seg = this.segments[i];
    this.draw();
    if (seg.slot) {
      this.resultEl.innerHTML = `<b>${seg.slot.title}</b> — ${seg.slot.desc}`;
      this.resultEl.classList.add("win");
    } else {
      this.resultEl.textContent = "Пусто — но есть утешительное колесо";
      this.resultEl.classList.add("lose");
    }
    this.cb?.result(seg.slot);
    // Приз мог изменить набор (оружие ушло с колеса) — Game вызывает setSlots; тут только UI
    this.refreshUi();
  }

  refreshUi(): void {
    if (!this.cb) return;
    const st = this.cb.state();
    if (this.autoSpin) {
      this.priceEl.innerHTML = this.spinning ? "Крутится…" : this.highlight >= 0 ? "Готово" : "Бесплатное вращение — крутится само";
    } else {
      const canPay = st.free || st.gold >= st.price;
      this.priceEl.innerHTML = st.free
        ? `Вращение <b>бесплатно</b> (купон) · у вас ${st.gold} золота`
        : `Вращение: <b>${st.price}</b> золота · у вас ${st.gold}`;
      this.spinBtn.textContent = this.spinning ? "Крутится…" : st.free ? "Крутить бесплатно" : `Крутить за ${st.price}`;
      this.spinBtn.disabled = this.spinning || !canPay;
    }
    this.closeBtn.disabled = this.spinning;
  }

  private renderLegend(slots: WheelSlot[], sum: number): void {
    const share = this.empties ? (1 - this.emptyShare) * 100 : 100;
    const rows = slots
      .map(
        (s) =>
          `<li><span class="sw" style="background:${s.color}"></span><b>${s.title}</b>` +
          `<span class="pct">${((s.weight / sum) * share).toFixed(1)}%</span><div>${s.desc}</div></li>`,
      )
      .join("");
    const empty = this.empties
      ? `<li class="empty"><span class="sw"></span><b>Пусто</b><span class="pct">${Math.round(this.emptyShare * 100)}%</span><div>Каждый второй сектор — утешительное колесо</div></li>`
      : "";
    this.legendEl.innerHTML = empty + rows;
  }

  private draw(): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(cx, cy);

    // Обод
    ctx.beginPath();
    ctx.arc(0, 0, R + 8, 0, TAU);
    ctx.fillStyle = "#0d0d14";
    ctx.fill();

    ctx.save();
    ctx.rotate(this.rotation);
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      const start = s.a0 - Math.PI / 2;
      const end = s.a1 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, start, end);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.stroke();

      // Подпись вдоль радиуса
      const width = s.a1 - s.a0;
      const mid = (s.a0 + s.a1) / 2 - Math.PI / 2;
      const chord = (R_IN + 16) * width;
      const font = Math.max(9, Math.min(14, Math.floor(chord * 0.8)));
      ctx.save();
      ctx.rotate(mid);
      ctx.font = `${s.slot ? "600 " : ""}${font}px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = s.slot ? "#f4f4f8" : "#5a5a70";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const label = s.slot ? fitText(ctx, s.slot.title, R - R_IN - 30) : "пусто";
      ctx.fillText(label, R_IN + 14, 0);
      ctx.restore();
    }
    // Победный сектор — белая рамка
    if (this.highlight >= 0) {
      const s = this.segments[this.highlight];
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, s.a0 - Math.PI / 2, s.a1 - Math.PI / 2);
      ctx.closePath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    ctx.restore();

    // Ступица
    ctx.beginPath();
    ctx.arc(0, 0, R_IN, 0, TAU);
    ctx.fillStyle = "#15151f";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffd166";
    ctx.stroke();

    // Стрелка сверху (неподвижна)
    ctx.beginPath();
    ctx.moveTo(-14, -R - 16);
    ctx.lineTo(14, -R - 16);
    ctx.lineTo(0, -R + 16);
    ctx.closePath();
    ctx.fillStyle = "#ffd166";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#0d0d14";
    ctx.stroke();

    ctx.restore();
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}
