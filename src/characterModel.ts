import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { lookRotation } from "./mathUtil";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { ImportMeshAsync, LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { QuadraticErrorSimplification } from "@babylonjs/core/Meshes/meshSimplification";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { detectHumanoidRig, type HumanoidRig } from "./humanoidRig";
import { clamp, smoothstep, type MotionState } from "./motion";

/**
 * Визуальная модель персонажа. Крепится дочерним узлом к невидимому коллайдеру-капсуле,
 * поэтому поворот и движение получает бесплатно. Ноги модели — в локальном (0, 0, 0),
 * смотрит модель вдоль +Z (куда повёрнут коллайдер).
 */
export interface CharacterModel {
  root: TransformNode;
  /** Меши для теней */
  meshes: AbstractMesh[];
  /** Скелет (у GLB с ригом), для отладочного просмотра */
  skeleton: Skeleton | null;
  /** Сведения о модели для страницы просмотра */
  info: CharacterInfo;
  /** Шаг анимации по состоянию движения (скорость, прыжок, присед, приземление) */
  update(dt: number, state: MotionState): void;
  /** Направить оружие на мировую точку (корпус поворачивает Player, модель — наклон руки) */
  aim(target: Vector3): void;
  /** Горизонтальный замах оружейной руки, рад (0 — вдоль прицела); меч машет им */
  swing(angle: number): void;
  /** Мировая позиция среза ствола (откуда вылетают пули) или null, если оружия нет */
  muzzle(): Vector3 | null;
  dispose(): void;
}

/** Что держит персонаж в оружейной руке */
export type HeldWeapon = "gun" | "sword" | "none";

export interface CharacterInfo {
  /** Откуда взята: путь, имя файла или «процедурная» */
  source: string;
  triangles: number;
  meshCount: number;
  bones: number;
  /** Имена настоящих анимаций из файла */
  animations: string[];
  /** Найденные части рига (null — скелета нет или не распознан) */
  rig: HumanoidRig["counts"] | null;
  /** Разворот вокруг Y (рад) и откуда он взялся */
  yaw: number;
  yawSource: "auto" | "option";
}

/** Целевой рост персонажа (высота коллайдера-капсулы) */
export const CHARACTER_HEIGHT = 2.0;

/** Готовая модель игрока. Нет файла — используется процедурная. */
export const PLAYER_MODEL_URL = "/models/player.glb";

// ---------- 1. Процедурная low-poly модель ----------

const PAL = {
  suit: new Color3(0.35, 0.75, 1.0),
  suitDark: new Color3(0.16, 0.24, 0.42),
  skin: new Color3(0.93, 0.8, 0.68),
  visor: new Color3(0.1, 0.12, 0.2),
  gun: new Color3(0.2, 0.2, 0.23),
  gunGlow: new Color3(1, 0.7, 0.15),
};

const SWORD_PAL = {
  blade: new Color3(0.8, 0.88, 1.0),
  bladeGlow: new Color3(0.25, 0.4, 0.6),
  guard: new Color3(0.85, 0.65, 0.2),
};

function flatMat(scene: Scene, name: string, color: Color3, emissive?: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = Color3.Black();
  if (emissive) m.emissiveColor = emissive;
  return m;
}

/** Бокс с заданным размером и позицией, дочерний к parent */
function part(
  scene: Scene,
  name: string,
  size: [number, number, number],
  pos: [number, number, number],
  mat: StandardMaterial,
  parent: TransformNode,
): Mesh {
  const b = CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
  b.position.set(pos[0], pos[1], pos[2]);
  b.material = mat;
  b.parent = parent;
  return b;
}

/** Собирает человечка из примитивов: туловище, голова, руки, ноги, оружие в правой руке */
export function buildProceduralCharacter(scene: Scene, options: { weapon?: HeldWeapon } = {}): CharacterModel {
  const held: HeldWeapon = options.weapon ?? "gun";
  const root = new TransformNode("charModel", scene);
  // Внутренний узел для анимации (подпрыгивание/дыхание) — сам root трогать нельзя,
  // его позицию задаёт Player при подвесе к коллайдеру
  const body = new TransformNode("charBody", scene);
  body.parent = root;
  const meshes: Mesh[] = [];

  const suit = flatMat(scene, "charSuit", PAL.suit, PAL.suit.scale(0.12));
  const suitDark = flatMat(scene, "charSuitDark", PAL.suitDark);
  const skin = flatMat(scene, "charSkin", PAL.skin);
  const visor = flatMat(scene, "charVisor", PAL.visor, new Color3(0.05, 0.3, 0.45));
  const gunMat = flatMat(scene, "charGun", PAL.gun);
  const glowMat = flatMat(scene, "charGunGlow", PAL.gunGlow, PAL.gunGlow);

  // Пропорции (в юнитах): ноги 0..0.95, туловище 0.95..1.6, голова 1.6..2.0
  const HIP = 0.95;
  const SHOULDER = 1.55;

  // Ноги: узел в бедре, чтобы качать вокруг него
  const legL = new TransformNode("legL", scene);
  legL.position.set(-0.16, HIP, 0);
  legL.parent = body;
  meshes.push(part(scene, "legLMesh", [0.26, HIP, 0.28], [0, -HIP / 2, 0], suitDark, legL));

  const legR = new TransformNode("legR", scene);
  legR.position.set(0.16, HIP, 0);
  legR.parent = body;
  meshes.push(part(scene, "legRMesh", [0.26, HIP, 0.28], [0, -HIP / 2, 0], suitDark, legR));

  // Туловище и пояс
  meshes.push(part(scene, "torso", [0.62, SHOULDER - HIP, 0.36], [0, (HIP + SHOULDER) / 2, 0], suit, body));
  meshes.push(part(scene, "belt", [0.64, 0.1, 0.38], [0, HIP + 0.05, 0], suitDark, body));

  // Голова: шар + козырёк-визор спереди
  const head = CreateSphere("head", { diameter: 0.42, segments: 6 }, scene);
  head.position.set(0, SHOULDER + 0.25, 0);
  head.material = skin;
  head.parent = body;
  meshes.push(head);
  meshes.push(part(scene, "visor", [0.36, 0.12, 0.1], [0, SHOULDER + 0.28, 0.18], visor, body));

  // Руки: узел в плече
  const armL = new TransformNode("armL", scene);
  armL.position.set(-0.4, SHOULDER, 0);
  armL.parent = body;
  meshes.push(part(scene, "armLMesh", [0.18, 0.62, 0.2], [0, -0.31, 0], suit, armL));

  const armR = new TransformNode("armR", scene);
  armR.position.set(0.4, SHOULDER, 0);
  armR.parent = body;
  armR.rotation.x = -Math.PI / 2 + 0.15; // вытянута вперёд, чуть вниз
  meshes.push(part(scene, "armRMesh", [0.18, 0.62, 0.2], [0, -0.31, 0], suit, armR));

  // Оружие в правой руке (в системе координат руки: рука тянется по -Y, "вперёд" = -Y)
  let gunGlow: Mesh | null = null;
  if (held === "gun") {
    meshes.push(part(scene, "gunBody", [0.14, 0.42, 0.16], [0, -0.7, 0.02], gunMat, armR));
    meshes.push(part(scene, "gunGrip", [0.1, 0.12, 0.1], [0, -0.55, -0.12], gunMat, armR));
    gunGlow = part(scene, "gunGlow", [0.08, 0.06, 0.08], [0, -0.92, 0.02], glowMat, armR);
    meshes.push(gunGlow);
  } else if (held === "sword") {
    const blade = flatMat(scene, "charBlade", SWORD_PAL.blade, SWORD_PAL.bladeGlow);
    const guard = flatMat(scene, "charGuard", SWORD_PAL.guard);
    meshes.push(part(scene, "swordGrip", [0.07, 0.24, 0.07], [0, -0.66, 0.02], gunMat, armR));
    meshes.push(part(scene, "swordGuard", [0.3, 0.05, 0.08], [0, -0.8, 0.02], guard, armR));
    meshes.push(part(scene, "swordBlade", [0.045, 1.05, 0.14], [0, -1.35, 0.02], blade, armR));
    meshes.push(part(scene, "swordTip", [0.045, 0.12, 0.07], [0, -1.93, 0.02], blade, armR));
  }

  let phase = 0;
  let blend = 0; // 0 — стоим, 1 — идём (сглаживает старт/остановку)
  let air = 0; // 0 — на земле, 1 — поза прыжка
  let leap = 0;
  let leadSign = 1;
  let lean = 0;
  let time = 0;
  const ARM_R_REST = -Math.PI / 2 + 0.15;
  let aimPitch = 0;
  let swingYaw = 0;

  return {
    root,
    meshes,
    skeleton: null,
    info: {
      source: "процедурная",
      triangles: triangleCount(meshes),
      meshCount: meshes.length,
      bones: 0,
      animations: [],
      rig: null,
      yaw: 0,
      yawSource: "option",
    },
    update(dt, st) {
      time += dt;
      const walking = st.moving && !st.airborne;
      blend += ((walking ? 1 : 0) - blend) * Math.min(1, dt * 10);
      if (walking) phase += dt * st.speed * 1.5;
      const swing = Math.sin(phase) * 0.6 * blend;

      if (st.airborne) {
        if (air === 0) {
          leadSign = Math.sin(phase) >= 0 ? 1 : -1;
          leap = Math.abs(st.speed) > 2.5 ? 1 : 0;
        }
        air = smoothstep(st.airTime / 0.12);
      } else {
        air += (0 - air) * Math.min(1, dt * 14);
      }
      const prep = st.airborne ? clamp(-st.vy / 9, 0, 1) : 1;

      // Присед и амортизация: ноги расходятся вперёд/назад на θ, таз опускается на HIP·(1−cos θ) — ступни на земле
      const theta = 0.55 * st.crouch + 0.4 * st.land;
      const hipDrop = HIP * (1 - Math.cos(theta));

      let lL = swing + theta;
      let lR = -swing - theta;
      if (air > 0) {
        // Прыжок с места — обе ноги поджаты вперёд; leap — ведущая вперёд, задняя назад; к земле — выпрямляются
        const tuck = 0.9 - 0.6 * prep;
        const lead = 1.0 - 0.65 * prep;
        const trail = -0.55 + 0.7 * prep;
        lL += air * (leap ? (leadSign > 0 ? lead : trail) : tuck);
        lR += air * (leap ? (leadSign < 0 ? lead : trail) : tuck);
      }
      legL.rotation.x = lL;
      legR.rotation.x = lR;
      armL.rotation.x = -swing * 0.8 - air * (0.9 - 0.4 * prep) - 0.2 * st.crouch;
      // Правая рука с оружием: наклон к прицелу (рука тянется вдоль -Y, поэтому вверх = ещё отрицательнее)
      armR.rotation.x = ARM_R_REST - aimPitch - lean; // наклон корпуса вперёд опускает руку — поднимаем на столько же
      armR.rotation.y = swingYaw; // замах мечом: вытянутая рука уходит вбок

      // Корпус: наклон по скорости/приседу/прыжку, крен в стрейф, подпрыгивание при шаге, дыхание на месте
      const targetLean = 0.014 * st.speed + 0.28 * st.crouch + 0.2 * st.land + air * (leap ? 0.22 : 0.08);
      lean += (targetLean - lean) * Math.min(1, dt * 8);
      body.rotation.x = lean;
      body.rotation.z = 0.08 * st.strafe + 0.03 * Math.sin(phase) * blend + 0.012 * Math.sin(time * 0.8) * (1 - blend);
      body.position.y = Math.abs(Math.sin(phase)) * 0.06 * blend - hipDrop;
      body.scaling.y = 1 + Math.sin(time * 1.7) * 0.008 * (1 - blend);
    },
    aim(target) {
      armR.computeWorldMatrix(true);
      const d = target.subtract(armR.getAbsolutePosition());
      const len = d.length();
      if (len > 1e-6) aimPitch = Math.max(-1.1, Math.min(1.1, Math.asin(d.y / len)));
    },
    swing(angle) {
      swingYaw = angle;
    },
    muzzle() {
      // Рука уже повёрнута в update(); матрицу пересчитываем принудительно — мы до рендера
      if (!gunGlow) return null;
      gunGlow.computeWorldMatrix(true);
      return gunGlow.getAbsolutePosition().clone();
    },
    dispose() {
      root.dispose(false, true);
    },
  };
}

// ---------- 2. Готовая GLB-модель с облегчением ----------

export interface GlbOptions {
  /** Целевой рост в юнитах */
  height?: number;
  /** Поворот модели вокруг Y, чтобы смотрела вдоль +Z (у glTF-персонажей обычно нужен PI) */
  yaw?: number;
  /** Если треугольников больше — нескиннованные меши упрощаются до этого бюджета */
  triangleBudget?: number;
  /** Если треугольников больше — модель отклоняется целиком */
  triangleHardLimit?: number;
  /** Что вложить в оружейную руку */
  weapon?: HeldWeapon;
}

const DEFAULT_GLB: Required<GlbOptions> = {
  height: CHARACTER_HEIGHT,
  yaw: Math.PI,
  triangleBudget: 6000,
  triangleHardLimit: 200_000,
  weapon: "gun",
};

function triangleCount(meshes: AbstractMesh[]): number {
  let n = 0;
  for (const m of meshes) n += m.getTotalIndices() / 3;
  return n;
}

/** Упростить меш до доли quality от исходных треугольников. Возвращает новый меш. */
function simplifyMesh(mesh: Mesh, quality: number): Promise<Mesh> {
  return new Promise((resolve) => {
    new QuadraticErrorSimplification(mesh).simplify({ quality, distance: 0, optimizeMesh: true }, (result) => {
      // Симплификатор копирует материал и родителя, но не трансформ и видимость
      result.position.copyFrom(mesh.position);
      result.scaling.copyFrom(mesh.scaling);
      if (mesh.rotationQuaternion) result.rotationQuaternion = mesh.rotationQuaternion.clone();
      else result.rotation.copyFrom(mesh.rotation);
      result.isVisible = true;
      result.name = mesh.name;
      mesh.dispose(false, false);
      resolve(result);
    });
  });
}

/**
 * Загружает GLB, приводит к росту height, поворачивает вдоль +Z, ставит ноги в (0,0,0),
 * при необходимости облегчает. Возвращает null, если файла нет или модель слишком тяжёлая.
 * source — URL или File (перетащенный в окно просмотра).
 */
export async function loadGlbCharacter(
  scene: Scene,
  source: string | File,
  options: GlbOptions = {},
): Promise<CharacterModel | null> {
  const opt = { ...DEFAULT_GLB, ...options };
  const url = typeof source === "string" ? source : source.name;

  // Нет файла — тихо выходим (Vite на неизвестный путь может отдать index.html)
  if (typeof source === "string") {
    try {
      const head = await fetch(source, { method: "HEAD" });
      if (!head.ok || (head.headers.get("content-type") ?? "").includes("text/html")) return null;
    } catch {
      return null;
    }
  }

  const result = await ImportMeshAsync(source, scene);
  let meshes = result.meshes.filter((m) => m.getTotalVertices() > 0);
  const total = triangleCount(meshes);

  if (total > opt.triangleHardLimit) {
    console.warn(`[model] ${url}: ${total} треугольников — больше лимита ${opt.triangleHardLimit}, модель отклонена`);
    for (const m of result.meshes) m.dispose();
    for (const g of result.animationGroups) g.dispose();
    return null;
  }

  // Облегчение: упрощаем только нескиннованные меши (симплификатор теряет веса костей)
  if (total > opt.triangleBudget) {
    const quality = opt.triangleBudget / total;
    const out: AbstractMesh[] = [];
    for (const m of meshes) {
      if (m instanceof Mesh && !m.skeleton && m.getTotalIndices() > 300) {
        out.push(await simplifyMesh(m, quality));
      } else {
        out.push(m);
      }
    }
    meshes = out;
    console.info(`[model] ${url}: ${total} → ${Math.round(triangleCount(meshes))} треугольников (quality ${quality.toFixed(2)})`);
  }

  return assembleCharacter({
    scene,
    url,
    meshes,
    roots: result.meshes.filter((m) => !m.parent),
    skeleton: result.skeletons[0] ?? null,
    groups: result.animationGroups,
    opt,
    weapon: opt.weapon,
  });
}

// ---------- 2a. Сборка персонажа из загруженных узлов (общая для файла и для клонов) ----------

interface AssembleInput {
  scene: Scene;
  url: string;
  /** Меши с вершинами */
  meshes: AbstractMesh[];
  /** Корневые узлы glTF-иерархии */
  roots: TransformNode[];
  skeleton: Skeleton | null;
  groups: AnimationGroup[];
  opt: Required<GlbOptions>;
  /** Что вложить в правую руку */
  weapon: HeldWeapon;
  /** Масштаб всего персонажа (рост = height × scale) */
  scale?: number;
  /** Перекрасить все материалы (враги) */
  tint?: Color3;
  emissive?: Color3;
  /** Склеить скиннованные меши в один — один draw call на персонажа */
  merge?: boolean;
  /** Не писать в консоль (клоны) */
  quiet?: boolean;
  /** Имя мешей (по нему стреляем: "enemy") */
  meshName?: string;
}

/**
 * Иерархия: holder (поворот лицом по +Z) -> body (наклон/подпрыгивание) -> pivot (масштаб, центр) -> glTF.
 * Нормализует рост, ставит ноги в (0,0,0), распознаёт риг, ставит оружие, красит.
 */
function assembleCharacter(inp: AssembleInput): CharacterModel {
  const { scene, url, roots, skeleton, groups, opt } = inp;
  let meshes = inp.meshes;
  const log = inp.quiet ? () => {} : console.info.bind(console);

  if (inp.merge) meshes = mergeSkinned(scene, meshes);
  if (inp.tint) tintMeshes(meshes, inp.tint, inp.emissive);
  if (inp.meshName) for (const m of meshes) m.name = inp.meshName;

  const holder = new TransformNode("charModel", scene);
  const body = new TransformNode("charBody", scene);
  body.parent = holder;
  const pivot = new TransformNode("charPivot", scene);
  pivot.parent = body;
  for (const r of roots) r.parent = pivot;

  // Нормализация: рост -> height, ноги -> y=0, центр по X/Z
  pivot.computeWorldMatrix(true);
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bb.minimumWorld);
    max = Vector3.Maximize(max, bb.maximumWorld);
  }
  const srcHeight = Math.max(1e-3, max.y - min.y);
  const scale = opt.height / srcHeight;
  pivot.scaling.setAll(scale);
  pivot.position.set(-((min.x + max.x) / 2) * scale, -min.y * scale, -((min.z + max.z) / 2) * scale);
  holder.computeWorldMatrix(true);

  // Анимации из файла: ищем idle/walk по имени. Группы из одного кадра — это просто поза, не анимация.
  const real = groups.filter((g) => g.to > g.from);
  const find = (re: RegExp) => real.find((g) => re.test(g.name));
  const walk = find(/walk|run|move/i) ?? null;
  const idle = find(/idle|stand/i) ?? (walk ? null : real[0] ?? null);
  for (const g of groups) g.stop();

  // Скелет без анимаций: распознаём риг и ходим процедурно. Заодно узнаём, куда модель смотрит.
  const rig = !walk && skeleton ? detectHumanoidRig(skeleton, opt.height, meshes, inp.quiet) : null;
  let yawSource: CharacterInfo["yawSource"] = "option";
  if (rig?.forward) {
    holder.rotation.y = -Math.atan2(rig.forward.x, rig.forward.z);
    yawSource = "auto";
    log(`[model] ${url}: риг распознан, разворот ${Math.round((holder.rotation.y * 180) / Math.PI)}°`);
  } else {
    holder.rotation.y = opt.yaw;
  }
  if (rig?.animated) log(`[model] ${url}: анимаций в файле нет — включена процедурная ходьба по скелету`);

  // Оружие-заглушка в оружейной руке (пока нет моделей оружия)
  const gun =
    inp.weapon !== "none" && rig?.weaponHand
      ? attachHeldWeapon(scene, rig.weaponHand.node, rig.weaponHand.forward, inp.weapon)
      : null;
  if (gun) {
    gun.root.scaling.setAll(inp.scale ?? 1); // оружие живёт в мировых координатах, масштаб задаём ему отдельно
    meshes = [...meshes, ...gun.meshes];
  }
  if (inp.scale && inp.scale !== 1) holder.scaling.setAll(inp.scale);

  const info: CharacterInfo = {
    source: url,
    triangles: Math.round(triangleCount(meshes)),
    meshCount: meshes.length,
    bones: skeleton?.bones.length ?? 0,
    animations: real.map((g) => g.name),
    rig: rig ? rig.counts : null,
    yaw: holder.rotation.y,
    yawSource,
  };

  let current: AnimationGroup | null = null;
  const play = (g: AnimationGroup | null) => {
    if (g === current) return;
    current?.stop();
    current = g;
    g?.start(true);
  };
  play(idle ?? walk);

  let phase = 0;
  let blend = 0;

  return {
    root: holder,
    meshes,
    skeleton,
    info,
    update(dt, st) {
      const walking = st.moving && !st.airborne;
      if (walk || idle) play(walking ? (walk ?? idle) : (idle ?? walk));
      if (rig?.animated) {
        const pose = rig.update(dt, st);
        // Узел тела: подпрыгивание при шаге, опускание таза (присед/приземление — ноги согнуты ровно на столько),
        // наклон всего тела — только если у рига нет позвоночника
        blend += ((walking ? 1 : 0) - blend) * Math.min(1, dt * 10);
        if (walking) phase += dt * st.speed * 1.5;
        body.rotation.x = pose.bodyLean;
        body.position.y = Math.abs(Math.sin(phase)) * 0.04 * blend - pose.hipDrop;
      }
      gun?.sync();
    },
    aim(target) {
      if (!rig?.weaponHand) return;
      // Направление от плеча на цель — рука поворачивается в плече
      rig.weaponHand.shoulder.computeWorldMatrix(true);
      rig.aim(target.subtract(rig.weaponHand.shoulder.getAbsolutePosition()));
    },
    swing(angle) {
      rig?.swing(angle);
    },
    muzzle() {
      if (!gun) return null;
      gun.sync();
      return gun.muzzle();
    },
    dispose() {
      for (const g of groups) g.dispose();
      gun?.root.dispose(false, true);
      holder.dispose(false, true);
      skeleton?.dispose();
    },
  };
}

