import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { HeightFn } from "./player";

const COIN_SIZE = 0.16;
const MAX_COINS_PER_DROP = 5; // крупная сумма падает несколькими монетами, но не сотней
const GRAVITY = 22;
const POP_SPEED = 5.5; // подброс при выпадении
const BOUNCE = 0.35;
const MAGNET_DIST = 4.5; // ближе этого монета летит к игроку (базово; предмет «Магнит» увеличивает)
const MAGNET_ACCEL = 40;
const MAGNET_MAX = 18;
const PICK_DIST = 0.75;
const LIFETIME = 25; // с, потом исчезает
const SPIN = 3.2; // рад/с

export type PickupKind = "gold" | "coupon";

export interface Coin {
  kind: PickupKind;
  pos: Vector3;
  vel: Vector3;
  value: number;
  age: number;
  /** Летит к игроку */
  magnet: boolean;
  floor: number;
  /** Угол вращения (кадр спрайта) */
  spin: number;
  /** Масштаб спрайта (крупная монета — больше) */
  size: number;
}

/**
 * Золото: монеты — чистые данные (позиция, скорость), рисует их софтверный рендер спрайтами.
 * Выпадают из врага, подпрыгивают, ложатся на землю, рядом с игроком притягиваются и подбираются.
 * Той же физикой падают и купоны колеса (не исчезают со временем).
 */
export class GoldPool {
  /** Живые монеты и купоны — рендер читает напрямую */
  readonly coins: Coin[] = [];
  /** Радиус притяжения монет к игроку */
  magnetDist = MAGNET_DIST;
  /** Подобранные купоны, ещё не забранные игрой (`takeCoupons`) */
  private coupons = 0;

  /** Во сколько раз радиус притяжения больше базового (для HUD) */
  get magnetMult(): number {
    return this.magnetDist / MAGNET_DIST;
  }

  /** Выпадение amount золота в точке (центр врага) */
  spawn(at: Vector3, amount: number, floor: number): void {
    if (amount <= 0) return;
    const n = Math.min(MAX_COINS_PER_DROP, amount);
    const base = Math.floor(amount / n);
    let rest = amount - base * n;
    for (let i = 0; i < n; i++) {
      const value = base + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
      this.drop("gold", value, at, floor);
    }
  }

  /** Выпадение купона колеса фортуны */
  spawnCoupon(at: Vector3, floor: number): void {
    this.drop("coupon", 1, at, floor);
  }

  /** Забрать подобранные купоны (обнуляет счётчик) */
  takeCoupons(): number {
    const n = this.coupons;
    this.coupons = 0;
    return n;
  }

  private drop(kind: PickupKind, value: number, at: Vector3, floor: number): void {
    const a = Math.random() * Math.PI * 2;
    const h = 1.5 + Math.random() * 2;
    const pos = at.clone();
    pos.y += 0.2;
    this.coins.push({
      kind,
      pos,
      vel: new Vector3(Math.cos(a) * h, POP_SPEED * (0.8 + Math.random() * 0.5), Math.sin(a) * h),
      value,
      age: 0,
      magnet: false,
      floor,
      spin: Math.random() * Math.PI * 2,
      size: kind === "gold" ? 1 + 0.25 * Math.min(3, value - 1) : 1,
    });
  }

  /** Физика и подбор. Возвращает собранное за кадр золото. */
  update(dt: number, playerPos: Vector3, getFloor: HeightFn): number {
    let collected = 0;
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      c.age += dt;
      c.spin += SPIN * dt;
      const dx = playerPos.x - c.pos.x;
      const dy = playerPos.y - 0.3 - c.pos.y; // к поясу
      const dz = playerPos.z - c.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (!c.magnet && d2 < this.magnetDist * this.magnetDist) c.magnet = true;

      if (c.magnet) {
        const d = Math.sqrt(d2) || 1e-3;
        if (d < PICK_DIST) {
          if (c.kind === "gold") collected += c.value;
          else this.coupons += c.value;
          this.coins.splice(i, 1);
          continue;
        }
        // Разгон к игроку, старую скорость гасим
        c.vel.scaleInPlace(Math.max(0, 1 - dt * 6));
        c.vel.addInPlace(new Vector3(dx / d, dy / d, dz / d).scaleInPlace(MAGNET_ACCEL * dt));
        const v = c.vel.length();
        if (v > MAGNET_MAX) c.vel.scaleInPlace(MAGNET_MAX / v);
        c.pos.addInPlace(c.vel.scale(dt));
      } else {
        c.vel.y -= GRAVITY * dt;
        c.pos.addInPlace(c.vel.scale(dt));
        const floor = getFloor(c.pos.x, c.pos.z) + COIN_SIZE;
        if (c.pos.y < floor) {
          c.pos.y = floor;
          if (c.vel.y < -1) {
            c.vel.y = -c.vel.y * BOUNCE;
            c.vel.x *= 0.6;
            c.vel.z *= 0.6;
          } else {
            c.vel.set(0, 0, 0);
          }
        }
        if (c.kind === "gold" && c.age > LIFETIME) {
          this.coins.splice(i, 1); // купоны не исчезают
          continue;
        }
      }
      // Лежащая монета чуть «дышит», чтобы читалась
      c.floor = getFloor(c.pos.x, c.pos.z);
    }
    return collected;
  }
}
