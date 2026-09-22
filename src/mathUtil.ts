import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";

/** Поворот, при котором локальный +Z смотрит вдоль forward, а +Y — как можно ближе к up */
export function lookRotation(forward: Vector3, up: Vector3 = Vector3.Up()): Quaternion {
  const f = forward.normalizeToNew();
  let right = Vector3.Cross(up, f);
  if (right.lengthSquared() < 1e-8) right = Vector3.Cross(new Vector3(1, 0, 0), f);
  right.normalize();
  const realUp = Vector3.Cross(f, right).normalize();
  const m = Matrix.Identity();
  Matrix.FromXYZAxesToRef(right, realUp, f, m);
  return Quaternion.FromRotationMatrix(m);
}

/**
 * Кратчайшее расстояние между отрезками P0P1 и Q0Q1 (Ericson, Real-Time Collision Detection).
 * Возвращает расстояние и параметр s ∈ [0,1] ближайшей точки на P0P1.
 */
export function segmentSegmentDistance(
  p0: Vector3,
  p1: Vector3,
  q0: Vector3,
  q1: Vector3,
): { dist: number; s: number } {
  const d1 = p1.subtract(p0);
  const d2 = q1.subtract(q0);
  const r = p0.subtract(q0);
  const a = Vector3.Dot(d1, d1);
  const e = Vector3.Dot(d2, d2);
  const f = Vector3.Dot(d2, r);
  const EPS = 1e-9;
  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    return { dist: r.length(), s: 0 };
  }
  if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = Vector3.Dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = Vector3.Dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const cp = p0.add(d1.scale(s));
  const cq = q0.add(d2.scale(t));
  return { dist: Vector3.Distance(cp, cq), s };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