/**
 * Склеить скиннованные меши одного скелета в один меш (один draw call вместо N).
 * Условие: общий скелет, общий родитель и единичные локальные трансформы — тогда вершины
 * можно просто сложить, не пересчитывая веса. Иначе возвращаем как есть.
 * Разные материалы сохраняются подмешами через MultiMaterial.
 */
function mergeSkinned(scene: Scene, meshes: AbstractMesh[]): AbstractMesh[] {
  const skinned = meshes.filter((m): m is Mesh => m instanceof Mesh && !!m.skeleton);
  if (skinned.length < 2) return meshes;
  const first = skinned[0];
  const identity = (m: Mesh) =>
    m.position.lengthSquared() < 1e-8 &&
    Math.abs(m.scaling.x - 1) + Math.abs(m.scaling.y - 1) + Math.abs(m.scaling.z - 1) < 1e-6 &&
    (m.rotationQuaternion ? Math.abs(m.rotationQuaternion.w) > 1 - 1e-6 : m.rotation.lengthSquared() < 1e-8);
  const ok = skinned.every(
    (m) => m.skeleton === first.skeleton && m.parent === first.parent && identity(m) && m.numBoneInfluencers === first.numBoneInfluencers,
  );
  if (!ok) return meshes;

  const datas = skinned.map((m) => VertexData.ExtractFromMesh(m, true, true));
  const kinds = new Set(Object.keys(datas[0]).filter((k) => (datas[0] as unknown as Record<string, unknown>)[k]));
  if (!datas.every((d) => Object.keys(d).filter((k) => (d as unknown as Record<string, unknown>)[k]).every((k) => kinds.has(k)))) return meshes;

  const merged = new Mesh(first.name, scene);
  merged.parent = first.parent;
  datas[0].merge(datas.slice(1), true).applyToMesh(merged);
  merged.skeleton = first.skeleton;
  merged.numBoneInfluencers = first.numBoneInfluencers;
  merged.sideOrientation = first.sideOrientation;
  merged.isPickable = first.isPickable;

  const materials = skinned.map((m) => m.material);
  if (materials.some((mat) => mat !== materials[0])) {
    merged.subMeshes = [];
    let start = 0;
    skinned.forEach((m, i) => {
      const count = m.getTotalIndices();
      SubMesh.CreateFromIndices(i, start, count, merged);
      start += count;
    });
    const multi = new MultiMaterial(first.name + "_multi", scene);
    multi.subMaterials = materials;
    merged.material = multi;
  } else {
    merged.material = materials[0];
  }
  for (const m of skinned) m.dispose(false, false);
  return [...meshes.filter((m) => !(skinned as AbstractMesh[]).includes(m)), merged];
}

