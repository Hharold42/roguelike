/**
 * HUD: полоски HP и маны, прицел с маркером попадания, вспышка урона, лента
 * убийств, таблица счёта и оверлей («соединение», «вы погибли»). Только DOM —
 * вся раскладка и стили в index.html и style.css, здесь лишь значения.
 */

import { BEAM_PIERCE_AT, MAX_HP, PLAYER_COLORS, beamDamage, colorCss } from "./shared/game";
import { gadgetById, perkById, slightById } from "./shared/balance";
import { GADGET_RGB } from "./session";
import type { KillEvent, Session } from "./session";

const FEED_MAX = 5;
const FEED_LIFE_MS = 5000;
const TOAST_MAX = 4;
const TOAST_LIFE_MS = 4000;
const ARROW_POOL = 3; // два пинга радара и стрелка к гаджету

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export class Hud {
  private readonly hpFill = $("hpFill");
  private readonly hpText = $("hpText");
  private readonly manaFill = $("manaFill");
  private readonly manaText = $("manaText");
  private readonly manaBar = this.manaFill.parentElement!;
  private readonly crosshair = $("crosshair");
  private readonly damage = $("damage");
  private readonly overlay = $("overlay");
  private readonly feed = $("feed");
  private readonly board = $("scoreboard");
  private readonly who = $("who");
  private readonly chargeBar = $("chargeBar");
  private readonly chargeFill = $("chargeFill");
  private readonly chargeText = $("chargeText");
  private readonly loadout = $("loadout");
  private readonly toasts = $("toasts");
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

    if (!me.alive) this.say(`Вы погибли · возрождение через ${Math.ceil(me.respawn)}`);
    else if (this.overlay.style.display === "block" && this.overlay.dataset.dead === "1") this.say(null);
    this.overlay.dataset.dead = me.alive ? "0" : "1";

    this.updateCharge(me.charge, me.alive);
    this.updateBoard(s);
    this.updateLoadout(s);
    this.updateArrows(s, yaw);
  }

  /** Полоска заряда луча под прицелом: урон растёт, на полном — «прошивает» */
  private updateCharge(c: number, alive: boolean): void {
    const on = alive && c >= 0;
    this.chargeBar.classList.toggle("on", on);
    if (!on) return;
    this.chargeFill.style.width = `${c * 100}%`;
    const full = c >= BEAM_PIERCE_AT;
    this.chargeBar.classList.toggle("full", full);
    this.chargeText.textContent = full ? `${Math.round(beamDamage(c))} · прошивает землю` : `${Math.round(beamDamage(c))} урона`;
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
