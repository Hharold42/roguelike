/**
 * PvP-арена 8×8 чанков: каждый подключившийся — отдельный игрок со своим
 * цветом (ротация красный → синий → жёлтый → их смеси). У всех 100 HP, волшебная
 * палочка и мана; заряды летят с настоящей скоростью (хитскана нет).
 *
 * Клиент: физика и камера от первого лица (player.ts), мир — софтверный
 * воксельный рендер (soft/), другие игроки — цветные сфера + цилиндр, заряды
 * и искры (soft/entities.ts). Бой, мана и урон считает сервер
 * (server/gameServer.ts), клиент шлёт ему позу и нажатия выстрела (session.ts).
 *
 * Управление: клик — захват мыши, WASD — движение, Space — прыжок,
 * C / Ctrl — присед, Shift — спринт, ЛКМ — выстрел, G — отладочная сетка
 * на земле, Esc — отпустить курсор.
 */

import "./style.css";
import { Terrain } from "./terrain";
import { ColumnMap, WORLD_SIZE } from "./soft/columnMap";
import { SoftRenderer } from "./soft/renderer";
import { Player, type MoveInput } from "./player";
import { Session } from "./session";
import { Hud } from "./hud";
import { clamp } from "./mathUtil";
import type { PoseMsg } from "./shared/game";

const MOUSE_SENS = 0.0023; // рад yaw на пиксель мыши
const PITCH_SENS = 0.0023;
const PITCH_MAX = 1.15; // рад (~66°) вверх/вниз — предел рендера
const POSE_INTERVAL = 1 / 30; // с между отправками позы серверу
const SHOOT_INTERVAL = 0.06; // с между повторами выстрела при зажатой кнопке (кулдаун — на сервере)
const DEAD_EYE = 0.35; // высота глаз над землёй у погибшего