/** Перекрасить готовую модель (процедурная: материалы у каждой сборки свои) */
export function tintCharacter(model: CharacterModel, tint: Color3, emissive?: Color3): void {
  tintMeshes(model.meshes, tint, emissive);
}

/** Перекрасить материалы мешей (материалы должны быть уже собственными — клонированными) */
function tintMeshes(meshes: AbstractMesh[], tint: Color3, emissive?: Color3): void {
  const seen = new Set<Material>();
  const paint = (mat: Material | null) => {
    if (!mat || seen.has(mat)) return;
    seen.add(mat);
    if (mat instanceof MultiMaterial) {
      for (const s of mat.subMaterials) paint(s);
    } else if (mat instanceof PBRMaterial) {
      mat.albedoColor = tint;
      if (emissive) mat.emissiveColor = emissive;
    } else if (mat instanceof StandardMaterial) {
      mat.diffuseColor = tint;
      if (emissive) mat.emissiveColor = emissive;
    }
  };
  for (const m of meshes) paint(m.material);
}

// ---------- 2b. Шаблон: один раз загрузить, много раз клонировать (враги) ----------

export interface InstantiateOptions {
  /** Масштаб (0.5 — вдвое меньше игрока) */
  scale: number;
  tint: Color3;
  emissive?: Color3;
  /** Имя мешей (для выбора прицелом) */
  meshName?: string;
}

