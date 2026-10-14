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
 */

import { FOG_COL, SUN_X, SUN_Y, SUN_Z } from "./columnMap";
import { BAYER, FOG_LUT, LEVELS, Z_FAR } from "./gfx";
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

const BIG_BEAM_VIS = 2.2; // во сколько раз «крупный» луч толще на экране
const BOLT_VIS_R = 0.14; // видимый радиус ядра заряда, юниты
const Z_MIN = 0.05;

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

    for (const p of players) {
      this.drawPlayer(p);
      if (p.charge > 0) this.drawChargeOrb(p, time);
    }
    for (const g of gadgets) this.drawGadget(g, time);
    for (const b of bolts) this.drawBolt(b);
    for (const bm of beams) this.drawBeam(bm);
    for (const s of sparks) this.drawSpark(s);
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

  private drawPlayer(p: DrawPlayer): void {
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
    let x0 = 0;
    let y0 = 0;
    let x1 = c.W - 1;
    let y1 = c.H - 1;
    const fdMin = Math.min(fdH - HEAD_R, fdB - BODY_R, fdT - BODY_R);
    if (fdMin > 0.3) {
      // Всё перед камерой: bbox по точкам оси и радиусу
      const pad = (2.0 * c.focal * BODY_R) / fdMin + 2;
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
    const sphC = mx * mx + my * my + mz * mz - HEAD_R * HEAD_R;
    // цилиндр
    const ex = ox - p.x;
    const ez = oz - p.z;
    const cylC = ex * ex + ez * ez - BODY_R * BODY_R;
    const nearest = Math.min(fdH - HEAD_R, fdB - BODY_R);
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
        if (zb < nearest - 0.02) continue; // всё ближе игрока уже закрыто миром
        const u = (px - halfW) / focal;
        const dx = this.fx + u * this.rx + v * this.ux;
        const dy = this.fy + v * this.uy;
        const dz = this.fz + u * this.rz + v * this.uz;

        let bestT = zb;
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
              nx = (mx + t * dx) / HEAD_R;
              ny = (my + t * dy) / HEAD_R;
              nz = (mz + t * dz) / HEAD_R;
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
                nx = (ex + t * dx) / BODY_R;
                ny = 0;
                nz = (ez + t * dz) / BODY_R;
                kind = 2;
              }
            }
          }
          if (oy > top && dy < 0) {
            const t = (top - oy) / dy;
            if (t > Z_MIN && t < bestT) {
              const hx = ex + t * dx;
              const hz = ez + t * dz;
              if (hx * hx + hz * hz <= BODY_R * BODY_R) {
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
        const f = FOG_LUT[fz > 511 ? 511 : fz | 0];
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

  /** Гаджет: парящий шар с тремя спутниками и столб света, видимый издалека */
  private drawGadget(g: DrawGadget, time: number): void {
    const bob = Math.sin(time * 2.2) * 0.12;
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
