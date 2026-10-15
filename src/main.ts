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
import { COLLIDE_R, Player, type MoveInput } from "./player";
import { Session } from "./session";
import { Hud } from "./hud";
import { clamp } from "./mathUtil";
import type { PoseMsg } from "./shared/game";

const MOUSE_SENS = 0.0023; // рад yaw на пиксель мыши
const PITCH_SENS = 0.0023;
const MOUSE_SPIKE = 800; // пикселей за одно событие: больше — сбой браузера, а не рука
const SENS_MIN = 0.3; // границы и шаг множителя чувствительности ([ и ])
const SENS_MAX = 3;
const SENS_STEP = 1.15;
const ZOOM_MAX = 1.1; // добавка к зуму при полном заряде луча (итого ×2.1)
const ZOOM_RATE = 10; // 1/с: плавность въезда и возврата
const DASH_TAP_MS = 300; // окно двойного нажатия Shift для рывка
const CHARGE_SLOW = 0.3; // на сколько замедляется поворот камеры при полном заряде (сверх компенсации зума)
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
  const groundAt = (x: number, z: number, y: number): number => columnMap.groundAt(x, z, y);

  const blocked = (x: number, z: number, y: number): boolean => columnMap.structures.blocks(x, z, y, COLLIDE_R);

  const player = new Player(session.spawn.x, columnMap.heightAt(session.spawn.x, session.spawn.z), session.spawn.z);
  let yaw = -2.0;
  let pitch = -0.05;
  let locked = false;
  let firing = false;
  let charging = false; // ПКМ удерживается: идёт заряд луча
  let zoom = 1; // текущее приближение камеры (сглаженное)

  const cancelCharge = (): void => {
    if (!charging) return;
    charging = false;
    session.sendCancel();
  };

  hud.onBuy = (id) => session.sendBuy(id);

  const keys = new Set<string>();
  // Чувствительность мыши: [ и ] меняют, значение помнится между запусками
  let sensMul = clamp(Number(localStorage.getItem("sens")) || 1, SENS_MIN, SENS_MAX);
  const changeSens = (k: number): void => {
    sensMul = clamp(sensMul * k, SENS_MIN, SENS_MAX);
    localStorage.setItem("sens", String(sensMul));
    hud.toast(`Чувствительность мыши: ${Math.round(sensMul * 100)}%`);
  };

  // Двойное нажатие Shift — рывок-уворот (обрабатывается в кадре физики)
  let lastShiftTap = 0;
  let dashQueued = false;

  // Игра забирает клавиатуру: сочетания с Ctrl/Alt/Meta и служебные клавиши браузера не срабатывают
  // (F5 и F12 оставлены — перезагрузка и инструменты разработчика)
  const BLOCKED_KEYS = new Set(["Tab", "F1", "F3", "F6", "F7", "ContextMenu"]);
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || BLOCKED_KEYS.has(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.code === "KeyE" && !e.repeat) hud.toggleShop();
    if (hud.isShopOpen && !e.repeat && /^Digit[1-9]$/.test(e.code)) hud.buyByIndex(Number(e.code.slice(5)) - 1);
    if (e.code === "BracketLeft") changeSens(1 / SENS_STEP);
    if (e.code === "BracketRight") changeSens(SENS_STEP);
    if ((e.code === "ShiftLeft" || e.code === "ShiftRight") && !e.repeat) {
      const t = performance.now();
      if (t - lastShiftTap < DASH_TAP_MS) {
        dashQueued = true;
        lastShiftTap = 0;
      } else {
        lastShiftTap = t;
      }
    }
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

  // Захват курсора с сырым вводом мыши (без ускорения ОС — одинаковая «рука» при любых настройках Windows);
  // если браузер такой режим не поддерживает или отказал — обычный захват
  const requestLock = (): void => {
    const plain = (): void => {
      const r: unknown = canvas.requestPointerLock();
      if (r instanceof Promise) r.catch(() => undefined);
    };
    const raw: unknown = canvas.requestPointerLock({ unadjustedMovement: true });
    if (raw instanceof Promise) raw.catch(plain);
  };
  canvas.addEventListener("click", () => {
    if (!locked) requestLock();
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
    if (!locked || session.frozen > 0) return; // остановка времени: камера не слушается
    // Chromium при захвате иногда отдаёт одно гигантское смещение — это не движение руки
    if (Math.abs(e.movementX) > MOUSE_SPIKE || Math.abs(e.movementY) > MOUSE_SPIKE) return;
    // При зуме поворот замедляется пропорционально (то же смещение на экране), плюс небольшое «утяжеление» по заряду
    const sens = (1 / zoom) * (1 - CHARGE_SLOW * Math.max(0, session.me.charge)) * sensMul;
    yaw += e.movementX * MOUSE_SENS * sens;
    pitch -= e.movementY * PITCH_SENS * sens;
    pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch));
    // yaw не копит бесконечный оборот (точность sin/cos и позы)
    if (yaw > Math.PI) yaw -= Math.PI * 2;
    else if (yaw < -Math.PI) yaw += Math.PI * 2;
  });
  window.addEventListener("mousedown", (e) => {
    if (locked && e.button === 0) firing = true; // клик, захвативший курсор, не стреляет
    if (locked && e.button === 2 && !charging && session.me.alive && session.frozen <= 0) {
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
  // Никакого выделения текста, перетаскивания, копирования и автоскролла средней кнопкой
  for (const type of ["selectstart", "dragstart", "copy", "cut", "paste"]) {
    document.addEventListener(type, (e) => e.preventDefault());
  }
  window.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });
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
      player.teleport(r.x, columnMap.heightAt(r.x, r.z), r.z);
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
    input.dash = dashQueued && alive;
    dashQueued = false;
    // Остановка времени: физика замирает целиком (в воздухе тоже), заряд луча срывается
    const frozen = alive && session.frozen > 0;
    if (frozen) cancelCharge();
    else player.update(dt, input, yaw, groundAt, WORLD_BOUND, blocked);

    // Сеть: поза ~30 раз в секунду; выстрел — по зажатой кнопке (мана и кулдаун решает сервер)
    poseT -= dt;
    if (alive && !frozen && poseT <= 0) {
      poseT = POSE_INTERVAL;
      session.sendPose(pose());
    }
    shootT -= dt;
    if (!alive) charging = false; // смерть срывает заряд (сервер тоже)
    if (alive && !frozen && firing && !charging && shootT <= 0) {
      shootT = SHOOT_INTERVAL;
      session.sendShoot(pose());
    }
    session.update(dt);

    // Камера: глаза + лёгкое покачивание от бега; погибший опускается к земле
    const speedH = player.speedH();
    if (player.onGround && !frozen) bobPhase += dt * speedH * 1.6;
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
    // Зум по заряду луча (заряд — с сервера, он учитывает потолок маны)
    const zoomTarget = alive ? 1 + ZOOM_MAX * Math.max(0, session.me.charge) : 1;
    zoom += (zoomTarget - zoom) * Math.min(1, dt * ZOOM_RATE);
    renderer.setZoom(zoom);
    renderer.begin(eye.x, eye.y, eye.z, yaw, pitch);
    renderer.drawEntities(session.alivePlayers(), session.boltList, session.sparkList, [...session.gadgetList(), ...session.coinList()], session.beamList, session.ghostList(), session.waveList());
    if (alive) renderer.drawWand(session.color, session.kick, time, Math.min(1, speedH / 6) * (player.onGround ? 1 : 0.2), Math.max(0, session.me.charge));
    renderer.end();
    hud.update(session, yaw);
    hud.drawDamageNumbers(session.damageNumbers, (x, y, z) => renderer.project(x, y, z));

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