export interface CharacterTemplate {
  /** Независимая копия: свой скелет, свои материалы, свой риг */
  instantiate(options: InstantiateOptions): CharacterModel;
  dispose(): void;
}

/**
 * Загружает GLB в контейнер (в сцену не добавляет) и отдаёт фабрику копий.
 * Копии склеиваются в один меш и красятся. null — файла нет или он слишком тяжёлый.
 */
export async function loadCharacterTemplate(scene: Scene, url: string, options: GlbOptions = {}): Promise<CharacterTemplate | null> {
  const opt = { ...DEFAULT_GLB, ...options };
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok || (head.headers.get("content-type") ?? "").includes("text/html")) return null;
  } catch {
    return null;
  }
  const container: AssetContainer = await LoadAssetContainerAsync(url, scene);
  const total = triangleCount(container.meshes);
  if (total > opt.triangleBudget * 2) {
    console.warn(`[model] ${url}: ${total} треугольников — слишком тяжёлая для толпы, шаблон отклонён`);
    container.dispose();
    return null;
  }
  let n = 0;
  return {
    instantiate(o) {
      const id = n++;
      const entries = container.instantiateModelsToScene((name) => `${name}#${id}`, true, { doNotInstantiate: true });
      const meshes: AbstractMesh[] = [];
      for (const root of entries.rootNodes) {
        if (root instanceof TransformNode) {
          for (const m of root.getChildMeshes(false)) if (m.getTotalVertices() > 0) meshes.push(m);
          if ((root as AbstractMesh).getTotalVertices?.() > 0) meshes.push(root as AbstractMesh);
        }
      }
      return assembleCharacter({
        scene,
        url,
        meshes,
        roots: entries.rootNodes.filter((r): r is TransformNode => r instanceof TransformNode),
        skeleton: entries.skeletons[0] ?? null,
        groups: entries.animationGroups,
        opt,
        weapon: "none",
        scale: o.scale,
        tint: o.tint,
        emissive: o.emissive,
        merge: true,
        quiet: true,
        meshName: o.meshName,
      });
    },
    dispose() {
      container.dispose();
    },
  };
}

