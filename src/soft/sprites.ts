/**
 * Процедурные пиксель-спрайты софтверного рендера. Всё рисуется кодом при старте —
 * без ассетов. Формат: яркость (белая база с шейдингом) + альфа; цвет даёт тинт
 * при отрисовке, поэтому один человечек покрывает обычных врагов, элиту и боссов,
 * а вспышка урона — просто подмешивание красного в тинт.
 */

export interface Sprite {
  readonly w: number;
  readonly h: number;
  /** Яркость текселя 0..255 (умножается на тинт) */
  readonly lum: Uint8Array;
  /** Непрозрачность текселя 0..255 (<128 при отрисовке отсекается) */
  readonly alpha: Uint8Array;
}

/** Мини-холст для попиксельной сборки спрайта */
class Builder {
  readonly lum: Uint8Array;
  readonly alpha: Uint8Array;
  constructor(readonly w: number, readonly h: number) {
    this.lum = new Uint8Array(w * h);
    this.alpha = new Uint8Array(w * h);
  }

  px(x: number, y: number, lum: number, alpha = 255): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.lum[i] = lum;
    this.alpha[i] = alpha;
  }

  rect(x0: number, y0: number, x1: number, y1: number, lum: number, alpha = 255): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, lum, alpha);
  }

  /** Отрезок квадратной кистью halfW */
  line(x0: number, y0: number, x1: number, y1: number, halfW: number, lum: number, alpha = 255): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let dy = -halfW; dy <= halfW; dy++)
        for (let dx = -halfW; dx <= halfW; dx++) this.px(x + dx, y + dy, lum, alpha);
    }
  }

  disc(cx: number, cy: number, r: number, lum: number, alpha = 255): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) this.px(x, y, lum, alpha);
  }

  /**
   * Финалка: тёмный контур по силуэту и лёгкое затенение левого бока — дешёвый «объём».
   * outline — яркость контура (0.4 ≈ почти чёрный, читается на любом фоне),
   * side — множитель яркости левой половины.
   */
  finish(outline = 0.4, side = 0.85): Sprite {
    const { w, h, lum, alpha } = this;
    const outLum = Uint8Array.from(lum);
    const outAlpha = Uint8Array.from(alpha);
    const edge = (75 * outline) | 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (alpha[i] >= 128) {
          if (x < w / 2) outLum[i] = (lum[i] * side) | 0;
          continue;
        }
        // Пустой тексель рядом с телом — контур
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (alpha[ny * w + nx] >= 128) near = true;
          }
        if (near) {
          outAlpha[i] = 255;
          outLum[i] = edge;
        }
      }
    }
    return { w, h, lum: outLum, alpha: outAlpha };
  }
}

// ---------- Враг: человечек 14×20, кадры ходьбы и атаки ----------

function humanoid(frame: "walk0" | "walk1" | "attack"): Sprite {
  const b = new Builder(14, 20);
  const skin = 205; // голова светлее — считывается как лицо
  const body = 170;
  const dark = 120;
  if (frame === "attack") {
    // Замах: корпус подаётся вперёд (силуэт ниже и шире), руки вытянуты
    b.rect(4, 3, 9, 6, skin); // голова
    b.rect(3, 7, 10, 12, body); // торс
    b.rect(0, 7, 2, 9, dark); // руки вперёд-в стороны
    b.rect(11, 7, 13, 9, dark);
    b.rect(4, 13, 6, 19, dark); // ноги широко
    b.rect(8, 13, 10, 19, dark);
  } else {
    b.rect(5, 1, 8, 4, skin); // голова
    b.rect(4, 5, 9, 11, body); // торс
    if (frame === "walk0") {
      b.rect(2, 5, 3, 10, dark); // руки вдоль тела
      b.rect(10, 5, 11, 10, dark);
      b.rect(4, 12, 6, 19, dark); // ноги вместе
      b.rect(7, 12, 9, 19, dark);
    } else {
      b.rect(1, 6, 3, 10, dark); // руки вразмах
      b.rect(10, 6, 12, 10, dark);
      b.rect(2, 12, 5, 19, dark); // ноги ножницами
      b.rect(8, 12, 11, 19, dark);
    }
  }
  return b.finish();
}

export const ENEMY_WALK0 = humanoid("walk0");
export const ENEMY_WALK1 = humanoid("walk1");
export const ENEMY_ATTACK = humanoid("attack");
export const ENEMY_FRAMES: Sprite[] = [ENEMY_WALK0, ENEMY_WALK1];

// ---------- Монета 7×7: 4 кадра вращения (сплющивание) ----------

function coin(width: number): Sprite {
  const b = new Builder(7, 7);
  const x0 = (7 - width) / 2;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < width; x++) {
      const dy = y - 3;
      if (dy * dy > 10) continue;
      const edge = x === 0 || x === width - 1 || y <= 0 || y >= 6;
      b.px(x0 + x, y, edge ? 150 : 235);
    }
  }
  return b.finish(0.5, 1);
}

export const COIN_FRAMES: Sprite[] = [coin(7), coin(5), coin(3), coin(5)];

/** Купон колеса 8×5 */
function coupon(): Sprite {
  const b = new Builder(8, 5);
  b.rect(0, 0, 7, 4, 190);
  b.rect(1, 1, 6, 3, 230);
  b.px(0, 2, 90); // перфорация
  b.px(7, 2, 90);
  return b.finish(0.5, 1);
}
export const COUPON = coupon();

// ---------- Автоматика ----------

