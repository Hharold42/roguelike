import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { CHUNK_CELLS, HEX_HEIGHT_MAX, HEX_HEIGHT_MIN, HEX_R, TILE, Terrain } from "./terrain";

/** На сколько блок утоплен в рельеф (чтобы не висел на склонах) */
const WALL_SINK = 0.8;

// ---------- Палитра земли ----------
// Цвет треугольника выбирается по его средней высоте: первая полоса, в которую
// попала высота (h <= upTo). Крутые склоны красятся в ROCK независимо от высоты.
// Правьте цвета и границы здесь.

type RGB = readonly [number, number, number];

const PALETTE: ReadonlyArray<{ upTo: number; color: RGB }> = [
  { upTo: -1.6, color: [0.12, 0.27, 0.17] }, // низины — тёмная трава
  { upTo: 0.3, color: [0.2, 0.42, 0.19] }, // равнина — трава
  { upTo: 1.6, color: [0.36, 0.44, 0.19] }, // пригорки — сухая трава
  { upTo: 2.8, color: [0.47, 0.37, 0.25] }, // склоны холмов — земля
  { upTo: Infinity, color: [0.56, 0.54, 0.56] }, // вершины — камень
];
const ROCK: RGB = [0.5, 0.48, 0.5];
/** Если normal.y ниже этого — склон считается крутым (скала) */
const ROCK_SLOPE = 0.72;
/** Лёгкая вариация яркости треугольника, чтобы не было «пластмассы» */
const JITTER = 0.035;

export interface ChunkMeshes {
  cx: number;
  cz: number;
  ground: Mesh;
  wallSource: Mesh | null;
  walls: AbstractMesh[];
  dispose(): void;
}

function pickColor(h: number, normalY: number): RGB {
  if (normalY < ROCK_SLOPE) return ROCK;
  for (const band of PALETTE) if (h <= band.upTo) return band.color;
  return PALETTE[PALETTE.length - 1].color;
}

/** Детерминированный «шум» для джиттера цвета по позиции треугольника */
function jitterAt(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2 * JITTER;
}

/**
 * Строит меши одного чанка: землю (вершины смещены по высоте, плоское затенение,
 * цвет — из палитры) и стены-инстансы.
 */