// ---------- 3. Оружие-заглушка ----------

interface AttachedGun {
  root: TransformNode;
  meshes: AbstractMesh[];
  /** Подтянуть к кисти (вызывать каждый кадр после анимации скелета) */
  sync(): void;
  /** Мировая позиция среза ствола */
  muzzle(): Vector3;
}

/** Срез ствола заглушки в локальных координатах оружия */
export const GUN_MUZZLE_LOCAL = new Vector3(0, 0.05, 0.34);

/** Пистолет из примитивов: ствол вдоль +Z, рукоять вниз. Используется в руке игрока и как летающий пистолет. */
export function buildGunMesh(scene: Scene, name = "gun", accent = new Color3(1, 0.7, 0.15)): { root: TransformNode; meshes: Mesh[] } {
  const root = new TransformNode(name, scene);
  root.rotationQuaternion = Quaternion.Identity();
  const dark = flatMat(scene, name + "Dark", new Color3(0.16, 0.16, 0.19));
  const glow = flatMat(scene, name + "GlowMat", accent, accent.scale(0.85));
  const meshes = [
    part(scene, name + "Barrel", [0.07, 0.08, 0.3], [0, 0.05, 0.16], dark, root),
    part(scene, name + "Grip", [0.06, 0.14, 0.07], [0, -0.05, 0.02], dark, root),
    part(scene, name + "Muzzle", [0.05, 0.05, 0.04], [0, 0.05, 0.32], glow, root),
  ];
  for (const m of meshes) m.isPickable = false;
  return { root, meshes };
}

