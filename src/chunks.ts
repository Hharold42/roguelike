import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { Terrain, chunkKey } from "./terrain";
import { buildChunkMeshes, type ChunkMeshes } from "./terrainMesh";

/** Радиус (в чанках) вокруг игрока, в котором чанки загружены: 2 -> 5x5 = 160x160 юнитов */
const LOAD_RADIUS = 2;
/** Чанки дальше этого радиуса выгружаются (гистерезис, чтобы не мигали на границе) */
const UNLOAD_RADIUS = 3;
/** Сколько чанков строить за кадр: переход границы даёт 5 новых (~0.7 мс каждый), размазываем на кадры */
const BUILDS_PER_FRAME = 1;

/**
 * Подгружает/выгружает чанки вокруг игрока (как в Minecraft).
 * Данные чанков (высоты, стены) живут в Terrain, здесь — только меши.
 */
export class ChunkManager {
  private loaded = new Map<number, ChunkMeshes>();
  private groundMat: StandardMaterial;
  private wallMat: StandardMaterial;
  private terrain: Terrain | null = null;
  private lastCx = NaN;
  private lastCz = NaN;
  /** Очередь на постройку (ключи чанков), ближние первыми */
  private pending: Array<{ cx: number; cz: number }> = [];

  constructor(
    private scene: Scene,
    private shadows: ShadowGenerator,
  ) {
    this.groundMat = new StandardMaterial("groundMat", scene);
    this.groundMat.diffuseColor = Color3.White(); // вершинные цвета перемножаются с diffuse
    this.groundMat.specularColor = Color3.Black();

    this.wallMat = new StandardMaterial("wallMat", scene);
    this.wallMat.diffuseColor = new Color3(0.5, 0.48, 0.56);
    this.wallMat.specularColor = Color3.Black();
  }

  /** Сменить мир (новый этап): выгружает все чанки */
  setTerrain(terrain: Terrain): void {
    this.unloadAll();
    this.terrain = terrain;
    this.lastCx = NaN;
    this.lastCz = NaN;
    this.pending.length = 0;
  }

  /**
   * Вызывать каждый кадр с позицией игрока. При смене чанка ставит недостающие в очередь
   * (ближние первыми) и выгружает дальние; строит не больше BUILDS_PER_FRAME за вызов.
   * immediate — построить всё сразу (старт игры).
   */
  update(px: number, pz: number, immediate = false): void {
    if (!this.terrain) return;
    const cx = Terrain.chunkOf(px);
    const cz = Terrain.chunkOf(pz);
    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;

      // Выгружаем дальние
      for (const [key, chunk] of this.loaded) {
        if (Math.abs(chunk.cx - cx) > UNLOAD_RADIUS || Math.abs(chunk.cz - cz) > UNLOAD_RADIUS) {
          this.unload(key, chunk);
        }
      }
      this.terrain.pruneChunks(cx, cz, UNLOAD_RADIUS + 1);

      // Очередь недостающих, ближние к игроку первыми
      this.pending.length = 0;
      for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
          if (!this.loaded.has(chunkKey(cx + dx, cz + dz))) this.pending.push({ cx: cx + dx, cz: cz + dz });
        }
      }
      this.pending.sort((a, b) => Math.hypot(a.cx - cx, a.cz - cz) - Math.hypot(b.cx - cx, b.cz - cz));
    }

    let budget = immediate ? Infinity : BUILDS_PER_FRAME;
    while (this.pending.length > 0 && budget-- > 0) {
      const { cx: bx, cz: bz } = this.pending.shift()!;
      const key = chunkKey(bx, bz);
      if (this.loaded.has(key)) continue;
      const chunk = buildChunkMeshes(this.scene, this.terrain, bx, bz, this.groundMat, this.wallMat);
      if (chunk.wallSource) this.shadows.addShadowCaster(chunk.wallSource);
      this.loaded.set(key, chunk);
    }
  }

  /** Является ли меш землёй какого-либо чанка (для пикинга прицела) */
  isGround(mesh: AbstractMesh): boolean {
    return mesh.metadata?.isGround === true;
  }

  private unload(key: number, chunk: ChunkMeshes): void {
    if (chunk.wallSource) this.shadows.removeShadowCaster(chunk.wallSource);
    chunk.dispose();
    this.loaded.delete(key);
  }

  private unloadAll(): void {
    for (const [key, chunk] of this.loaded) this.unload(key, chunk);
  }

  dispose(): void {
    this.unloadAll();
    this.groundMat.dispose();
    this.wallMat.dispose();
  }
}