async function boot(): Promise<void> {
  const hud = new Hud();
  const hintEl = document.getElementById("hint")!;
  const debugEl = document.getElementById("debug")!;
  hud.say("Подключение к серверу…");

  let session: Session;
  try {
    session = await Session.connect();
  } catch (err) {
    hud.say(`Нет связи с сервером (${(err as Error).message}). Обновите страницу.`);
    return;
  }
  hud.say(null);
  hud.setIdentity(session.color);
  session.onKill = (e) => hud.addKill(e);
  session.onToast = (text) => hud.toast(text);
  session.onHost = (host) => hud.setHost(host);
  hud.setHost(session.isHost);
  session.onClose = () => hud.say("Соединение потеряно. Обновите страницу.");

  // Мир по сиду сервера — у всех игроков один и тот же
  const terrain = new Terrain(session.seed);
  const columnMap = new ColumnMap(terrain);
  columnMap.bakeWorld(); // 64 тайла, один раз на старте

  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
  const renderer = new SoftRenderer(canvas, columnMap);

  const WORLD_BOUND = WORLD_SIZE / 2 - 2; // невидимая стена на краю мира
  // Опора — ровно та поверхность, что рисует рендер (запечённая билинейка)
  const groundAt = (x: number, z: number): number => columnMap.heightAt(x, z);

  const player = new Player(session.spawn.x, groundAt(session.spawn.x, session.spawn.z), session.spawn.z);
  let yaw = -2.0;
  let pitch = -0.05;
  let locked = false;
  let firing = false;
  let charging = false; // ПКМ удерживается: идёт заряд луча

  const cancelCharge = (): void => {
    if (!charging) return;
    charging = false;
    session.sendCancel();
  };

  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "KeyG" && !e.repeat) renderer.debugGrid = !renderer.debugGrid; // отладочная сетка
    // Боты: только хозяин (сервер проверяет права и сам отвечает отказом)
    if (e.code === "KeyB" && !e.repeat) session.sendBot("add");
    if (e.code === "KeyN" && !e.repeat) session.sendBot("remove");
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => {
    keys.clear();
    firing = false;
    cancelCharge();
  });

  canvas.addEventListener("click", () => {
    if (!locked) canvas.requestPointerLock();
  });
  document.addEventListener("pointerlockchange", () => {
    locked = document.pointerLockElement === canvas;
    hintEl.style.display = locked ? "none" : "block";
    if (!locked) {
      firing = false;
      cancelCharge();
    }
  });
  window.addEventListener("mousemove", (e) => {
    if (!locked) return;
    yaw += e.movementX * MOUSE_SENS;
    pitch -= e.movementY * PITCH_SENS;
    pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch));
  });
  window.addEventListener("mousedown", (e) => {
    if (locked && e.button === 0) firing = true; // клик, захвативший курсор, не стреляет
    if (locked && e.button === 2 && !charging && session.me.alive) {
      charging = true; // ПКМ: заряд луча, время считает сервер
      session.sendCharge(pose());
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) firing = false;
    if (e.button === 2 && charging) {
      charging = false;
      session.sendRelease(pose());
    }
  });
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", () => renderer.resize());

  const pose = (): PoseMsg => ({ x: player.x, y: player.y, z: player.z, yaw, pitch, crouch: player.crouch });

  let last = performance.now();
  let fps = 0;
  let debugT = 0;
  let time = 0;
  let bobPhase = 0;
  let prevSpace = false;
  let poseT = 0;
  let shootT = 0;
  let deadSink = 0; // 0 — живой, 1 — камера опустилась к земле
  const eye = { x: 0, y: 0, z: 0 };

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;

    // Сервер поставил нас на новое место (возрождение)
    if (session.respawnAt) {
      const r = session.respawnAt;
      session.respawnAt = null;
      player.teleport(r.x, groundAt(r.x, r.z), r.z);
      poseT = 0;
    }
    const alive = session.me.alive;

    // Ввод → физика (мёртвый только падает/стоит)
    const space = keys.has("Space") && alive;
    const input: MoveInput = alive
      ? {
          fwd: (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0),
          side: (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
          jump: space && !prevSpace,
          jumpHeld: space,
          crouch: keys.has("KeyC") || keys.has("ControlLeft") || keys.has("ControlRight"),
          sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
        }
      : { fwd: 0, side: 0, jump: false, jumpHeld: false, crouch: false, sprint: false };
    prevSpace = space;
    player.speedMul = session.me.moveMul;
    player.update(dt, input, yaw, groundAt, WORLD_BOUND);

    // Сеть: поза ~30 раз в секунду; выстрел — по зажатой кнопке (мана и кулдаун решает сервер)
    poseT -= dt;
    if (alive && poseT <= 0) {
      poseT = POSE_INTERVAL;
      session.sendPose(pose());
    }
    shootT -= dt;
    if (!alive) charging = false; // смерть срывает заряд (сервер тоже)
    if (alive && firing && !charging && shootT <= 0) {
      shootT = SHOOT_INTERVAL;
      session.sendShoot(pose());
    }
    session.update(dt);

    // Камера: глаза + лёгкое покачивание от бега; погибший опускается к земле
    const speedH = player.speedH();
    if (player.onGround) bobPhase += dt * speedH * 1.6;
    const bob = Math.abs(Math.sin(bobPhase)) * 0.045 * Math.min(1, speedH / 6);
    deadSink = clamp(deadSink + (alive ? -dt * 6 : dt * 3), 0, 1);
    const eyeAlive = player.eyeY() + bob;
    eye.x = player.x;
    eye.y = eyeAlive + (player.y + DEAD_EYE - eyeAlive) * deadSink;
    eye.z = player.z;

    // Мир и трава (трава приминается под игроками), затем игроки, заряды, палочка
    renderer.time = time;
    renderer.trample(player.x, player.z, 1.2);
    for (const r of session.players.values()) if (r.alive) renderer.trample(r.x, r.z, 1.2);
    renderer.begin(eye.x, eye.y, eye.z, yaw, pitch);
    renderer.drawEntities(session.alivePlayers(), session.boltList, session.sparkList, session.gadgetList(), session.beamList);
    if (alive) renderer.drawWand(session.color, session.kick, time, Math.min(1, speedH / 6) * (player.onGround ? 1 : 0.2), Math.max(0, session.me.charge));
    renderer.end();
    hud.update(session, yaw);

    // Отладочная плашка: сид, координаты, fps
    debugT -= dt;
    if (debugT <= 0) {
      debugT = 0.25;
      debugEl.textContent = `seed ${session.seed} · x ${player.x.toFixed(1)} y ${player.y.toFixed(1)} z ${player.z.toFixed(1)} · ${fps.toFixed(0)} fps\nигроков ${session.players.size + 1} · мир ${WORLD_SIZE}×${WORLD_SIZE} ю`;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void boot();