/** Меч из примитивов: клинок вдоль +Z от рукояти в начале координат */
export function buildSwordMesh(scene: Scene, name = "sword"): { root: TransformNode; meshes: Mesh[] } {
  const root = new TransformNode(name, scene);
  root.rotationQuaternion = Quaternion.Identity();
  const dark = flatMat(scene, name + "Dark", new Color3(0.16, 0.16, 0.19));
  const blade = flatMat(scene, name + "Blade", SWORD_PAL.blade, SWORD_PAL.bladeGlow);
  const guard = flatMat(scene, name + "Guard", SWORD_PAL.guard);
  const meshes = [
    part(scene, name + "Pommel", [0.07, 0.07, 0.05], [0, 0, -0.2], dark, root),
    part(scene, name + "Grip", [0.05, 0.05, 0.24], [0, 0, -0.06], dark, root),
    part(scene, name + "Guard", [0.3, 0.06, 0.06], [0, 0, 0.08], guard, root),
    part(scene, name + "Blade", [0.045, 0.14, 1.05], [0, 0, 0.64], blade, root),
    part(scene, name + "Tip", [0.045, 0.07, 0.12], [0, 0, 1.22], blade, root),
  ];
  for (const m of meshes) m.isPickable = false;
  return { root, meshes };
}

