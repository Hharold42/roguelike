/**
 * Рейкаст-прототип (страница /raytrace): софтверный voxel-space рендер мира игры.
 *
 * Что это: та же карта (Terrain, сид фиксирован), но вместо растеризации Babylon
 * мир запекается в карту колонн (высота + тип + освещение на ячейку 2×2 юнита),
 * а кадр строится поэкранно-столбцовым проходом: каждый пиксель пишется ровно
 * один раз (нет overdraw), враги — билборд-спрайты с попиксельным клиппингом
 * по глубине столбца, как в Doom. Сверху — палитра с дизерингом Байера.
 *
 * Babylon здесь не используется вообще — замер честный: чистый CPU, один поток.
 *
 * Ограничения прототипа (для продакшена решаемо, но не нужно для замера FPS):
 *  - наклон камеры (pitch) — сдвиг горизонта, а не настоящий поворот луча;
 *  - спрайты клиппятся по одной глубине на столбец — у гребней холмов возможны артефакты;
 *  - запечённая область конечна (±512 юнитов от спавна), дальше — туман.
 */

import { Terrain, TILE } from "./terrain";

// ---------- Настройки ----------

const SEED = 42; // фиксированный мир, чтобы замеры были повторяемы
const CELLS = 512; // запечённая область: 512×512 ячеек по 2 юнита = 1024×1024 вокруг спавна
const CELL = TILE;
const HALF = (CELLS * CELL) / 2;

const Z_NEAR = 0.5;
const Z_FAR = 170; // дальше — сплошной туман
const FOG_K = 0.016; // как в игре
const LEVELS = 6; // градаций на канал (палитра 6³ = 216 цветов)
const HFOV = (74 * Math.PI) / 180;

const EYE = 1.7; // высота камеры над опорой
const WALK_SPEED = 12;
const RUN_MULT = 2.5;
const MOUSE_SENS = 0.0023;
const PITCH_SENS = 0.6; // сдвиг горизонта, px на px мыши

const SPRITE_COUNT = 80; // тестовые «враги»-билборды

// Направление К солнцу — против lightDir игры (0.7, -0.55, 0.3)
const SUN_LEN = Math.hypot(0.7, 0.55, 0.3);
const SUN_X = -0.7 / SUN_LEN;
const SUN_Y = 0.55 / SUN_LEN;
const SUN_Z = -0.3 / SUN_LEN;

const FOG_COL = [0.66, 0.58, 0.62];
const SKY_TOP = [0.3, 0.27, 0.45];
const WALL_COL = [0.49, 0.47, 0.55];
/** Палитра земли — копия полос из terrainMesh.ts */
const PALETTE: { upTo: number; c: number[] }[] = [
  { upTo: -1.6, c: [0.12, 0.27, 0.17] },
  { upTo: 0.3, c: [0.2, 0.42, 0.19] },
  { upTo: 1.6, c: [0.36, 0.44, 0.19] },
  { upTo: 2.8, c: [0.47, 0.37, 0.25] },
  { upTo: Infinity, c: [0.56, 0.54, 0.56] },
];

// Матрица Байера 4×4, значения (0..1)
const BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));

// ---------- Запекание мира в карту колонн ----------

const terrain = new Terrain(SEED);
/** Высота колонны (рельеф или верх стены), тип (0 — земля, 1 — стена), запечённый свет */
const colH = new Float32Array(CELLS * CELLS);
const colKind = new Uint8Array(CELLS * CELLS);
const colLight = new Float32Array(CELLS * CELLS);

function bake(): void {
  const groundH = new Float32Array(CELLS * CELLS);
  for (let gz = 0; gz < CELLS; gz++) {
    for (let gx = 0; gx < CELLS; gx++) {
      const i = gz * CELLS + gx;
      const wx = (gx + 0.5) * CELL - HALF;
      const wz = (gz + 0.5) * CELL - HALF;
      const h = terrain.getHeight(wx, wz);
      groundH[i] = h;
      const wallTop = terrain.wallTopAt(wx, wz);
      if (wallTop !== null) {
        colH[i] = wallTop;
        colKind[i] = 1;
      } else {
        colH[i] = h;
      }
    }
  }
  // Свет запекаем по нормалям РЕЛЬЕФА (без стен): центральная разность высот
  for (let gz = 1; gz < CELLS - 1; gz++) {
    for (let gx = 1; gx < CELLS - 1; gx++) {
      const i = gz * CELLS + gx;
      const dhdx = (groundH[i + 1] - groundH[i - 1]) / (2 * CELL);
      const dhdz = (groundH[i + CELLS] - groundH[i - CELLS]) / (2 * CELL);
      const inv = 1 / Math.hypot(dhdx, 1, dhdz);
      const dot = Math.max(0, (-dhdx * SUN_X + 1 * SUN_Y + -dhdz * SUN_Z) * inv);
      colLight[i] = 0.35 + 0.65 * dot;
    }
  }
}

