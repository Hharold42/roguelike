/**
 * Песочница генерации мира (роут /gen): тот же софтверный рендер и движение
 * от первого лица, что в игре, но без врагов, оружия, целей и HUD — чистый
 * стенд для проверки генерации террейна.
 *
 * По умолчанию всё «тяжёлое» выключено: плоский мир без валунов и сооружений.
 * Параметры URL:
 *   ?seed=123        — сид мира (иначе случайный; печатается в углу)
 *   ?hills=1         — включить рельеф (холмы/возвышенности)
 *   ?walls=1         — включить hex-валуны
 *   ?structures=1    — включить мегаструктуры (зиккураты, монолиты)
 * Пример: /gen?seed=42&hills=1
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "./gen.css";
import { Terrain } from "./terrain";
import { ColumnMap } from "./soft/columnMap";
import { SoftRenderer } from "./soft/renderer";
import { Player, PLAYER_RADIUS } from "./player";
import { Input } from "./input";

const MOUSE_SENS = 0.0023; // рад yaw на пиксель мыши
const PITCH_SENS = 0.0023; // рад pitch на пиксель мыши
const PITCH_MAX = 1.15; // рад (~66°) вверх/вниз — как в игре
const BOOST_MULT = 2.5; // Shift — ускорение для облёта

const params = new URLSearchParams(location.search);
const flag = (name: string): boolean => params.get(name) === "1";
const seed = params.has("seed") ? Number(params.get("seed")) : Math.floor(Math.random() * 1e9);

const terrain = new Terrain(seed, {
  hills: flag("hills"),
  walls: flag("walls"),
  structures: flag("structures"),
});
const columnMap = new ColumnMap(terrain);
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const renderer = new SoftRenderer(canvas, columnMap);
const input = new Input();
const debugEl = document.getElementById("debug")!;
const lockHint = document.getElementById("lockHint")!;

// Игрок на спавне (ступни на рельефе)
const player = new Player(new Vector3(terrain.spawn.x, terrain.floorAt(terrain.spawn.x, terrain.spawn.z) + 1, terrain.spawn.z));

let camYaw = 0;
let pitch = 0;
let locked = false;

canvas.addEventListener("click", () => {
  if (!locked) canvas.requestPointerLock();
});
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  lockHint.style.display = locked ? "none" : "block";
});
window.addEventListener("mousemove", (e) => {
  if (!locked) return;
  camYaw += e.movementX * MOUSE_SENS;
  pitch -= e.movementY * PITCH_SENS;
  pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch));
});
window.addEventListener("resize", () => renderer.resize());

// Старт: запечь всё окно сразу, чтобы не было дыр на горизонте
columnMap.bakeAllAround(player.position.x, player.position.z);

let last = performance.now();
let fps = 0;
let debugT = 0;
let time = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;

  // Движение относительно камеры (как в game.ts)
  const axis = input.moveAxis();
  const moving = axis.x !== 0 || axis.z !== 0;
  const sy = Math.sin(camYaw);
  const cy = Math.cos(camYaw);
  const moveDir = moving ? new Vector3(sy * axis.z + cy * axis.x, 0, cy * axis.z - sy * axis.x) : null;
  player.yaw = camYaw;
  player.speedMult = input.isDown("ShiftLeft") || input.isDown("ShiftRight") ? BOOST_MULT : 1;

  const isBlocked = (x: number, z: number, feetY: number) => columnMap.circleHitsWall(x, z, PLAYER_RADIUS, feetY);
  const floorAt = (x: number, z: number) => columnMap.wallTopAt(x, z) ?? terrain.getHeight(x, z);
  player.update(dt, moveDir, null, floorAt, isBlocked, {
    jump: input.takePress("Space"),
    jumpHeld: input.isDown("Space"),
    crouch: input.isDown("ControlLeft") || input.isDown("ControlRight") || input.isDown("KeyC"),
  });

  columnMap.ensureAround(player.position.x, player.position.z);

  const p = player.position;
  // Трава: часы ветра и след приминания игрока — до begin (мир рисуется внутри)
  renderer.time = time;
  renderer.trample(p.x, p.z, 1.2);
  renderer.begin(p.x, player.eyeY(), p.z, camYaw, pitch);
  renderer.end(dt);

  // Отладочная плашка: сид, координаты, слои, fps
  debugT -= dt;
  if (debugT <= 0) {
    debugT = 0.25;
    const layers = [
      `hills ${terrain.opts.hills ? "on" : "off"}`,
      `walls ${terrain.opts.walls ? "on" : "off"}`,
      `structures ${terrain.opts.structures ? "on" : "off"}`,
    ].join(" · ");
    debugEl.textContent = `seed ${seed} · x ${p.x.toFixed(1)} z ${p.z.toFixed(1)} · ${fps.toFixed(0)} fps\n${layers}`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
