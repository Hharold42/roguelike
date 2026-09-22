/**
 * Страница просмотра персонажа (/viewer): та же модель и тот же загрузчик, что в игре,
 * но с орбитальной камерой, включаемой ходьбой, показом скелета и загрузкой любого GLB.
 */
import "@babylonjs/loaders/glTF";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { SkeletonViewer } from "@babylonjs/core/Debug/skeletonViewer";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Materials/standardMaterial";
import {
  buildProceduralCharacter,
  createPlayerModel,
  loadGlbCharacter,
  PLAYER_MODEL_URL,
  type CharacterModel,
} from "./characterModel";
import type { MotionState } from "./motion";

const WALK_SPEED = 9; // как baseSpeed игрока

// ---------- Сцена ----------

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { antialias: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.06, 0.06, 0.09, 1);

// alpha = +PI/2 — камера со стороны +Z, т. е. спереди персонажа
const camera = new ArcRotateCamera("cam", Math.PI / 2, 1.15, 6, new Vector3(0, 1, 0), scene);
camera.lowerRadiusLimit = 1.5;
camera.upperRadiusLimit = 20;
camera.wheelDeltaPercentage = 0.02;
camera.minZ = 0.05;
camera.attachControl(canvas, true);

const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
hemi.intensity = 0.5;
hemi.groundColor = new Color3(0.1, 0.08, 0.15);
const dir = new DirectionalLight("dir", new Vector3(-0.5, -1, 0.6), scene);
dir.position = new Vector3(4, 8, -5);
dir.intensity = 0.9;
dir.autoCalcShadowZBounds = true;
const shadows = new ShadowGenerator(2048, dir);
shadows.useBlurExponentialShadowMap = true;

// Пол и сетка
const ground = CreateGround("ground", { width: 14, height: 14 }, scene);
const groundMat = new StandardMaterial("groundMat", scene);
groundMat.diffuseColor = new Color3(0.2, 0.42, 0.22);
groundMat.specularColor = Color3.Black();
ground.material = groundMat;
ground.receiveShadows = true;
const gridPts: Vector3[][] = [];
for (let i = -7; i <= 7; i++) {
  gridPts.push([new Vector3(i, 0.005, -7), new Vector3(i, 0.005, 7)]);
  gridPts.push([new Vector3(-7, 0.005, i), new Vector3(7, 0.005, i)]);
}
for (const [a, b] of gridPts) {
  const l = CreateLines("grid", { points: [a, b] }, scene);
  l.color = new Color3(0.14, 0.3, 0.16);
  l.isPickable = false;
}
// Стрелка «вперёд» (+Z): куда персонаж должен смотреть
const arrow = CreateLines(
  "forward",
  { points: [new Vector3(0, 0.02, 0.6), new Vector3(0, 0.02, 1.6), new Vector3(-0.15, 0.02, 1.4), new Vector3(0, 0.02, 1.6), new Vector3(0.15, 0.02, 1.4)] },
  scene,
);
arrow.color = new Color3(1, 0.82, 0.4);

// ---------- Модель ----------

// turn — вращение подставки (кнопка «Вращать»); модель — его ребёнок
const turn = new TransformNode("turn", scene);
let model: CharacterModel | null = null;
let baseYaw = 0; // разворот, с которым модель пришла из загрузчика
let skeletonViewer: SkeletonViewer | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const walkBox = $<HTMLInputElement>("walk");
const turnBox = $<HTMLInputElement>("turntable");
const skelBox = $<HTMLInputElement>("skeleton");
const wireBox = $<HTMLInputElement>("wireframe");
const yawRange = $<HTMLInputElement>("yaw");
const yawVal = $<HTMLSpanElement>("yawVal");
const infoEl = $<HTMLDivElement>("info");
const statusEl = $<HTMLDivElement>("status");
const dropEl = $<HTMLDivElement>("drop");

function setStatus(text: string, cls = ""): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function deg(rad: number): string {
  return `${Math.round((rad * 180) / Math.PI)}°`;
}

function renderInfo(): void {
  if (!model) return;
  const i = model.info;
  const rows: [string, string][] = [
    ["Источник", i.source],
    ["Треугольников", i.triangles.toLocaleString("ru")],
    ["Мешей", String(i.meshCount)],
    ["Костей", String(i.bones)],
    ["Анимации", i.animations.length ? i.animations.join(", ") : "нет"],
  ];
  if (i.rig) {
    const ok = i.rig.thighs > 0 && i.rig.arms > 0;
    rows.push([
      "Риг",
      `<span class="${ok ? "ok" : "warn"}">бёдра ${i.rig.thighs}, колени ${i.rig.knees}, руки ${i.rig.arms}, позвоночник ${i.rig.spine}${i.rig.head ? ", голова" : ""}</span>`,
    ]);
  } else if (i.bones > 0) {
    rows.push(["Риг", '<span class="warn">не распознан</span>']);
  }
  rows.push(["Разворот", `${deg(i.yaw)} (${i.yawSource === "auto" ? "по стопам" : "параметр yaw"})`]);
  infoEl.innerHTML = rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join("");
}

function applyWireframe(): void {
  if (!model) return;
  for (const m of model.meshes) if (m.material) m.material.wireframe = wireBox.checked;
}

function applySkeletonViewer(): void {
  skeletonViewer?.dispose();
  skeletonViewer = null;
  if (!model?.skeleton || !skelBox.checked) return;
  const host = model.meshes.find((m) => m.skeleton === model!.skeleton) ?? null;
  skeletonViewer = new SkeletonViewer(model.skeleton, host, scene, true, 3, {
    displayMode: SkeletonViewer.DISPLAY_LINES,
  });
  skeletonViewer.isEnabled = true;
}

