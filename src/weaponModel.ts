import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Scene } from "@babylonjs/core/scene";

/** Готовая модель пистолета. Нет файла — рисуется заглушка из примитивов. */
export const GUN_MODEL_URL = "/models/gun.glb";
/** Длина пистолета в руке (по стволу), юниты */
const GUN_LENGTH = 0.42;
/** Какая доля высоты снизу — рукоять (по ней ищем, где зад, и где кисть) */
const GRIP_FRACTION = 0.45;
/** Больше — модель слишком тяжёлая для оружия */
const TRIANGLE_LIMIT = 20_000;

/** Экземпляр модели оружия: ствол вдоль +Z, рукоять вниз, кисть в начале координат */
export interface WeaponMesh {
  root: TransformNode;
  meshes: AbstractMesh[];
  /** Срез ствола в локальных координатах root */
  muzzleLocal: Vector3;
  dispose(): void;
}

/** Загруженный файл, из которого можно делать копии (в руку, летающий пистолет) */
export interface WeaponTemplate {
  instantiate(name: string): WeaponMesh;
  info: { url: string; triangles: number; meshCount: number };
}

/** Как повернуть/промасштабировать/сдвинуть исходную модель, чтобы она легла в нашу систему */
interface Fit {
  rotY: number;
  scale: number;
  offset: Vector3;
  muzzleLocal: Vector3;
}

// Один пистолет на сцену — кэш промиса и результата, чтобы рука и дрон брали одну загрузку
const cache = new WeakMap<Scene, { promise: Promise<WeaponTemplate | null>; template: WeaponTemplate | null }>();

/** Загрузить пистолет (один раз на сцену). null — файла нет или он не годится */
export function loadGunTemplate(scene: Scene): Promise<WeaponTemplate | null> {
  let entry = cache.get(scene);
  if (!entry) {
    const e = { promise: null as unknown as Promise<WeaponTemplate | null>, template: null as WeaponTemplate | null };
    e.promise = loadWeaponTemplate(scene, GUN_MODEL_URL, GUN_LENGTH)
      .then((t) => (e.template = t))
      .catch((err) => {
        console.warn(`[weapon] не удалось загрузить ${GUN_MODEL_URL}:`, err);
        return null;
      });
    entry = e;
    cache.set(scene, entry);
  }
  return entry.promise;
}

/** Уже загруженный пистолет или null (ещё грузится / нет файла) */
export function gunTemplate(scene: Scene): WeaponTemplate | null {
  return cache.get(scene)?.template ?? null;
}

async function loadWeaponTemplate(scene: Scene, url: string, length: number): Promise<WeaponTemplate | null> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok || (head.headers.get("content-type") ?? "").includes("text/html")) return null;
  } catch {
    return null;
  }
  const container: AssetContainer = await LoadAssetContainerAsync(url, scene);
  let triangles = 0;
  let meshCount = 0;
  for (const m of container.meshes) {
    if (m.getTotalVertices() === 0) continue;
    triangles += m.getTotalIndices() / 3;
    meshCount++;
  }
  if (meshCount === 0 || triangles > TRIANGLE_LIMIT) {
    console.warn(`[weapon] ${url}: ${triangles} треугольников — модель отклонена`);
    container.dispose();
    return null;
  }

  let n = 0;
  /** Копия модели в сцене (исходная иерархия под pivot) */
  const spawn = (name: string) => {
    const entries = container.instantiateModelsToScene((src) => `${src}#${name}${n++}`, true, { doNotInstantiate: true });
    const root = new TransformNode(name, scene);
    const pivot = new TransformNode(name + "Pivot", scene);
    pivot.parent = root;
    const meshes: AbstractMesh[] = [];
    for (const r of entries.rootNodes) {
      if (!(r instanceof TransformNode)) continue;
      r.parent = pivot;
      for (const m of r.getChildMeshes(false)) if (m.getTotalVertices() > 0) meshes.push(m);
      if ((r as AbstractMesh).getTotalVertices?.() > 0) meshes.push(r as AbstractMesh);
    }
    for (const m of meshes) m.isPickable = false;
    const dispose = () => {
      for (const g of entries.animationGroups) g.dispose();
      for (const s of entries.skeletons) s.dispose();
      root.dispose(false, true);
    };
    return { root, pivot, meshes, dispose };
  };

  // Геометрию меряем на живой копии в сцене: у контейнера мировые матрицы (особенно скиннованных мешей) не те
  const probe = spawn("weaponProbe");
  probe.root.computeWorldMatrix(true);
  const fit = analyzeGun(probe.meshes, length);
  probe.dispose();
  console.info(
    `[weapon] ${url}: ${Math.round(triangles)} треугольников, поворот ${Math.round((fit.rotY * 180) / Math.PI)}°, масштаб ${fit.scale.toFixed(3)}`,
  );

  return {
    info: { url, triangles: Math.round(triangles), meshCount },
    instantiate(name) {
      const inst = spawn(name);
      // pivot: исходная модель -> ствол вдоль +Z, нужный размер, кисть в нуле
      inst.pivot.rotation.y = fit.rotY;
      inst.pivot.scaling.setAll(fit.scale);
      inst.pivot.position.copyFrom(fit.offset);
      return { root: inst.root, meshes: inst.meshes, muzzleLocal: fit.muzzleLocal.clone(), dispose: inst.dispose };
    },
  };
}

