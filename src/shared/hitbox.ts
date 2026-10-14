/**
 * Пересечение отрезка движения заряда с телом игрока (сфера головы + цилиндр
 * туловища). Общий код: по нему сервер считает попадания, а боты — траектории
 * уклонения (проверяют, заденет ли их заряд при том или ином манёвре).
 */

import { BODY_R, HEAD_R, bodyTopY, headCenterY } from "./game";
import type { HitPart } from "./game";

export interface Hit {
  t: number; // доля отрезка 0..1
  part: HitPart;
}

/**
 * Отрезок a→b против тела со ступнями в (px, py, pz) и приседом crouch (0..1),
 * с поправкой на радиус заряда boltR. Возвращает самое раннее пересечение;
 * при равенстве — голова.
 */
export function segmentVsBody(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  px: number,
  py: number,
  pz: number,
  crouch: number,
  boltR: number,
): Hit | null {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  let best: Hit | null = null;

  // Голова — сфера
  {
    const R = HEAD_R + boltR;
    const fx = ax - px;
    const fy = ay - headCenterY(py, crouch);
    const fz = az - pz;
    const a = dx * dx + dy * dy + dz * dz;
    const c = fx * fx + fy * fy + fz * fz - R * R;
    let t = -1;
    if (c <= 0) t = 0;
    else if (a > 1e-12) {
      const b = fx * dx + fy * dy + fz * dz;
      const disc = b * b - a * c;
      if (disc >= 0) t = (-b - Math.sqrt(disc)) / a;
    }
    if (t >= 0 && t <= 1) best = { t, part: "head" };
  }

  // Туловище — вертикальный цилиндр от ступней до низа сферы
  {
    const R = BODY_R + boltR;
    const y0 = py - boltR;
    const y1 = bodyTopY(py, crouch);
    const fx = ax - px;
    const fz = az - pz;
    const a = dx * dx + dz * dz;
    const c = fx * fx + fz * fz - R * R;
    let t = -1;
    if (c <= 0) {
      if (ay >= y0 && ay <= y1) t = 0;
    } else if (a > 1e-12) {
      const b = fx * dx + fz * dz;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const tt = (-b - Math.sqrt(disc)) / a;
        const y = ay + tt * dy;
        if (tt >= 0 && tt <= 1 && y >= y0 && y <= y1) t = tt;
      }
    }
    if (t >= 0 && (!best || t < best.t)) best = { t, part: "body" };
  }
  return best;
}
