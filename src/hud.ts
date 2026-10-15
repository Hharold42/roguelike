/**
 * HUD: полоски HP и маны, прицел с маркером попадания, вспышка урона, лента
 * убийств, таблица счёта и оверлей («соединение», «вы погибли»). Только DOM —
 * вся раскладка и стили в index.html и style.css, здесь лишь значения.
 */

import { BEAM_PIERCE_AT, CONE_DMG_MULT, MAX_HP, PLAYER_COLORS, beamDamage, colorCss } from "./shared/game";
import { gadgetById, perkById, slightById } from "./shared/balance";
import { SHOP_ITEMS } from "./shared/shop";
import { GADGET_RGB } from "./session";
import type { DamageNumber, KillEvent, Session } from "./session";

const FEED_MAX = 5;
const FEED_LIFE_MS = 5000;
const TOAST_MAX = 4;
const TOAST_LIFE_MS = 4000;
const ARROW_POOL = 4; // два пинга радара, стрелка к гаджету и к ближайшим монетам

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export class Hud {
  private readonly hpFill = $("hpFill");
  private readonly hpText = $("hpText");
  private readonly manaFill = $("manaFill");
  private readonly manaText = $("manaText");
  private readonly manaBar = this.manaFill.parentElement!;
  private readonly crosshair = $("crosshair");
  private readonly damage = $("damage");
  private readonly freezeFx = $("freeze");
  private readonly overlay = $("overlay");
  private readonly feed = $("feed");
  private readonly board = $("scoreboard");
  private readonly who = $("who");
  private readonly scope = $("scope");
  private readonly chargeBar = $("chargeBar");
  private readonly chargeFill = $("chargeFill");
  private readonly chargeText = $("chargeText");
  private readonly loadout = $("loadout");
  private readonly toasts = $("toasts");
  private readonly gold = $("gold");
  private readonly shop = $("shop");
  private shopOpen = false;
  private shopKey = "";
  /** Покупка: main пересылает серверу */
  onBuy: ((id: string) => void) | null = null;
  private readonly dmgHost = $("dmgNums");
  private readonly dmgNums: HTMLElement[] = [];
  private readonly arrows: HTMLElement[] = [];
  private readonly arrowLabels: HTMLElement[] = [];
  private identity = "";
  private boardKey = "";
  private loadoutKey = "";
  private gadgetChip: HTMLElement | null = null;

  constructor() {
    const host = $("arrows");
    for (let i = 0; i < ARROW_POOL; i++) {
      const a = document.createElement("div");
      a.className = "arrow";
      const label = document.createElement("span");
      a.append(label);
      host.append(a);
      this.arrows.push(a);
      this.arrowLabels.push(label);
    }
  }

  get isShopOpen(): boolean {
    return this.shopOpen;
  }

  /** Окно магазина: открыть/закрыть (force — задать явно) */
  toggleShop(force?: boolean): void {
    this.shopOpen = force ?? !this.shopOpen;
    this.shop.style.display = this.shopOpen ? "block" : "none";
    this.shopKey = "";
  }

  /** Купить товар по номеру в списке (клавиши 1…9) */
  buyByIndex(i: number): void {
    const item = SHOP_ITEMS[i];
    if (item) this.onBuy?.(item.id);
  }

  /** Список товаров: цена, состояние (куплено / хватает / не хватает); перестраивается при смене монет или покупок */
  private updateShop(s: Session): void {
    const me = s.me;
    this.gold.textContent = `◆ ${me.gold}`;
    if (!this.shopOpen) return;
    const key = `${me.gold}|${me.shop.join(",")}`;
    if (key === this.shopKey) return;
    this.shopKey = key;
    const head = document.createElement("div");
    head.className = "shop-head";
    head.textContent = `Магазин · ◆ ${me.gold} · E — закрыть · 1…9 — купить`;
    const rows = SHOP_ITEMS.map((item, i) => {
      const owned = me.shop.includes(item.id);
      const row = document.createElement("div");
      row.className = `shop-row ${owned ? "owned" : me.gold >= item.price ? "can" : "cant"}`;
      const title = document.createElement("div");
      title.className = "shop-title";
      title.textContent = `[${i + 1}] ${item.title} — ${owned ? "куплено" : `${item.price} ◆`}`;
      const desc = document.createElement("div");
      desc.className = "shop-desc";
      desc.textContent = item.desc;
      row.append(title, desc);
      row.addEventListener("click", () => this.onBuy?.(item.id));
      return row;
    });
    this.shop.replaceChildren(head, ...rows);
  }

  /** Всплывающая подсказка (полученное улучшение, сработавший перк) */
  toast(text: string): void {
    const row = document.createElement("div");
    row.className = "toast";
    row.textContent = text;
    this.toasts.append(row);
    while (this.toasts.children.length > TOAST_MAX) this.toasts.firstElementChild!.remove();
    window.setTimeout(() => row.remove(), TOAST_LIFE_MS);
  }

  /** Показать крупное сообщение по центру (null — скрыть) */
  say(text: string | null): void {
    this.overlay.textContent = text ?? "";
    this.overlay.style.display = text ? "block" : "none";
  }

  /** Подписать, кто я */
  setIdentity(color: number): void {
    const c = PLAYER_COLORS[color % PLAYER_COLORS.length];
    this.identity = `Вы — ${c.name}`;
    this.who.textContent = this.identity;
    this.who.style.borderColor = colorCss(color);
  }

  /** Хозяин сервера управляет ботами — подсказать клавиши */
  setHost(host: boolean): void {
    this.who.textContent = host ? `${this.identity} · хозяин (B — бот, N — убрать)` : this.identity;
  }

  /** Строка ленты: «■ убил ■» цветами игроков */
  addKill(e: KillEvent): void {
    const row = document.createElement("div");
    row.className = e.mine ? "feed-row mine" : "feed-row";
    const killer = document.createElement("span");
    killer.className = "dot";
    killer.style.background = colorCss(e.killer);
    const verb = document.createElement("span");
    verb.textContent = e.part === "head" ? "в голову" : "убил";
    const victim = document.createElement("span");
    victim.className = "dot";
    victim.style.background = colorCss(e.victim);
    row.append(killer, verb, victim);
    this.feed.prepend(row);
    while (this.feed.children.length > FEED_MAX) this.feed.lastElementChild!.remove();
    window.setTimeout(() => row.remove(), FEED_LIFE_MS);
  }

  /** Обновить значения по состоянию сессии (каждый кадр) */
  update(s: Session, yaw: number): void {
    const me = s.me;

    this.hpFill.style.width = `${(Math.max(0, me.hp) / MAX_HP) * 100}%`;
    this.hpText.textContent = String(Math.ceil(me.hp));

    // Мана: обычная полоска; при блокировке — прогресс восстановления вместо неё
    const locked = me.lock > 0;
    this.manaBar.classList.toggle("locked", locked);
    if (locked) {
      this.manaFill.style.width = `${(1 - me.lock / Math.max(0.01, me.lockTotal)) * 100}%`;
      this.manaText.textContent = `восстановление ${me.lock.toFixed(1)} с`;
    } else {
      this.manaFill.style.width = `${(me.mana / me.manaMax) * 100}%`;
      this.manaText.textContent = String(Math.floor(me.mana));
    }

    this.crosshair.classList.toggle("hit", s.hitMarker > 0);
    this.crosshair.classList.toggle("head", s.hitMarker > 0 && s.hitMarkerHead);
    this.damage.style.opacity = String(s.damageFlash * 0.6);
    this.freezeFx.style.opacity = String(s.frozen > 0 ? Math.min(1, (s.frozen / 0.25) * 1) : 0);

    if (!me.alive) this.say(`Вы погибли · возрождение через ${Math.ceil(me.respawn)}`);
    else if (this.overlay.style.display === "block" && this.overlay.dataset.dead === "1") this.say(null);
    this.overlay.dataset.dead = me.alive ? "0" : "1";

    this.updateCharge(me.charge, me.alive, me.shop.includes("cone") ? CONE_DMG_MULT : 1);
    this.updateBoard(s);
    this.updateLoadout(s);
    this.updateShop(s);
    this.updateArrows(s, yaw);
  }

  /** Полоска заряда луча под прицелом: урон растёт, на полном — «прошивает» */
  private updateCharge(c: number, alive: boolean, dmgMul: number): void {
    const on = alive && c >= 0;
    this.chargeBar.classList.toggle("on", on);
    this.scope.style.opacity = on ? String(Math.min(1, c * 1.2)) : "0";
    if (!on) return;
    this.chargeFill.style.width = `${c * 100}%`;
    const full = c >= BEAM_PIERCE_AT;
    this.chargeBar.classList.toggle("full", full);
    this.chargeText.textContent = full ? `${Math.round(beamDamage(c) * dmgMul)} · прошивает землю · эхолокация` : `${Math.round(beamDamage(c) * dmgMul)} урона${dmgMul > 1 ? " вблизи по оси" : ""}`;
  }

  /** Чипы: стопки лёгких улучшений, перк за смерть, гаджет с таймером */
  private updateLoadout(s: Session): void {
    const me = s.me;
    const slight = Object.entries(me.slight).filter(([, n]) => n > 0);
    const key = `${slight.map(([id, n]) => id + n).join(",")}|${me.perks.join(",")}|${me.gadget?.id ?? ""}|${me.shield ? 1 : 0}`;
    if (key !== this.loadoutKey) {
      this.loadoutKey = key;
      const chips: HTMLElement[] = [];
      const chip = (cls: string): HTMLElement => {
        const c = document.createElement("div");
        c.className = `chip ${cls}`;
        chips.push(c);
        return c;
      };
      for (const [id, n] of slight) chip("slight").textContent = `${slightById(id)?.title ?? id} ×${n}`;
      const perkCount = new Map<string, number>();
      for (const id of me.perks) perkCount.set(id, (perkCount.get(id) ?? 0) + 1);
      for (const [id, n] of perkCount) chip("perk").textContent = `${perkById(id)?.title ?? id}${n > 1 ? ` ×${n}` : ""}`;
      this.gadgetChip = null;
      if (me.gadget) {
        // Сгоревший щит остаётся в списке бледным, пока не кончится его время
        const c = chip(me.gadget.id === "shield" && !me.shield ? "gadget spent" : "gadget");
        c.dataset.title = gadgetById(me.gadget.id)?.title ?? me.gadget.id;
        this.gadgetChip = c;
      }
      this.loadout.replaceChildren(...chips);
    }
    // Таймер гаджета меняется каждый кадр, остальные чипы — только при смене набора
    if (this.gadgetChip && me.gadget) this.gadgetChip.textContent = `${this.gadgetChip.dataset.title} · ${Math.ceil(me.gadget.left)} с`;
  }

  /**
   * Цифры урона у врагов: каждая привязана к точке в мире, всплывает вверх и гаснет.
   * project — проекция мира на экран (доли 0..1) из рендера; элементы переиспользуются.
   */
  drawDamageNumbers(list: readonly DamageNumber[], project: (x: number, y: number, z: number) => { sx: number; sy: number; depth: number } | null): void {
    let used = 0;
    for (const n of list) {
      const p = project(n.x, n.y + n.age * 1.1, n.z);
      if (!p || p.sx < -0.1 || p.sx > 1.1 || p.sy < -0.1 || p.sy > 1.1) continue;
      let el = this.dmgNums[used];
      if (!el) {
        el = document.createElement("div");
        this.dmgHost.append(el);
        this.dmgNums.push(el);
      }
      used++;
      const text = n.dmg > 0 ? String(n.dmg) : "щит";
      if (el.textContent !== text) el.textContent = text;
      el.className = n.dmg <= 0 ? "dmg shield" : n.head ? "dmg head" : "dmg";
      // Размер падает с расстоянием, в первые мгновения цифра «выскакивает»
      const pop = n.age < 0.12 ? 1.5 - (n.age / 0.12) * 0.5 : 1;
      const scale = Math.min(1.7, Math.max(0.75, 16 / p.depth)) * pop;
      el.style.transform = `translate(${p.sx * window.innerWidth + n.jx}px, ${p.sy * window.innerHeight}px) translate(-50%, -50%) scale(${scale})`;
      el.style.opacity = String(Math.min(1, (n.ttl - n.age) / 0.3));
    }
    for (let i = used; i < this.dmgNums.length; i++) this.dmgNums[i].className = "dmg off";
  }

  /** Стрелки вокруг прицела: пинги радара и направление на гаджет на карте */
  private updateArrows(s: Session, yaw: number): void {
    const me = s.myPos;
    let n = 0;
    const show = (x: number, z: number, css: string): void => {
      if (n >= this.arrows.length) return;
      const dx = x - me.x;
      const dz = z - me.z;
      // Угол цели в осях yaw: вперёд = (sin, cos); положительный относительный угол — вправо
      const rel = Math.atan2(dx, dz) - yaw;
      const a = this.arrows[n];
      a.style.display = "block";
      a.style.setProperty("--c", css);
      a.style.transform = `rotate(${rel}rad)`;
      const label = this.arrowLabels[n];
      label.textContent = `${Math.round(Math.hypot(dx, dz))} м`;
      label.style.transform = `rotate(${-rel}rad)`;
      n++;
    };
    if (s.me.alive) {
      for (const p of s.pings) show(p.x, p.z, colorCss(p.color));
      const g = s.gadget;
      if (g) {
        const rgb = GADGET_RGB[g.kind] ?? [1, 1, 1];
        show(g.x, g.z, `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`);
      }
      const coin = s.nearestCoin();
      if (coin) show(coin.x, coin.z, "rgb(255,209,46)");
    }
    for (let i = n; i < this.arrows.length; i++) this.arrows[i].style.display = "none";
  }

  private updateBoard(s: Session): void {
    const rows = [...s.scoreboard].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    const key = rows.map((r) => `${r.id}:${r.color}:${r.kills}:${r.deaths}:${r.bot ? 1 : 0}`).join("|") + `@${s.id}`;
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.board.replaceChildren(
      ...rows.map((r) => {
        const row = document.createElement("div");
        row.className = r.id === s.id ? "score-row me" : "score-row";
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = colorCss(r.color);
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = PLAYER_COLORS[r.color % PLAYER_COLORS.length].name + (r.bot ? " (бот)" : "");
        const score = document.createElement("span");
        score.className = "score";
        score.textContent = `${r.kills} / ${r.deaths}`;
        row.append(dot, name, score);
        return row;
      }),
    );
  }
}