/** Высота колонны в мировой точке (для камеры и спрайтов); за картой — «бездна» */
function worldH(wx: number, wz: number): number {
  const gx = ((wx + HALF) / CELL) | 0;
  const gz = ((wz + HALF) / CELL) | 0;
  if (gx < 0 || gz < 0 || gx >= CELLS || gz >= CELLS) return -100;
  return colH[gz * CELLS + gx];
}

// ---------- Спрайты (стенды для врагов) ----------

interface Sprite {
  x: number;
  z: number;
  ground: number;
  size: number;
  c: number[];
  /** Кэш проекции на кадр: дистанция вперёд / вбок по взгляду */
  _fd: number;
  _ld: number;
}
const sprites: Sprite[] = [];
const spriteOrder: Sprite[] = [];

function bakeSprites(): void {
  for (let i = 0; i < SPRITE_COUNT; i++) {
    const p = terrain.randomOpenPoint({ x: 0, z: 0 }, 15, 380);
    const elite = i % 9 === 0;
    sprites.push({
      x: p.x,
      z: p.z,
      ground: worldH(p.x, p.z),
      size: elite ? 2.6 : 1.6,
      c: elite ? [0.55, 0.15, 0.7] : [0.8, 0.16, 0.12],
      _fd: 0,
      _ld: 0,
    });
  }
}

// ---------- Экран ----------

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statsEl = document.getElementById("stats")!;

let W = 320;
let H = 200;
let focal = 0;
let img: ImageData;
let pix: Uint8ClampedArray;
let ybuf!: Int16Array; // нижняя свободная строка столбца (выше неё всё нарисовано)
let occZ!: Float32Array; // глубина ближайшего столбца-окклюдера (для спрайтов)
let sunAdd!: Float32Array; // горизонтальное свечение солнца по столбцу (r=g=b)

function setResolution(w: number, h: number): void {
  W = w;
  H = h;
  canvas.width = W;
  canvas.height = H;
  img = ctx.createImageData(W, H);
  pix = img.data;
  ybuf = new Int16Array(W);
  occZ = new Float32Array(W);
  sunAdd = new Float32Array(W);
  focal = W / 2 / Math.tan(HFOV / 2);
  horizon = H * 0.5;
}

// ---------- Камера и ввод ----------

let camX = 0;
let camZ = 0;
let camY = 0;
let yaw = 0;
let horizon = 0; // строка горизонта (сдвигом имитируем pitch)

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "Digit1") setResolution(320, 200);
  if (e.code === "Digit2") setResolution(480, 270);
  if (e.code === "Digit3") setResolution(640, 360);
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
canvas.addEventListener("pointerdown", () => canvas.requestPointerLock());
window.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  yaw += e.movementX * MOUSE_SENS;
  // мышь вверх (movementY < 0) — смотрим вверх: горизонт едет вниз по экрану
  horizon -= e.movementY * PITCH_SENS;
  horizon = Math.max(H * 0.2, Math.min(H * 0.8, horizon));
});

// ---------- Рендер кадра ----------

