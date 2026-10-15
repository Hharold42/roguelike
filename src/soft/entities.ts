/**
 * Сущности поверх мира в софтверном кадре: игроки (цветные сфера + цилиндр),
 * летящие заряды, искры попаданий и палочка от первого лица.
 *
 * Игроки рисуются не мешами, а точным лучом на пиксель: для каждого пикселя
 * габаритного прямоугольника решается пересечение луча со сферой и вертикальным
 * цилиндром. Параметр луча t при направлении D = F + u·R + v·U равен плоской
 * глубине fd — ровно тому, что лежит в z-буфере мира, поэтому тест глубины
 * честный: холмы и трава закрывают игроков, игроки — траву. Цвет проходит тот
 * же туман, палитру 6 уровней и дизеринг Байера, что и земля.
 *
 * Постройки (платформы, стены, лестницы) — оси-выровненные коробки; рисуются
 * тем же приёмом: на пиксель решается пересечение луча с коробкой (slab-тест),
 * t снова равно глубине, так что они честно закрывают игроков и закрываются
 * рельефом. Кладка (кирпич/плита) считается по точке попадания.
 *
 * «Эхолокация»: враги, до которых дошла волна, рисуются как призраки — их
 * контур (обод по нормали) и слабая заливка поверх всего, без z-теста.
 */

import { FOG_COL, SUN_X, SUN_Y, SUN_Z } from "./columnMap";
import { BAYER, FOG_LUT, LEVELS, Z_FAR } from "./gfx";
import type { Box } from "../structures";
import { coneTan } from "../shared/game";
import { BODY_R, BOLT_R, CROUCH_DROP, HEAD_CY, HEAD_R, BODY_TOP, PLAYER_COLORS } from "../shared/game";

export interface DrawPlayer {
  x: number; // ступни
  y: number;
  z: number;
  yaw: number;
  crouch: number;
  color: number; // индекс PLAYER_COLORS
  /** Вспышка попадания 0..1 */
  flash: number;
  /** Заряд луча 0..1 (0 — не заряжает): растущее свечение у палочки */
  charge: number;
}

/** Луч заряженного выстрела: толщина, яркость и белизна растут с зарядом c */
export interface DrawBeam {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Заряд 0..1 */
  c: number;
  /** Прошил рельеф: рисуется и сквозь землю */
  pierce: boolean;
  /** Перк «Крупный заряд»: луч шире */
  big: boolean;
  color: number;
  /** Остаток жизни 0..1 */
  life: number;
  /** Конусный луч: рисуется расширяющимся к цели */
  cone: boolean;
}

/** Призрак врага от эхолокации: рисуется поверх всего контуром */
export interface DrawGhost {
  x: number;
  y: number;
  z: number;
  yaw: number;
  crouch: number;
  /** Яркость 0..1 (гаснет за долю секунды) */
  alpha: number;
}

/** Расходящаяся волна эхолокации (кольцо по земле) */
export interface DrawWave {
  x: number;
  y: number;
  z: number;
  /** Текущий радиус, юниты */
  r: number;
  /** Яркость 0..1 */
  alpha: number;
}

/** Всё, что рисуется на эхолокации и постройках */
export interface SceneExtras {
  boxes: readonly Box[];
  ghosts: readonly DrawGhost[];
  waves: readonly DrawWave[];
  groundAt: (x: number, z: number) => number;
}

export interface DrawBolt {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  color: number;
  /** Радиус заряда в юнитах (крупный заряд шире обычного) */
  r: number;
}

/** Гаджет на карте: светящийся шар на столбе света */
export interface DrawGadget {
  x: number;
  y: number;
  z: number;
  rgb: [number, number, number];
  /** Монеты: низкий столб и шар поменьше */
  coin?: boolean;
}

export interface DrawSpark {
  x: number;
  y: number;
  z: number;
  /** Остаток жизни 0..1 */
  life: number;
  color: number;
}

/** Параметры камеры кадра (те же, что у SoftRenderer) */
export interface CamFrame {
  W: number;
  H: number;
  focal: number;
  x: number;
  y: number;
  z: number;
  sinY: number;
  cosY: number;
  sinP: number;
  cosP: number;
}

const CONE_VIS_MAX = 110; // дальше этого конус на экране не рисуется (дальше он и так гаснет)
const BIG_BEAM_VIS = 2.2; // во сколько раз «крупный» луч толще на экране
const BOLT_VIS_R = 0.14; // видимый радиус ядра заряда, юниты
const Z_MIN = 0.05;
const ECHO_RGB: [number, number, number] = [0.35, 0.95, 1];
/** Цвет кладки по материалу (MAT_WALL, MAT_PLATFORM, MAT_STAIRS) */
const BOX_COLORS: [number, number, number][] = [
  [0.54, 0.49, 0.45],
  [0.64, 0.6, 0.52],
  [0.7, 0.6, 0.4],
  [0.46, 0.58, 0.68], // летающие платформы — холоднее и светлее камня
];
const BOX_NEAR = 0.1;
/** Игроки теряются в тумане и в мелкости: туман на них слабее, а на экране они не тоньше этого радиуса (px) */
const PLAYER_FOG = 0.35;
const MIN_PLAYER_PX = 1.5;
/** Маячок над врагом: с какой дальности и насколько крупный (px) */
const MARKER_FROM = 16;