/** Летающий пистолет 10×6 */
function drone(): Sprite {
  const b = new Builder(10, 6);
  b.rect(1, 1, 6, 4, 160); // корпус
  b.rect(7, 2, 9, 3, 200); // ствол
  b.rect(2, 0, 4, 0, 210); // блик сверху
  b.rect(2, 5, 3, 5, 110); // подвес
  return b.finish();
}
export const DRONE = drone();

/** Орбитальный клинок: два кадра вращения 9×5 */
function blade(diag: boolean): Sprite {
  const b = new Builder(9, 5);
  if (diag) {
    b.line(1, 3, 7, 1, 0, 235);
    b.line(1, 1, 7, 3, 0, 150);
  } else {
    b.rect(0, 2, 8, 2, 235);
    b.rect(1, 1, 7, 1, 150);
    b.rect(1, 3, 7, 3, 150);
  }
  return b.finish(0.5, 1);
}
export const BLADE_FRAMES: Sprite[] = [blade(false), blade(true)];

/** Бумеранг 7×7: крестовина, два кадра */
function boomerang(cross: boolean): Sprite {
  const b = new Builder(7, 7);
  if (cross) {
    b.line(1, 1, 5, 5, 0, 220);
    b.line(5, 1, 1, 5, 0, 220);
  } else {
    b.rect(3, 0, 3, 6, 220);
    b.rect(0, 3, 6, 3, 220);
  }
  b.px(3, 3, 255);
  return b.finish(0.5, 1);
}
export const BOOMERANG_FRAMES: Sprite[] = [boomerang(false), boomerang(true)];

/** Снаряд мортиры 5×5 */
function shell(): Sprite {
  const b = new Builder(5, 5);
  b.disc(2, 2, 2, 170);
  b.px(2, 2, 255);
  b.px(1, 1, 220);
  return b.finish(0.6, 1);
}
export const SHELL = shell();

/** Луч маяка 6×48: яркое ядро, прозрачные края, затухание кверху */
function beaconBeam(): Sprite {
  const b = new Builder(6, 48);
  for (let y = 0; y < 48; y++) {
    const fade = 0.55 + 0.45 * (y / 48); // книзу ярче
    b.px(2, y, 255 * fade, 255);
    b.px(3, y, 255 * fade, 255);
    b.px(1, y, 190 * fade, 140);
    b.px(4, y, 190 * fade, 140);
    b.px(0, y, 120 * fade, 50);
    b.px(5, y, 120 * fade, 50);
  }
  return { w: 6, h: 48, lum: b.lum, alpha: b.alpha };
}
export const BEACON_BEAM = beaconBeam();

// ---------- Вьюмодель (оружие в руках, рисуется поверх кадра) ----------

/** Пистолет 44×30: вид сзади-сбоку, ствол вверх */
function gunViewmodel(): Sprite {
  const b = new Builder(44, 30);
  b.rect(18, 2, 25, 12, 130); // затвор
  b.rect(19, 0, 24, 2, 165); // ствол сверху
  b.rect(20, 1, 23, 1, 220); // блик ствола
  b.rect(17, 4, 18, 8, 100); // левая грань
  b.rect(26, 4, 27, 8, 105);
  b.rect(19, 12, 26, 14, 110); // рамка
  b.rect(21, 14, 28, 26, 95); // рукоять
  b.rect(22, 15, 27, 25, 120);
  b.rect(19, 15, 20, 20, 80); // спускная скоба
  b.px(21, 1, 255); // мушка
  return b.finish(0.35, 0.9);
}
export const GUN_VIEW = gunViewmodel();

/** Вспышка выстрела 14×12 — на конце ствола */
function muzzleFlash(): Sprite {
  const b = new Builder(14, 12);
  b.disc(7, 5, 3, 255);
  b.line(7, 0, 7, 10, 0, 240, 200);
  b.line(1, 5, 13, 5, 0, 240, 200);
  b.line(3, 1, 11, 9, 0, 220, 160);
  b.line(11, 1, 3, 9, 0, 220, 160);
  return { w: 14, h: 12, lum: b.lum, alpha: b.alpha };
}
export const MUZZLE_FLASH = muzzleFlash();

/** Меч 40×36: idle — клинок по диагонали, взмах — горизонтальный взмах со шлейфом */
function swordView(frame: "idle" | "swing0" | "swing1"): Sprite {
  const b = new Builder(40, 36);
  const edge = 235;
  const flat = 150;
  if (frame === "idle") {
    b.line(31, 27, 12, 6, 1, flat); // клинок
    b.line(31, 27, 12, 6, 0, edge);
    b.line(27, 23, 34, 30, 1, 110); // гарда
    b.line(33, 31, 37, 35, 1, 90); // рукоять
  } else if (frame === "swing0") {
    b.line(33, 28, 8, 14, 1, flat);
    b.line(33, 28, 8, 14, 0, edge);
    b.line(29, 25, 36, 32, 1, 110);
    b.line(35, 31, 38, 35, 1, 90);
    // Шлейф взмаха
    b.line(30, 22, 6, 8, 0, 200, 90);
  } else {
    b.line(32, 30, 4, 26, 1, flat);
    b.line(32, 30, 4, 26, 0, edge);
    b.line(28, 27, 35, 33, 1, 110);
    b.line(34, 32, 38, 35, 1, 90);
    b.line(28, 24, 3, 20, 0, 200, 90);
    b.line(30, 20, 8, 14, 0, 170, 60);
  }
  return b.finish(0.35, 0.95);
}
export const SWORD_IDLE = swordView("idle");
export const SWORD_SWING0 = swordView("swing0");
export const SWORD_SWING1 = swordView("swing1");