export function buildChunkMeshes(
  scene: Scene,
  terrain: Terrain,
  cx: number,
  cz: number,
  groundMat: Material,
  wallMat: Material,
): ChunkMeshes {
  const N = CHUNK_CELLS;
  const baseX = cx * N; // индекс первого узла сетки по X
  const baseZ = cz * N;

  // --- Высоты узлов сетки (N+1)^2 ---
  const V = N + 1;
  const heights = new Float32Array(V * V);
  for (let iz = 0; iz < V; iz++) {
    for (let ix = 0; ix < V; ix++) {
      heights[iz * V + ix] = terrain.vertexHeight(baseX + ix, baseZ + iz);
    }
  }

  // --- Плоское затенение: у каждого треугольника свои 3 вершины ---
  const triCount = N * N * 2;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 12);
  const indices = new Uint32Array(triCount * 3);

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();

  let v = 0; // индекс вершины
  const emitTriangle = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    ccx: number, cy: number, ccz: number,
  ) => {
    a.set(ax, ay, az);
    b.set(bx, by, bz);
    c.set(ccx, cy, ccz);
    b.subtractToRef(a, ab);
    c.subtractToRef(a, ac);
    Vector3.CrossToRef(ab, ac, n);
    // Лицевая сторона у Babylon (левосторонняя система) — при cross(b-a, c-a).y < 0.
    // Если получилось наоборот — меняем порядок обхода.
    if (n.y > 0) {
      const t = b.clone();
      b.copyFrom(c);
      c.copyFrom(t);
      n.scaleInPlace(-1);
    }
    n.normalize();
    // Нормаль для освещения — вверх
    if (n.y < 0) n.scaleInPlace(-1);

    const hAvg = (ay + by + cy) / 3;
    const col = pickColor(hAvg, n.y);
    const j = jitterAt((ax + bx + ccx) / 3, (az + bz + ccz) / 3);

    for (const p of [a, b, c]) {
      positions[v * 3] = p.x;
      positions[v * 3 + 1] = p.y;
      positions[v * 3 + 2] = p.z;
      normals[v * 3] = n.x;
      normals[v * 3 + 1] = n.y;
      normals[v * 3 + 2] = n.z;
      colors[v * 4] = col[0] + j;
      colors[v * 4 + 1] = col[1] + j;
      colors[v * 4 + 2] = col[2] + j;
      colors[v * 4 + 3] = 1;
      indices[v] = v;
      v++;
    }
  };

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x0 = (baseX + ix) * TILE;
      const x1 = x0 + TILE;
      const z0 = (baseZ + iz) * TILE;
      const z1 = z0 + TILE;
      const h00 = heights[iz * V + ix];
      const h10 = heights[iz * V + ix + 1];
      const h01 = heights[(iz + 1) * V + ix];
      const h11 = heights[(iz + 1) * V + ix + 1];

      // Диагональ чередуем по чётности клетки — так рельеф выглядит естественнее
      if ((ix + iz) % 2 === 0) {
        emitTriangle(x0, h00, z0, x1, h10, z0, x1, h11, z1);
        emitTriangle(x0, h00, z0, x1, h11, z1, x0, h01, z1);
      } else {
        emitTriangle(x0, h00, z0, x1, h10, z0, x0, h01, z1);
        emitTriangle(x1, h10, z0, x1, h11, z1, x0, h01, z1);
      }
    }
  }

  const ground = new Mesh(`ground_${cx}_${cz}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.colors = colors;
  vd.indices = indices;
  vd.applyToMesh(ground, false);
  ground.material = groundMat;
  ground.receiveShadows = true;
  ground.isPickable = true;
  ground.metadata = { isGround: true };
  ground.freezeWorldMatrix(); // позиции уже в мировых координатах
  // Коллизии с землёй не нужны: высоту выставляем вручную через getHeight

  // --- Стены: шестигранные призмы. Первая — источник (высота 1, масштабируем по Y),
  // остальные — инстансы с собственной высотой и оттенком ---
  const walls: AbstractMesh[] = [];
  let wallSource: Mesh | null = null;
  for (const hex of terrain.getChunk(cx, cz).hexes) {
    const base = terrain.getHeight(hex.x, hex.z);

    let wall: AbstractMesh;
    if (!wallSource) {
      wallSource = CreateCylinder(
        `wall_${cx}_${cz}`,
        { diameter: HEX_R * 2, height: 1, tessellation: 6 },
        scene,
      );
      // У цилиндра нормали сглажены по кругу — шестигранник выглядит круглым.
      // Разделяем вершины по граням: каждая грань плоская, свет ломается на рёбрах.
      wallSource.convertToFlatShadedMesh();
      wallSource.material = wallMat;
      wallSource.receiveShadows = true; // тени соседних блоков и игрока на стенах
      wallSource.registerInstancedBuffer(VertexBuffer.ColorKind, 4);
      wall = wallSource;
    } else {
      wall = wallSource.createInstance(`wall_${hex.q}_${hex.r}`);
    }
    // Утапливаем в склон, чтобы блок не висел над рельефом
    wall.scaling.set(1, hex.height + WALL_SINK, 1);
    wall.position = new Vector3(hex.x, base + (hex.height - WALL_SINK) / 2, hex.z);
    // Высокие блоки чуть светлее — читается как разные «камни»
    const t = Math.max(0, Math.min(1, (hex.height - HEX_HEIGHT_MIN) / (HEX_HEIGHT_MAX - HEX_HEIGHT_MIN)));
    const shade = 0.85 + 0.3 * t;
    (wall as Mesh | InstancedMesh).instancedBuffers[VertexBuffer.ColorKind] = new Color4(
      shade,
      shade,
      shade * 1.04,
      1,
    );
    wall.checkCollisions = true;
    wall.freezeWorldMatrix();
    walls.push(wall);
  }

  return {
    cx,
    cz,
    ground,
    wallSource,
    walls,
    dispose() {
      ground.dispose(false, false);
      if (wallSource) wallSource.dispose(false, false); // инстансы удалятся вместе с источником
    },
  };
}