function applyYaw(): void {
  if (!model) return;
  const offset = (Number(yawRange.value) * Math.PI) / 180;
  model.root.rotation.y = baseYaw + offset;
  yawVal.textContent = `${yawRange.value}°`;
}

function setModel(next: CharacterModel): void {
  if (model) {
    for (const m of model.meshes) shadows.removeShadowCaster(m);
    model.dispose();
  }
  model = next;
  model.root.parent = turn;
  model.root.position.set(0, 0, 0);
  baseYaw = model.root.rotation.y;
  for (const m of model.meshes) shadows.addShadowCaster(m);
  yawRange.value = "0";
  applyYaw();
  applyWireframe();
  applySkeletonViewer();
  renderInfo();
}

async function openFile(file: File): Promise<void> {
  setStatus(`Загрузка ${file.name}…`);
  try {
    const glb = await loadGlbCharacter(scene, file);
    if (!glb) {
      setStatus(`${file.name}: модель отклонена (слишком тяжёлая — см. консоль)`, "warn");
      return;
    }
    setModel(glb);
    setStatus(`Загружено: ${file.name}`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(`Не удалось загрузить ${file.name}: ${(err as Error).message ?? err}`, "warn");
  }
}

function loadDefault(): void {
  setStatus(`Загрузка ${PLAYER_MODEL_URL}…`);
  setModel(
    createPlayerModel(
      scene,
      PLAYER_MODEL_URL,
      (glb) => {
        setModel(glb);
        setStatus(`Загружено: ${PLAYER_MODEL_URL}`, "ok");
      },
      (err) => setStatus(`Ошибка загрузки ${PLAYER_MODEL_URL}: ${(err as Error).message ?? err}`, "warn"),
    ),
  );
  // Если GLB нет, статус остаётся «загрузка» — уточним по HEAD
  fetch(PLAYER_MODEL_URL, { method: "HEAD" })
    .then((r) => {
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) {
        setStatus(`${PLAYER_MODEL_URL} не найден — показан процедурный персонаж`);
      }
    })
    .catch(() => setStatus(`${PLAYER_MODEL_URL} недоступен — показан процедурный персонаж`));
}

// ---------- UI ----------

skelBox.addEventListener("change", applySkeletonViewer);
wireBox.addEventListener("change", applyWireframe);
yawRange.addEventListener("input", applyYaw);
$<HTMLInputElement>("file").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void openFile(f);
});
$<HTMLButtonElement>("reload").addEventListener("click", loadDefault);
$<HTMLButtonElement>("procedural").addEventListener("click", () => {
  setModel(buildProceduralCharacter(scene));
  setStatus("Процедурный персонаж");
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropEl.style.display = "flex";
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropEl.style.display = "none";
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropEl.style.display = "none";
  const f = e.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

// Пробел — идти, C — присед, пока зажаты; J — прыжок
const crouchBox = $<HTMLInputElement>("crouch");
let jumpQueued = false;
$<HTMLButtonElement>("jump").addEventListener("click", () => (jumpQueued = true));
const inControl = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement;
window.addEventListener("keydown", (e) => {
  if (inControl(e)) return;
  if (e.code === "Space") {
    e.preventDefault();
    walkBox.checked = true;
  }
  if (e.code === "KeyC") crouchBox.checked = true;
  if (e.code === "KeyJ" && !e.repeat) jumpQueued = true;
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") walkBox.checked = false;
  if (e.code === "KeyC") crouchBox.checked = false;
});

// Мини-физика для просмотра прыжка/приседа: те же числа, что у игрока
const sim = { y: 0, vy: 0, airborne: false, airTime: 0, land: 0, landT: 0, crouch: 0 };
function stepSim(dt: number): MotionState {
  if (jumpQueued && !sim.airborne) {
    sim.vy = 11.2;
    sim.airborne = true;
    sim.airTime = 0;
  }
  jumpQueued = false;
  if (sim.airborne) {
    sim.vy -= (sim.vy > 0 ? 28 : 46) * dt;
    sim.y += sim.vy * dt;
    sim.airTime += dt;
    if (sim.y <= 0) {
      sim.y = 0;
      sim.airborne = false;
      sim.land = Math.min(1, Math.abs(sim.vy) / 16);
      sim.landT = 0;
      sim.vy = 0;
    }
  } else {
    sim.landT += dt;
  }
  const landAmt = sim.land * (sim.landT < 0.08 ? sim.landT / 0.08 : Math.max(0, 1 - (sim.landT - 0.08) / 0.27));
  const wantCrouch = crouchBox.checked && !sim.airborne ? 1 : 0;
  sim.crouch += (wantCrouch - sim.crouch) * Math.min(1, dt * 10);
  turn.position.y = sim.y;
  const speed = walkBox.checked ? WALK_SPEED * (1 - 0.5 * sim.crouch) : 0;
  return {
    moving: speed > 0,
    speed,
    strafe: 0,
    airborne: sim.airborne,
    vy: sim.vy,
    airTime: sim.airTime,
    land: landAmt,
    crouch: sim.crouch,
    yawRate: 0,
  };
}

// ---------- Цикл ----------

loadDefault();

engine.runRenderLoop(() => {
  const dt = Math.min(0.05, engine.getDeltaTime() / 1000);
  if (turnBox.checked) turn.rotation.y += dt * 0.6;
  model?.update(dt, stepSim(dt));
  scene.render();
});
window.addEventListener("resize", () => engine.resize());