function render(): void {
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);

  // --- Небо: вертикальный градиент + горизонтальное гало солнца ---
  for (let x = 0; x < W; x++) {
    const u = (x - W / 2) / focal;
    const dx = sinY + u * cosY;
    const dz = cosY - u * sinY;
    const inv = 1 / Math.hypot(dx, dz);
    const dot = Math.max(0, (dx * SUN_X + dz * SUN_Z) * inv);
    sunAdd[x] = Math.pow(dot, 24) * 0.9; // узкое гало
  }
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const fall = 1 - t; // гало сильнее у горизонта
    const r0 = SKY_TOP[0] + (FOG_COL[0] - SKY_TOP[0]) * t;
    const g0 = SKY_TOP[1] + (FOG_COL[1] - SKY_TOP[1]) * t;
    const b0 = SKY_TOP[2] + (FOG_COL[2] - SKY_TOP[2]) * t;
    let i = y * W * 4;
    const brow = (y & 3) << 2;
    for (let x = 0; x < W; x++) {
      const s = sunAdd[x] * fall;
      const d = BAYER[brow | (x & 3)];
      pix[i] = 255 * Math.min(1, Math.floor((r0 + s) * LEVELS + d) / LEVELS);
      pix[i + 1] = 255 * Math.min(1, Math.floor((g0 + s * 0.85) * LEVELS + d) / LEVELS);
      pix[i + 2] = 255 * Math.min(1, Math.floor((b0 + s * 0.6) * LEVELS + d) / LEVELS);
      pix[i + 3] = 255;
      i += 4;
    }
  }

  // --- Мир: столбец за столбцом, луч идёт от камеры, спаны снизу вверх ---
  for (let x = 0; x < W; x++) {
    const u = (x - W / 2) / focal;
    const dirX = sinY + u * cosY;
    const dirZ = cosY - u * sinY;
    let yb = H; // нижняя свободная строка
    let occ = Z_FAR;
    let t = Z_NEAR;
    const brow = x & 3;
    while (t < Z_FAR && yb > 0) {
      const wx = camX + dirX * t;
      const wz = camZ + dirZ * t;
      const gx = ((wx + HALF) / CELL) | 0;
      const gz = ((wz + HALF) / CELL) | 0;
      if (gx >= 0 && gz >= 0 && gx < CELLS && gz < CELLS) {
        const ci = gz * CELLS + gx;
        const h = colH[ci];
        const sy = horizon - ((h - camY) * focal) / t;
        if (sy < yb) {
          const y0 = sy < 0 ? 0 : Math.ceil(sy);
          // Цвет спана: палитра/бетон × запечённый свет, затем туман по дистанции
          let r: number, g: number, b: number;
          if (colKind[ci] === 1) {
            const s = (0.55 + 0.45 * colLight[ci]) * 0.9;
            r = WALL_COL[0] * s;
            g = WALL_COL[1] * s;
            b = WALL_COL[2] * s;
          } else {
            let c = PALETTE[PALETTE.length - 1].c;
            for (const band of PALETTE) if (h <= band.upTo) { c = band.c; break; }
            const s = 0.45 + 0.55 * colLight[ci];
            r = c[0] * s;
            g = c[1] * s;
            b = c[2] * s;
          }
          const fz = (t / Z_FAR) * 511;
          const f = FOG_LUT[fz > 511 ? 511 : fz | 0];
          r += (FOG_COL[0] - r) * f;
          g += (FOG_COL[1] - g) * f;
          b += (FOG_COL[2] - b) * f;
          const rL = r * LEVELS;
          const gL = g * LEVELS;
          const bL = b * LEVELS;
          for (let y = y0; y < yb; y++) {
            const d = BAYER[((y & 3) << 2) | brow];
            const i = (y * W + x) * 4;
            pix[i] = 255 * Math.min(1, Math.floor(rL + d) / LEVELS);
            pix[i + 1] = 255 * Math.min(1, Math.floor(gL + d) / LEVELS);
            pix[i + 2] = 255 * Math.min(1, Math.floor(bL + d) / LEVELS);
            pix[i + 3] = 255;
          }
          yb = y0;
          if (y0 === 0) {
            occ = t; // столбец закрыт доверху — дальше идти некуда
            break;
          }
        }
      }
      t += 0.12 + t * 0.02; // шаг растёт с дистанцией: вблизи плотно, вдали редко
    }
    occZ[x] = occ;
  }

  // --- Спрайты: дальние первыми, клиппинг по глубине столбца ---
  spriteOrder.length = 0;
  for (const s of sprites) {
    const dx = s.x - camX;
    const dz = s.z - camZ;
    s._fd = dx * sinY + dz * cosY; // дистанция вперёд по взгляду
    s._ld = dx * cosY - dz * sinY; // вбок
    if (s._fd > 0.5 && s._fd < Z_FAR) spriteOrder.push(s);
  }
  spriteOrder.sort((a, b) => b._fd - a._fd);
  for (const s of spriteOrder) {
    const fd = s._fd;
    const cx = W / 2 + (s._ld * focal) / fd;
    const groundSy = horizon - ((s.ground - camY) * focal) / fd;
    const sh = (s.size * focal) / fd;
    const top = groundSy - sh;
    const halfW = sh * 0.28;
    const x0 = Math.max(0, Math.ceil(cx - halfW));
    const x1 = Math.min(W - 1, Math.floor(cx + halfW));
    const fz = (fd / Z_FAR) * 511;
    const f = FOG_LUT[fz > 511 ? 511 : fz | 0];
    const yA = Math.max(0, Math.ceil(top));
    const yB = Math.min(H, Math.ceil(groundSy));
    for (let x = x0; x <= x1; x++) {
      if (fd >= occZ[x]) continue; // столбец закрыт ближней стеной/холмом
      // Дешёвый «объём»: затемнение к краям билборда
      const edge = 1 - Math.abs(x - cx) / (halfW + 0.001);
      const s0 = 0.55 + 0.45 * edge;
      const r = s.c[0] * s0 + (FOG_COL[0] - s.c[0] * s0) * f;
      const g = s.c[1] * s0 + (FOG_COL[1] - s.c[1] * s0) * f;
      const b = s.c[2] * s0 + (FOG_COL[2] - s.c[2] * s0) * f;
      const rL = r * LEVELS;
      const gL = g * LEVELS;
      const bL = b * LEVELS;
      const brow = x & 3;
      for (let y = yA; y < yB; y++) {
        const d = BAYER[((y & 3) << 2) | brow];
        const i = (y * W + x) * 4;
        pix[i] = 255 * Math.min(1, Math.floor(rL + d) / LEVELS);
        pix[i + 1] = 255 * Math.min(1, Math.floor(gL + d) / LEVELS);
        pix[i + 2] = 255 * Math.min(1, Math.floor(bL + d) / LEVELS);
        pix[i + 3] = 255;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}

// Туман — таблица (exp2), чтобы не звать exp в горячем цикле
const FOG_LUT = new Float32Array(512);
for (let i = 0; i < 512; i++) {
  const z = (i / 511) * Z_FAR * FOG_K;
  FOG_LUT[i] = 1 - Math.exp(-z * z);
}

// ---------- Цикл ----------

let last = performance.now();
let fps = 0;
let renderMs = 0;
let statTimer = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Движение относительно взгляда
  const run = keys.has("ShiftLeft") || keys.has("ShiftRight") ? RUN_MULT : 1;
  const sp = WALK_SPEED * run * dt;
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  let mx = 0;
  let mz = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) mz += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) mz -= 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
  if (mx !== 0 || mz !== 0) {
    camX += (sinY * mz + cosY * mx) * sp;
    camZ += (cosY * mz - sinY * mx) * sp;
    camX = Math.max(-HALF + 8, Math.min(HALF - 8, camX));
    camZ = Math.max(-HALF + 8, Math.min(HALF - 8, camZ));
  }
  // Камера плавно садится на рельеф
  const targetY = worldH(camX, camZ) + EYE;
  camY += (targetY - camY) * Math.min(1, 12 * dt);

  const t0 = performance.now();
  render();
  renderMs = renderMs * 0.9 + (performance.now() - t0) * 0.1;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

  statTimer -= dt;
  if (statTimer <= 0) {
    statTimer = 0.25;
    statsEl.innerHTML =
      `FPS: <b>${fps.toFixed(0)}</b> · рендер: <b>${renderMs.toFixed(1)} мс</b>\n` +
      `Разрешение: <b>${W}×${H}</b> (${((W * H) / 1000).toFixed(0)}k пикселей) · 1/2/3 — переключить\n` +
      `Спрайтов: ${sprites.length} · CPU, один поток, без GPU\n` +
      `Позиция: ${camX.toFixed(0)}, ${camZ.toFixed(0)}`;
  }
  requestAnimationFrame(frame);
}

// ---------- Старт ----------

bake();
bakeSprites();
setResolution(320, 200);
horizon = H * 0.5;
camY = worldH(camX, camZ) + EYE;
requestAnimationFrame(frame);