function cellHash(a: number, b: number, c: number): number {
  let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class EntityLayer {
  private pix!: Uint8ClampedArray;
  private zbuf!: Float32Array;
  private cam!: CamFrame;
  // базис камеры в мировых осях
  private fx = 0;
  private fy = 0;
  private fz = 0;
  private rx = 1;
  private rz = 0;
  private ux = 0;
  private uy = 1;
  private uz = 0;

  render(
    pix: Uint8ClampedArray,
    zbuf: Float32Array,
    cam: CamFrame,
    players: Iterable<DrawPlayer>,
    bolts: Iterable<DrawBolt>,
    sparks: Iterable<DrawSpark>,
    gadgets: Iterable<DrawGadget>,
    beams: Iterable<DrawBeam>,
    time: number,
    extras: SceneExtras,
  ): void {
    this.pix = pix;
    this.zbuf = zbuf;
    this.cam = cam;
    this.fx = cam.sinY * cam.cosP;
    this.fy = cam.sinP;
    this.fz = cam.cosY * cam.cosP;
    this.rx = cam.cosY;
    this.rz = -cam.sinY;
    this.ux = -cam.sinY * cam.sinP;
    this.uy = cam.cosP;
    this.uz = -cam.cosY * cam.sinP;

    for (const b of extras.boxes) this.drawBox(b);
    for (const p of players) {
      this.drawPlayer(p, 0);
      if (p.charge > 0) this.drawChargeOrb(p, time);
      this.drawMarker(p, time);
    }
    for (const g of gadgets) this.drawGadget(g, time);
    for (const b of bolts) this.drawBolt(b);
    for (const bm of beams) {
      if (bm.cone) this.drawCone(bm); // объём конуса, поверх него — тонкое ядро луча
      this.drawBeam(bm);
    }
    for (const s of sparks) this.drawSpark(s);
    for (const w of extras.waves) this.drawWave(w, extras.groundAt);
    for (const g of extras.ghosts) {
      this.drawPlayer({ x: g.x, y: g.y, z: g.z, yaw: g.yaw, crouch: g.crouch, color: 0, flash: 0, charge: 0 }, g.alpha);
    }
  }

  /**
   * Маячок над головой врага вдали: мигающая цветная точка постоянного размера на экране.
   * Закрывается землёй и стенами по z-буферу, так что через препятствия не светит.
   */
  private drawMarker(p: DrawPlayer, time: number): void {
    const c = this.cam;
    const y = p.y + BODY_TOP + 0.6 - CROUCH_DROP * p.crouch;
    const fd = this.depth(p.x, y, p.z);
    if (fd < MARKER_FROM) return;
    const rgb = PLAYER_COLORS[p.color % PLAYER_COLORS.length].rgb;
    const fade = Math.min(1, (fd - MARKER_FROM) / 14); // появляется плавно
    const gain = (0.6 + 0.3 * Math.sin(time * 6)) * fade;
    this.disc(p.x, y, p.z, (1.6 * fd) / c.focal, rgb, gain, 0.4);
  }

  // ---------- Постройки ----------

  private bbMinX = 0;
  private bbMaxX = 0;
  private bbMinY = 0;
  private bbMaxY = 0;

  private bbAdd(x: number, y: number, z: number, fd: number): void {
    const sx = this.screenX(x, y, z, fd);
    const sy = this.screenY(x, y, z, fd);
    if (sx < this.bbMinX) this.bbMinX = sx;
    if (sx > this.bbMaxX) this.bbMaxX = sx;
    if (sy < this.bbMinY) this.bbMinY = sy;
    if (sy > this.bbMaxY) this.bbMaxY = sy;
  }

  private readonly cx8 = new Float64Array(8);
  private readonly cy8 = new Float64Array(8);
  private readonly cz8 = new Float64Array(8);
  private readonly cd8 = new Float64Array(8);

  private drawBox(b: Box): void {
    const c = this.cam;
    // Дальше дальности тумана — не видно
    const ddx = Math.max(0, Math.abs(c.x - (b.x0 + b.x1) * 0.5) - (b.x1 - b.x0) * 0.5);
    const ddz = Math.max(0, Math.abs(c.z - (b.z0 + b.z1) * 0.5) - (b.z1 - b.z0) * 0.5);
    if (ddx * ddx + ddz * ddz > Z_FAR * Z_FAR) return;

    // Экранный габарит: рёбра коробки, обрезанные плоскостью near
    const X = this.cx8;
    const Y = this.cy8;
    const Z = this.cz8;
    const D = this.cd8;
    let front = 0;
    for (let i = 0; i < 8; i++) {
      X[i] = i & 1 ? b.x1 : b.x0;
      Y[i] = i & 2 ? b.top : b.bot;
      Z[i] = i & 4 ? b.z1 : b.z0;
      D[i] = this.depth(X[i], Y[i], Z[i]);
      if (D[i] >= BOX_NEAR) front++;
    }
    if (front === 0) return;
    this.bbMinX = this.bbMinY = Infinity;
    this.bbMaxX = this.bbMaxY = -Infinity;
    for (let bit = 1; bit <= 4; bit <<= 1) {
      for (let i = 0; i < 8; i++) {
        if (i & bit) continue;
        const j = i | bit;
        const fi = D[i] >= BOX_NEAR;
        const fj = D[j] >= BOX_NEAR;
        if (fi && fj) {
          this.bbAdd(X[i], Y[i], Z[i], D[i]);
          this.bbAdd(X[j], Y[j], Z[j], D[j]);
        } else if (fi || fj) {
          const a = fi ? i : j;
          const o = fi ? j : i;
          const t = (BOX_NEAR - D[a]) / (D[o] - D[a]);
          this.bbAdd(X[a], Y[a], Z[a], D[a]);
          this.bbAdd(X[a] + (X[o] - X[a]) * t, Y[a] + (Y[o] - Y[a]) * t, Z[a] + (Z[o] - Z[a]) * t, BOX_NEAR);
        }
      }
    }
    const x0 = Math.max(0, Math.floor(this.bbMinX) - 1);
    const x1 = Math.min(c.W - 1, Math.ceil(this.bbMaxX) + 1);
    const y0 = Math.max(0, Math.floor(this.bbMinY) - 1);
    const y1 = Math.min(c.H - 1, Math.ceil(this.bbMaxY) + 1);
    if (x0 > x1 || y0 > y1) return;

    const ox = c.x;
    const oy = c.y;
    const oz = c.z;
    const ax0 = b.x0 - ox;
    const ax1 = b.x1 - ox;
    const ay0 = b.bot - oy;
    const ay1 = b.top - oy;
    const az0 = b.z0 - oz;
    const az1 = b.z1 - oz;
    const base = BOX_COLORS[b.mat] ?? BOX_COLORS[0];
    const { W, focal } = c;
    const halfW = W / 2;
    const halfH = c.H / 2;
    const zbuf = this.zbuf;

    for (let py = y0; py <= y1; py++) {
      const v = (halfH - py) / focal;
      const rowBase = py * W;
      for (let px = x0; px <= x1; px++) {
        const pi = rowBase + px;
        const u = (px - halfW) / focal;
        const dx = this.fx + u * this.rx + v * this.ux;
        const dy = this.fy + v * this.uy;
        const dz = this.fz + u * this.rz + v * this.uz;

        const ix = 1 / dx;
        const iy = 1 / dy;
        const iz = 1 / dz;
        let t1 = ax0 * ix;
        let t2 = ax1 * ix;
        const tnx = t1 < t2 ? t1 : t2;
        let tmax = t1 < t2 ? t2 : t1;
        t1 = ay0 * iy;
        t2 = ay1 * iy;
        const tny = t1 < t2 ? t1 : t2;
        const txy = t1 < t2 ? t2 : t1;
        t1 = az0 * iz;
        t2 = az1 * iz;
        const tnz = t1 < t2 ? t1 : t2;
        const txz = t1 < t2 ? t2 : t1;
        let tmin = tnx > tny ? tnx : tny;
        if (tnz > tmin) tmin = tnz;
        if (txy < tmax) tmax = txy;
        if (txz < tmax) tmax = txz;
        if (!(tmin <= tmax) || tmin < Z_MIN || tmin >= zbuf[pi]) continue;

        const hx = ox + tmin * dx;
        const hy = oy + tmin * dy;
        const hz = oz + tmin * dz;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let tex: number;
        if (tmin === tny) {
          // Верх (низ не виден): плиты 1×1 с швами
          ny = dy < 0 ? 1 : -1;
          const gx = Math.floor(hx);
          const gz = Math.floor(hz);
          const fx = hx - gx;
          const fz = hz - gz;
          tex = fx < 0.05 || fz < 0.05 ? 0.76 : 0.96 + 0.1 * cellHash(gx, gz, b.mat);
        } else {
          // Бока: кирпичная кладка рядами по 0.5, кирпич 1.2, ряды смещены
          let a: number;
          if (tmin === tnx) {
            nx = dx > 0 ? -1 : 1;
            a = hz;
          } else {
            nz = dz > 0 ? -1 : 1;
            a = hx;
          }
          const depthDown = (b.top - hy) / 0.5;
          const row = Math.floor(depthDown);
          const fr = depthDown - row;
          const au = (a + (row & 1) * 0.6) / 1.2;
          const col = Math.floor(au);
          const fc = au - col;
          tex = fr < 0.1 || fc < 0.05 ? 0.64 : 0.92 + 0.14 * cellHash(row, col, b.mat + 7);
        }

        const lam = nx * SUN_X + ny * SUN_Y + nz * SUN_Z;
        const k = (0.4 + 0.6 * (lam > 0 ? lam : 0)) * tex;
        let r = base[0] * k;
        let g = base[1] * k;
        let bl = base[2] * k;
        const fogI = (tmin / Z_FAR) * 511;
        const f = FOG_LUT[fogI > 511 ? 511 : fogI | 0];
        r += (FOG_COL[0] - r) * f;
        g += (FOG_COL[1] - g) * f;
        bl += (FOG_COL[2] - bl) * f;
        zbuf[pi] = tmin;
        this.put(pi, px, py, r, g, bl);
      }
    }
  }

  // ---------- Эхолокация ----------

  /** Кольцо волны по земле: ряд мягких дисков, видно и из-за неровностей */
  private drawWave(w: DrawWave, groundAt: (x: number, z: number) => number): void {
    if (w.alpha <= 0.02 || w.r < 1) return;
    const n = Math.min(110, Math.max(28, Math.floor(w.r * 1.4)));
    const gain = 0.55 * w.alpha;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = w.x + Math.cos(a) * w.r;
      const z = w.z + Math.sin(a) * w.r;
      this.disc(x, groundAt(x, z) + 0.15, z, 0.45, ECHO_RGB, gain, 0.8);
    }
  }

  // ---------- Проекция ----------

  /** Плоская глубина точки (расстояние вдоль оси камеры) */
  private depth(x: number, y: number, z: number): number {
    const c = this.cam;
    return (x - c.x) * this.fx + (y - c.y) * this.fy + (z - c.z) * this.fz;
  }

  /** Экранные координаты точки с известной глубиной fd */
  private screenX(x: number, y: number, z: number, fd: number): number {
    const c = this.cam;
    return c.W / 2 + (((x - c.x) * this.rx + (z - c.z) * this.rz) * c.focal) / fd;
  }

  private screenY(x: number, y: number, z: number, fd: number): number {
    const c = this.cam;
    return c.H / 2 - (((x - c.x) * this.ux + (y - c.y) * this.uy + (z - c.z) * this.uz) * c.focal) / fd;
  }

  // ---------- Игрок ----------

  /** ghost > 0 — режим призрака эхолокации: без z-теста, только контур и слабая заливка */
  private drawPlayer(p: DrawPlayer, ghost: number): void {
    const c = this.cam;
    const drop = CROUCH_DROP * p.crouch;
    const hcy = p.y + HEAD_CY - drop; // центр головы
    const top = p.y + BODY_TOP - drop; // верх цилиндра
    const col = PLAYER_COLORS[p.color % PLAYER_COLORS.length].rgb;

    // Габарит по экрану: сфера и цилиндр, с запасом на растяжение по краям кадра
    const fdH = this.depth(p.x, hcy, p.z);
    const fdB = this.depth(p.x, p.y, p.z);
    const fdT = this.depth(p.x, top, p.z);
    if (fdH < -1 && fdB < -1 && fdT < -1) return; // целиком за спиной
    // Вдали фигура не тоньше MIN_PLAYER_PX пикселей в радиусе: иначе враг превращается в невидимую нитку
    const grow = Math.max(1, (MIN_PLAYER_PX * Math.max(fdH, fdB, 1)) / (c.focal * BODY_R));
    const hr = HEAD_R * grow;
    const br = BODY_R * grow;
    let x0 = 0;
    let y0 = 0;
    let x1 = c.W - 1;
    let y1 = c.H - 1;
    const fdMin = Math.min(fdH - hr, fdB - br, fdT - br);
    if (fdMin > 0.3) {
      // Всё перед камерой: bbox по точкам оси и радиусу
      const pad = (2.0 * c.focal * br) / fdMin + 2;
      const sxH = this.screenX(p.x, hcy, p.z, fdH);
      const syH = this.screenY(p.x, hcy, p.z, fdH);
      const sxB = this.screenX(p.x, p.y, p.z, fdB);
      const syB = this.screenY(p.x, p.y, p.z, fdB);
      x0 = Math.max(0, Math.floor(Math.min(sxH, sxB) - pad));
      x1 = Math.min(c.W - 1, Math.ceil(Math.max(sxH, sxB) + pad));
      y0 = Math.max(0, Math.floor(Math.min(syH, syB) - pad));
      y1 = Math.min(c.H - 1, Math.ceil(Math.max(syH, syB) + pad));
      if (x0 > x1 || y0 > y1) return;
    }

    // Константы пересечений
    const ox = c.x;
    const oy = c.y;
    const oz = c.z;
    // сфера
    const mx = ox - p.x;
    const my = oy - hcy;
    const mz = oz - p.z;
    const sphC = mx * mx + my * my + mz * mz - hr * hr;
    // цилиндр
    const ex = ox - p.x;
    const ez = oz - p.z;
    const cylC = ex * ex + ez * ez - br * br;
    const nearest = Math.min(fdH - hr, fdB - br);
    const faceX = Math.sin(p.yaw);
    const faceZ = Math.cos(p.yaw);
    const { W, focal } = c;
    const halfW = W / 2;
    const halfH = c.H / 2;

    for (let py = y0; py <= y1; py++) {
      const v = (halfH - py) / focal;
      const rowBase = py * W;
      for (let px = x0; px <= x1; px++) {
        const pi = rowBase + px;
        const zb = this.zbuf[pi];
        if (ghost === 0 && zb < nearest - 0.02) continue; // всё ближе игрока уже закрыто миром
        const u = (px - halfW) / focal;
        const dx = this.fx + u * this.rx + v * this.ux;
        const dy = this.fy + v * this.uy;
        const dz = this.fz + u * this.rz + v * this.uz;

        let bestT = ghost > 0 ? 1e9 : zb;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let kind = 0; // 1 голова, 2 туловище

        // Сфера-голова
        {
          const a = dx * dx + dy * dy + dz * dz;
          const b = mx * dx + my * dy + mz * dz;
          const disc = b * b - a * sphC;
          if (disc >= 0) {
            const t = (-b - Math.sqrt(disc)) / a;
            if (t > Z_MIN && t < bestT) {
              bestT = t;
              nx = (mx + t * dx) / hr;
              ny = (my + t * dy) / hr;
              nz = (mz + t * dz) / hr;
              kind = 1;
            }
          }
        }
        // Цилиндр-туловище: боковая стенка и верхнее кольцо
        {
          const a = dx * dx + dz * dz;
          if (a > 1e-9) {
            const b = ex * dx + ez * dz;
            const disc = b * b - a * cylC;
            if (disc >= 0) {
              const t = (-b - Math.sqrt(disc)) / a;
              const y = oy + t * dy;
              if (t > Z_MIN && t < bestT && y >= p.y && y <= top) {
                bestT = t;
                nx = (ex + t * dx) / br;
                ny = 0;
                nz = (ez + t * dz) / br;
                kind = 2;
              }
            }
          }
          if (oy > top && dy < 0) {
            const t = (top - oy) / dy;
            if (t > Z_MIN && t < bestT) {
              const hx = ex + t * dx;
              const hz = ez + t * dz;
              if (hx * hx + hz * hz <= br * br) {
                bestT = t;
                nx = 0;
                ny = 1;
                nz = 0;
                kind = 2;
              }
            }
          }
        }
        if (kind === 0) continue;

        if (ghost > 0) {
          // Обод: чем косее поверхность к лучу, тем ярче — получается контур фигуры
          const facing = Math.abs(nx * dx + ny * dy + nz * dz) / Math.sqrt(dx * dx + dy * dy + dz * dz);
          const rim = 1 - facing;
          const edge = rim <= 0.45 ? 0 : rim >= 0.85 ? 1 : (rim - 0.45) / 0.4;
          const w = ghost * (0.16 + 0.84 * edge);
          const i = pi * 4;
          const pr = this.pix[i] / 255;
          const pg = this.pix[i + 1] / 255;
          const pb = this.pix[i + 2] / 255;
          this.put(pi, px, py, pr + (ECHO_RGB[0] - pr) * w, pg + (ECHO_RGB[1] - pg) * w, pb + (ECHO_RGB[2] - pb) * w);
          continue;
        }

        // Свет: закатное солнце + ровный ambient
        const lam = nx * SUN_X + ny * SUN_Y + nz * SUN_Z;
        let k = 0.42 + 0.58 * (lam > 0 ? lam : 0);
        let r = col[0];
        let g = col[1];
        let b = col[2];
        if (kind === 1) {
          // Забрало: тёмная полоса на стороне взгляда — видно, куда смотрит игрок
          const face = nx * faceX + nz * faceZ;
          if (face > 0.5 && ny > -0.3 && ny < 0.5) {
            r *= 0.12;
            g *= 0.12;
            b *= 0.14;
          }
        } else {
          const yy = oy + bestT * dy;
          if (yy < p.y + 0.5) k *= 0.72; // «ноги» темнее — силуэт читается
        }
        r *= k;
        g *= k;
        b *= k;
        if (p.flash > 0) {
          r += (1 - r) * p.flash;
          g += (1 - g) * p.flash;
          b += (1 - b) * p.flash;
        }
        const fz = (bestT / Z_FAR) * 511;
        const f = FOG_LUT[fz > 511 ? 511 : fz | 0] * PLAYER_FOG;
        r += (FOG_COL[0] - r) * f;
        g += (FOG_COL[1] - g) * f;
        b += (FOG_COL[2] - b) * f;
        this.zbuf[pi] = bestT;
        this.put(pi, px, py, r, g, b);
      }
    }
  }

  /** Записать цвет 0..1 в палитру 6 уровней с дизерингом Байера */
  private put(pi: number, px: number, py: number, r: number, g: number, b: number): void {
    const d = BAYER[((py & 3) << 2) | (px & 3)];
    const i = pi * 4;
    const pix = this.pix;
    pix[i] = 255 * Math.min(1, Math.floor(r * LEVELS + d) / LEVELS);
    pix[i + 1] = 255 * Math.min(1, Math.floor(g * LEVELS + d) / LEVELS);
    pix[i + 2] = 255 * Math.min(1, Math.floor(b * LEVELS + d) / LEVELS);
    pix[i + 3] = 255;
  }

  // ---------- Заряды и искры ----------

  /**
   * Светящийся диск в точке мира: ядро светлее, к краю свечение гаснет и
   * подмешивается к тому, что уже нарисовано. radius — юниты, gain — яркость.
   */
  private disc(wx: number, wy: number, wz: number, radius: number, rgb: [number, number, number], gain: number, occludeBias: number): void {
    const c = this.cam;
    const fd = this.depth(wx, wy, wz);
    if (fd < 0.2) return;
    const sx = this.screenX(wx, wy, wz, fd);
    const sy = this.screenY(wx, wy, wz, fd);
    const rp = Math.max(1.1, (radius * c.focal) / fd);
    const glow = rp * 2.2;
    const x0 = Math.max(0, Math.floor(sx - glow));
    const x1 = Math.min(c.W - 1, Math.ceil(sx + glow));
    const y0 = Math.max(0, Math.floor(sy - glow));
    const y1 = Math.min(c.H - 1, Math.ceil(sy + glow));
    const { pix, zbuf } = this;
    for (let py = y0; py <= y1; py++) {
      const dy = py - sy;
      for (let px = x0; px <= x1; px++) {
        const dx = px - sx;
        const d = Math.sqrt(dx * dx + dy * dy) / rp; // 0 — центр, 1 — край ядра
        if (d > 2.2) continue;
        const pi = py * c.W + px;
        if (zbuf[pi] < fd - occludeBias) continue; // закрыт землёй/игроком
        // Яркость: ядро ≈ 1, дальше экспоненциальный спад свечения
        const w = (d < 1 ? 1 : Math.exp(-(d - 1) * 2.2)) * gain;
        if (w < 0.04) continue;
        const core = d < 0.55 ? 1 - d / 0.55 : 0; // белая сердцевина
        const i = pi * 4;
        const r = pix[i] / 255 + (rgb[0] + core) * w;
        const g = pix[i + 1] / 255 + (rgb[1] + core) * w;
        const b = pix[i + 2] / 255 + (rgb[2] + core) * w;
        this.put(pi, px, py, r > 1 ? 1 : r, g > 1 ? 1 : g, b > 1 ? 1 : b);
      }
    }
  }

  private drawBolt(b: DrawBolt): void {
    const rgb = PLAYER_COLORS[b.color % PLAYER_COLORS.length].rgb;
    const vis = BOLT_VIS_R * (b.r / BOLT_R); // крупный заряд виден крупнее
    // Хвост из затухающих дисков против скорости: заряд виден летящим
    for (let i = 3; i >= 1; i--) {
      this.disc(b.x - b.vx * 0.011 * i, b.y - b.vy * 0.011 * i, b.z - b.vz * 0.011 * i, vis * (1 - i * 0.18), rgb, 0.5 - i * 0.1, 0.15);
    }
    this.disc(b.x, b.y, b.z, vis, rgb, 1, 0.15);
  }

  /** Свечение заряжаемого луча у палочки игрока: растёт и пульсирует с зарядом */
  private drawChargeOrb(p: DrawPlayer, time: number): void {
    const rgb = PLAYER_COLORS[p.color % PLAYER_COLORS.length].rgb;
    const sy = Math.sin(p.yaw);
    const cy = Math.cos(p.yaw);
    const y = p.y + 1.2 - CROUCH_DROP * p.crouch;
    const pulse = 1 + Math.sin(time * (10 + 20 * p.charge)) * 0.12;
    const x = p.x + sy * 0.55 + cy * 0.18;
    const z = p.z + cy * 0.55 - sy * 0.18;
    this.disc(x, y, z, (0.07 + 0.3 * p.charge) * pulse, rgb, 0.6 + 0.9 * p.charge, 0.15);
    this.disc(x, y, z, (0.04 + 0.12 * p.charge) * pulse, [1, 1, 1], 0.5 + p.charge, 0.15);
  }

  /**
   * Луч: проекция концов на экран и шаг вдоль линии, на каждом шаге мягкий диск
   * с радиусом по глубине. Слабый — тонкая цветная нить; полный заряд — толстый,
   * белый внутри, с широким свечением, и виден даже сквозь землю.
   */
  private drawBeam(b: DrawBeam): void {
    const c = this.cam;
    const rgb = PLAYER_COLORS[b.color % PLAYER_COLORS.length].rgb;
    let ax = b.ax;
    let ay = b.ay;
    let az = b.az;
    let bx = b.bx;
    let by = b.by;
    let bz = b.bz;
    let fdA = this.depth(ax, ay, az);
    let fdB = this.depth(bx, by, bz);
    const NEAR = 0.25;
    if (fdA < NEAR && fdB < NEAR) return;
    // Отсечение по ближней плоскости
    if (fdA < NEAR) {
      const t = (NEAR - fdA) / (fdB - fdA);
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      az += (bz - az) * t;
      fdA = NEAR;
    } else if (fdB < NEAR) {
      const t = (NEAR - fdB) / (fdA - fdB);
      bx += (ax - bx) * t;
      by += (ay - by) * t;
      bz += (az - bz) * t;
      fdB = NEAR;
    }
    const sxA = this.screenX(ax, ay, az, fdA);
    const syA = this.screenY(ax, ay, az, fdA);
    const sxB = this.screenX(bx, by, bz, fdB);
    const syB = this.screenY(bx, by, bz, fdB);
    const len = Math.hypot(sxB - sxA, syB - syA);
    if (!(len < 20000)) return;

    // Радиус и яркость: нить 0.025 → колонна 0.17; гаснет вместе с жизнью
    const radius = (0.025 + 0.145 * b.c * b.c) * (b.big ? BIG_BEAM_VIS : 1) * (0.35 + 0.65 * b.life);
    const gain = (0.55 + 0.75 * b.c) * b.life;
    // Слабый луч — цвет игрока; сильный выгорает в белый
    const hot = 0.25 + 0.75 * b.c;
    const invA = 1 / fdA;
    const invB = 1 / fdB;
    const { pix, zbuf } = this;
    const W = c.W;
    let s = 0;
    let guard = 0;
    while (s <= 1 && guard++ < 4000) {
      const x = sxA + (sxB - sxA) * s;
      const y = syA + (syB - syA) * s;
      const inv = invA + (invB - invA) * s; // 1/глубина линейна по экрану
      const fd = 1 / inv;
      const rp = Math.max(1, radius * c.focal * inv);
      // Шаг по экрану ≈ треть радиуса: диски перекрываются без дыр, но без перерасхода
      const step = Math.max(1, rp * 0.35);
      s += len > 0 ? step / len : 2;
      if (x < -rp * 3 || y < -rp * 3 || x > W + rp * 3 || y > c.H + rp * 3) continue;
      const glow = rp * 3;
      const x0 = Math.max(0, Math.floor(x - glow));
      const x1 = Math.min(W - 1, Math.ceil(x + glow));
      const y0 = Math.max(0, Math.floor(y - glow));
      const y1 = Math.min(c.H - 1, Math.ceil(y + glow));
      const k = Math.min(1, step / rp) * 0.9; // доля яркости за диск при частых шагах
      for (let py = y0; py <= y1; py++) {
        const dy = py - y;
        for (let px = x0; px <= x1; px++) {
          const dx = px - x;
          const d = Math.sqrt(dx * dx + dy * dy) / rp;
          if (d > 3) continue;
          const pi = py * W + px;
          let occl = 1;
          if (zbuf[pi] < fd - 0.3) {
            if (!b.pierce) continue; // обычный луч закрыт землёй
            occl = 0.5; // прошивший — виден сквозь землю, но тусклее
          }
          const w = (d < 1 ? 1 : Math.exp(-(d - 1) * 1.6)) * gain * k * occl;
          if (w < 0.03) continue;
          const core = d < 0.6 ? (1 - d / 0.6) * hot : 0;
          const i = pi * 4;
          const r = pix[i] / 255 + (rgb[0] + core) * w;
          const g = pix[i + 1] / 255 + (rgb[1] + core) * w;
          const bl = pix[i + 2] / 255 + (rgb[2] + core) * w;
          this.put(pi, px, py, r > 1 ? 1 : r, g > 1 ? 1 : g, bl > 1 ? 1 : bl);
        }
      }
    }
  }

  private bbPts = new Float64Array(3 * 18);

  /** Длина пересечения отрезка [lo, hi] с [a, b] */
  private static overlap(lo: number, hi: number, a: number, b: number): number {
    const m = (hi < b ? hi : b) - (lo > a ? lo : a);
    return m > 0 ? m : 0;
  }

  /**
   * Конусный луч как настоящий конус: вершина у руки, ось по лучу, полуугол по заряду.
   * На каждый пиксель решается пересечение его луча с телом конуса (квадратное уравнение),
   * яркость — по длине хорды внутри конуса (толще в центре, тоньше к краю) плюс ровная
   * подложка, поэтому силуэт читается чётким краем. Закрывается землёй по z-буферу
   * (прошивающий — виден и за ней, вдвое слабее). Раскрывается за первые ~15% жизни и гаснет;
   * дальний конец тускнеет.
   */
  private drawCone(b: DrawBeam): void {
    const c = this.cam;
    const ex = b.bx - b.ax;
    const ey = b.by - b.ay;
    const ez = b.bz - b.az;
    const L0 = Math.hypot(ex, ey, ez);
    if (L0 < 0.5 || b.life <= 0) return;
    const sweep = Math.min(1, (1 - b.life) * 7 + 0.15);
    const L = Math.min(L0, CONE_VIS_MAX) * sweep;
    const ux = ex / L0;
    const uy = ey / L0;
    const uz = ez / L0;
    const k = coneTan(b.c);
    const k2 = 1 + k * k;

    // Базис кольца: два вектора, перпендикулярные оси
    let hx = 0;
    let hy = 1;
    let hz = 0;
    if (Math.abs(uy) > 0.95) {
      hx = 1;
      hy = 0;
    }
    let p1x = uy * hz - uz * hy;
    let p1y = uz * hx - ux * hz;
    let p1z = ux * hy - uy * hx;
    const pl = Math.hypot(p1x, p1y, p1z) || 1;
    p1x /= pl;
    p1y /= pl;
    p1z /= pl;
    const p2x = uy * p1z - uz * p1y;
    const p2y = uz * p1x - ux * p1z;
    const p2z = ux * p1y - uy * p1x;

    // Экранный габарит: вершина и два кольца (на L/2 и L); точки за камерой — весь кадр
    const NEAR = 0.15;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let front = 0;
    let behind = 0;
    const addPt = (x: number, y: number, z: number): void => {
      const fd = this.depth(x, y, z);
      if (fd < NEAR) {
        behind++;
        return;
      }
      front++;
      const sx = this.screenX(x, y, z, fd);
      const sy = this.screenY(x, y, z, fd);
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    };
    addPt(b.ax, b.ay, b.az);
    for (const f of [0.5, 1]) {
      const d = L * f;
      const R = k * d;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const cs = Math.cos(a) * R;
        const sn = Math.sin(a) * R;
        addPt(b.ax + ux * d + p1x * cs + p2x * sn, b.ay + uy * d + p1y * cs + p2y * sn, b.az + uz * d + p1z * cs + p2z * sn);
      }
    }
    if (front === 0) return;
    let x0 = 0;
    let y0 = 0;
    let x1 = c.W - 1;
    let y1 = c.H - 1;
    if (behind === 0) {
      x0 = Math.max(0, Math.floor(minX) - 1);
      x1 = Math.min(c.W - 1, Math.ceil(maxX) + 1);
      y0 = Math.max(0, Math.floor(minY) - 1);
      y1 = Math.min(c.H - 1, Math.ceil(maxY) + 1);
      if (x0 > x1 || y0 > y1) return;
    }

    const rgb = PLAYER_COLORS[b.color % PLAYER_COLORS.length].rgb;
    const gain = (0.55 + 0.35 * b.c) * b.life;
    const ox = c.x;
    const oy = c.y;
    const oz = c.z;
    const wx = ox - b.ax;
    const wy = oy - b.ay;
    const wz = oz - b.az;
    const wu = wx * ux + wy * uy + wz * uz;
    const ww = wx * wx + wy * wy + wz * wz;
    const C0 = ww - k2 * wu * wu;
    const { W, focal } = c;
    const halfW = W / 2;
    const halfH = c.H / 2;
    const zbuf = this.zbuf;
    const pix = this.pix;
    const ov = EntityLayer.overlap;

    for (let py = y0; py <= y1; py++) {
      const v = (halfH - py) / focal;
      const rowBase = py * W;
      for (let px = x0; px <= x1; px++) {
        const pi = rowBase + px;
        const u = (px - halfW) / focal;
        const dx = this.fx + u * this.rx + v * this.ux;
        const dy = this.fy + v * this.uy;
        const dz = this.fz + u * this.rz + v * this.uz;
        const Du = dx * ux + dy * uy + dz * uz;
        const DD = dx * dx + dy * dy + dz * dz;
        const wD = wx * dx + wy * dy + wz * dz;
        const A2 = DD - k2 * Du * Du;
        const B2 = 2 * (wD - k2 * wu * Du);

        // Слой по оси: 0 ≤ a ≤ L, a(t) = wu + t·Du
        let ta0: number;
        let ta1: number;
        if (Math.abs(Du) < 1e-9) {
          if (wu < 0 || wu > L) continue;
          ta0 = -Infinity;
          ta1 = Infinity;
        } else {
          const t0 = -wu / Du;
          const t1 = (L - wu) / Du;
          ta0 = t0 < t1 ? t0 : t1;
          ta1 = t0 < t1 ? t1 : t0;
        }
        const lo = ta0 > Z_MIN ? ta0 : Z_MIN;
        const zb = zbuf[pi];
        const hiAll = ta1 < Z_FAR ? ta1 : Z_FAR;
        if (hiAll <= lo) continue;

        // Где квадрика A2·t² + B2·t + C0 ≤ 0: до двух интервалов
        let i1lo = 0;
        let i1hi = -1;
        let i2lo = 0;
        let i2hi = -1;
        if (Math.abs(A2) < 1e-9) {
          if (Math.abs(B2) < 1e-12) {
            if (C0 <= 0) {
              i1lo = -Infinity;
              i1hi = Infinity;
            }
          } else if (B2 > 0) {
            i1lo = -Infinity;
            i1hi = -C0 / B2;
          } else {
            i1lo = -C0 / B2;
            i1hi = Infinity;
          }
        } else {
          const disc = B2 * B2 - 4 * A2 * C0;
          if (disc < 0) {
            if (A2 < 0) {
              i1lo = -Infinity;
              i1hi = Infinity;
            }
          } else {
            const sq = Math.sqrt(disc);
            let r1 = (-B2 - sq) / (2 * A2);
            let r2 = (-B2 + sq) / (2 * A2);
            if (r1 > r2) {
              const tmp = r1;
              r1 = r2;
              r2 = tmp;
            }
            if (A2 > 0) {
              i1lo = r1;
              i1hi = r2;
            } else {
              i1lo = -Infinity;
              i1hi = r1;
              i2lo = r2;
              i2hi = Infinity;
            }
          }
        }

        // Хорда внутри конуса: перед землёй — полностью, за ней (только прошивающий) — вдвое слабее
        const zCut = zb < hiAll ? zb : hiAll;
        let chord = ov(i1lo, i1hi, lo, zCut) + ov(i2lo, i2hi, lo, zCut);
        if (b.pierce) chord += 0.5 * (ov(i1lo, i1hi, lo > zb ? lo : zb, hiAll) + ov(i2lo, i2hi, lo > zb ? lo : zb, hiAll));
        if (chord <= 0) continue;
        const chordW = chord * Math.sqrt(DD);

        // Ближе к вершине ярче: плотность падает к дальнему концу
        const tMid = i1lo > lo ? i1lo : lo;
        let aMid = (wu + (Number.isFinite(tMid) ? tMid : lo) * Du) / L;
        aMid = aMid < 0 ? 0 : aMid > 1 ? 1 : aMid;
        const w = gain * (0.14 + 0.5 * (1 - Math.exp(-chordW * 0.06))) * (1 - 0.6 * aMid);
        if (w < 0.02) continue;
        const i = pi * 4;
        const r = pix[i] / 255 + rgb[0] * w;
        const g = pix[i + 1] / 255 + rgb[1] * w;
        const bl = pix[i + 2] / 255 + rgb[2] * w;
        this.put(pi, px, py, r > 1 ? 1 : r, g > 1 ? 1 : g, bl > 1 ? 1 : bl);
      }
    }
  }

  /** Гаджет: парящий шар с тремя спутниками и столб света, видимый издалека */
  private drawGadget(g: DrawGadget, time: number): void {
    const bob = Math.sin(time * 2.2) * 0.12;
    if (g.coin) {
      // Монеты: невысокий столб и вращающийся шар — отличаются от гаджета размером
      for (let k = 0; k < 6; k++) this.disc(g.x, g.y + 0.4 + k * 0.7, g.z, 0.1, g.rgb, 0.3 * (1 - k / 7), 0.2);
      this.disc(g.x, g.y + 0.9 + bob, g.z, 0.24, g.rgb, 1, 0.2);
      const a = time * 4;
      this.disc(g.x + Math.cos(a) * 0.45, g.y + 0.9 + bob, g.z + Math.sin(a) * 0.45, 0.08, [1, 1, 0.6], 0.9, 0.2);
      return;
    }
    for (let k = 0; k < 14; k++) {
      this.disc(g.x, g.y + 0.5 + k * 0.9, g.z, 0.16, g.rgb, 0.34 * (1 - k / 16), 0.2);
    }
    this.disc(g.x, g.y + 1.3 + bob, g.z, 0.42, g.rgb, 1, 0.2);
    for (let i = 0; i < 3; i++) {
      const a = time * 2.6 + (i * Math.PI * 2) / 3;
      this.disc(g.x + Math.cos(a) * 0.8, g.y + 1.3 + bob + Math.sin(a * 1.7) * 0.2, g.z + Math.sin(a) * 0.8, 0.12, g.rgb, 0.9, 0.2);
    }
  }

  private drawSpark(s: DrawSpark): void {
    const rgb = PLAYER_COLORS[s.color % PLAYER_COLORS.length].rgb;
    this.disc(s.x, s.y, s.z, 0.05 + 0.04 * s.life, rgb, 0.4 + 0.8 * s.life, 0.1);
  }

  // ---------- Палочка от первого лица ----------

  /**
   * Палочка в правой руке, экранные координаты: рукав цвета игрока, древко,
   * светящийся шар на кончике. kick 0..1 — отдача выстрела (палочка откатывается,
   * шар вспыхивает), t — время, move 0..1 — покачивание на ходу.
   */
  drawWand(pix: Uint8ClampedArray, W: number, H: number, color: number, kick: number, t: number, move: number, charge = 0): void {
    this.pix = pix;
    const rgb = PLAYER_COLORS[color % PLAYER_COLORS.length].rgb;
    const bobX = Math.sin(t * 7.5) * 1.6 * move + Math.sin(t * 1.3) * 0.6;
    const bobY = Math.abs(Math.sin(t * 7.5)) * 2.2 * move + Math.sin(t * 1.7) * 0.5;
    const bx = W * 0.9;
    const by = H * 1.04;
    const tipX = W * 0.64 + bobX + kick * 3;
    const tipY = H * 0.72 + bobY + kick * 5;
    // Отдача: кончик откатывается к руке вдоль древка
    const dx = tipX - bx;
    const dy = tipY - by;
    const len = Math.hypot(dx, dy);
    const pull = kick * 7;
    const ex = tipX - (dx / len) * pull;
    const ey = tipY - (dy / len) * pull;

    const steps = Math.ceil(len);
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      const x = bx + (ex - bx) * s;
      const y = by + (ey - by) * s;
      const sleeve = s < 0.3;
      const rad = sleeve ? 9 - s * 14 : 3.4 - s * 1.8;
      // Рукав — цвет игрока потемнее; древко — светлое дерево (после палитры из 6 уровней не тонет в красный)
      const cr = sleeve ? rgb[0] * 0.6 : 0.62 - 0.12 * s;
      const cg = sleeve ? rgb[1] * 0.6 : 0.46 - 0.1 * s;
      const cb = sleeve ? rgb[2] * 0.6 : 0.26;
      this.fillDisc(W, H, x, y, rad, cr, cg, cb, 1);
    }
    // Шар на кончике: цвет игрока, белая сердцевина, вспышка при выстреле
    // Заряд луча: шар разбухает, пульсирует всё чаще и выгорает в белый
    const orb = 4.6 + kick * 3.4 + Math.sin(t * (6 + charge * 26)) * (0.4 + charge * 1.2) + charge * 7;
    if (charge > 0) {
      this.fillDisc(W, H, ex, ey, orb * (2.6 + charge), rgb[0], rgb[1], rgb[2], 0.15 + charge * 0.3);
    }
    this.fillDisc(W, H, ex, ey, orb * 1.9, rgb[0], rgb[1], rgb[2], 0.35 + kick * 0.3);
    this.fillDisc(W, H, ex, ey, orb, rgb[0] * 0.7 + 0.3, rgb[1] * 0.7 + 0.3, rgb[2] * 0.7 + 0.3, 1);
    this.fillDisc(W, H, ex, ey, orb * 0.5, 1, 1, 1, 1);
  }

  /** Диск в экранных пикселях; alpha < 1 — подмешать к уже нарисованному */
  private fillDisc(W: number, H: number, cx: number, cy: number, rad: number, r: number, g: number, b: number, alpha: number): void {
    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(W - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(H - 1, Math.ceil(cy + rad));
    const pix = this.pix;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > rad * rad) continue;
        const pi = y * W + x;
        const i = pi * 4;
        const rr = alpha >= 1 ? r : pix[i] / 255 + (r - pix[i] / 255) * alpha;
        const gg = alpha >= 1 ? g : pix[i + 1] / 255 + (g - pix[i + 1] / 255) * alpha;
        const bb = alpha >= 1 ? b : pix[i + 2] / 255 + (b - pix[i + 2] / 255) * alpha;
        this.put(pi, x, y, rr, gg, bb);
      }
    }
  }
}