/**
 * Оружие из примитивов в кисти. Не парентим к кости (у glTF там зеркальные масштабы),
 * а каждый кадр ставим в мировую позицию кисти с фиксированным смещением поворота,
 * вычисленным один раз: ствол/клинок — вдоль предплечья (handForward), рукоять — вниз.
 */
function attachHeldWeapon(scene: Scene, hand: TransformNode, handForward: Vector3, kind: HeldWeapon): AttachedGun {
  const { root, meshes } = kind === "sword" ? buildSwordMesh(scene) : buildGunMesh(scene);

  const scale = new Vector3();
  const rot = new Quaternion();
  const position = new Vector3();
  hand.computeWorldMatrix(true).decompose(scale, rot, position);
  // Желаемый мировой поворот: локальный +Z -> вдоль предплечья, +Y -> мировой верх (явно из базиса)
  const desired = lookRotation(handForward, Vector3.Up());
  // Локальное смещение относительно кисти. У Babylon a.multiply(b) — гамильтоново произведение
  // («сначала b, потом a»), поэтому gun = hand * offset, где offset = hand0^-1 * desired.
  const offset = Quaternion.Inverse(rot).multiply(desired);

  const sync = () => {
    hand.computeWorldMatrix(true).decompose(scale, rot, position);
    root.position.copyFrom(position);
    rot.multiplyToRef(offset, root.rotationQuaternion!);
  };
  sync();
  // Самопроверка: ствол должен смотреть вдоль предплечья
  root.computeWorldMatrix(true);
  const check = root.getDirection(Vector3.Forward());
  if (Vector3.Dot(check, handForward) < 0.9) {
    console.warn("[model] ориентация оружия не совпала с предплечьем:", check.asArray().map((v) => v.toFixed(2)));
  }

  const muzzle = () => {
    root.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(GUN_MUZZLE_LOCAL, root.getWorldMatrix());
  };

  return { root, meshes, sync, muzzle };
}

/**
 * Модель игрока: сразу процедурная, а если рядом лежит GLB — подменяется на него, когда загрузится.
 * onReplace вызывается при подмене (чтобы перевесить тени и т. п.).
 */
export function createPlayerModel(
  scene: Scene,
  glbUrl: string,
  onReplace: (model: CharacterModel) => void,
  onError?: (err: unknown) => void,
  weapon: HeldWeapon = "gun",
): CharacterModel {
  const procedural = buildProceduralCharacter(scene, { weapon });
  loadGlbCharacter(scene, glbUrl, { weapon })
    .then((glb) => {
      if (glb) onReplace(glb);
    })
    .catch((err) => {
      console.warn(`[model] не удалось загрузить ${glbUrl}:`, err);
      onError?.(err);
    });
  return procedural;
}