/**
 * По геометрии понимаем, как модель лежит: ствол — вдоль длинной горизонтальной оси, рукоять — снизу
 * и у заднего конца, дуло — с противоположной от рукояти стороны. Возвращает поворот вокруг Y,
 * масштаб и сдвиг, при которых ствол смотрит в +Z, длина = length, а стык рукояти со стволом — в нуле.
 */
function analyzeGun(meshes: AbstractMesh[], length: number): Fit {
  // Мировые вершины (со скиннингом — у моделей с костями bind-поза может отличаться от покоя)
  const points: Vector3[] = [];
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    const pos = m.getPositionData(true, true) ?? m.getVerticesData("position");
    if (!pos) continue;
    const wm = m.getWorldMatrix();
    for (let i = 0; i < pos.length; i += 3) {
      const p = Vector3.TransformCoordinates(new Vector3(pos[i], pos[i + 1], pos[i + 2]), wm);
      points.push(p);
      min.minimizeInPlace(p);
      max.maximizeInPlace(p);
    }
  }
  const size = max.subtract(min);
  const center = min.add(max).scaleInPlace(0.5);
  const axis: "x" | "z" = size.x >= size.z ? "x" : "z";
  const other: "x" | "z" = axis === "x" ? "z" : "x";

  // Рукоять — вершины в нижней части; их среднее вдоль ствола показывает, где зад
  const gripTop = min.y + size.y * GRIP_FRACTION;
  let gripSum = 0;
  let gripCnt = 0;
  for (const p of points) {
    if (p.y < gripTop) {
      gripSum += p[axis];
      gripCnt++;
    }
  }
  const gripAt = gripCnt > 0 ? gripSum / gripCnt : center[axis] + size[axis] * 0.25;
  // Дуло — с той стороны от центра, где рукояти нет
  const muzzleSign: 1 | -1 = gripAt <= center[axis] ? 1 : -1;
  const muzzleEnd = muzzleSign > 0 ? max[axis] : min[axis];

  // Поворот вокруг Y: направление на дуло -> +Z. x' = x cos + z sin, z' = -x sin + z cos
  let rotY: number;
  if (axis === "x") rotY = -muzzleSign * (Math.PI / 2); // (s,0,0): z' = -s·sin = 1 -> sin = -s
  else rotY = muzzleSign > 0 ? 0 : Math.PI; // (0,0,s): z' = s·cos = 1

  const scale = length / size[axis];
  const rotScale = (p: Vector3) => {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    return new Vector3((p.x * c + p.z * s) * scale, p.y * scale, (-p.x * s + p.z * c) * scale);
  };
  // Стык рукояти со стволом — там кисть: центр рукояти вдоль ствола, верх рукояти по высоте
  const grip = new Vector3();
  grip[axis] = gripAt;
  grip.y = gripTop;
  grip[other] = center[other];
  const offset = rotScale(grip).negateInPlace();
  // Срез ствола: дульный конец на высоте оси ствола (чуть выше стыка)
  const muzzle = new Vector3();
  muzzle[axis] = muzzleEnd;
  muzzle.y = gripTop + (max.y - gripTop) * 0.45;
  muzzle[other] = center[other];
  const muzzleLocal = rotScale(muzzle).addInPlace(offset);

  return { rotY, scale, offset, muzzleLocal };
}
