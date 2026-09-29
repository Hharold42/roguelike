import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Процедурные пиксельные текстуры 64×64 — как в 93-м, только без ассетов.
 * Рисуются попиксельно в ImageData, сэмплирование NEAREST, без мипмапов:
 * пиксели читаются на любой дистанции (лёгкое мерцание вдали — часть эстетики).
 */

const SIZE = 64;

/** Детерминированный ГПСЧ, чтобы бетон был одинаковым от сессии к сессии */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Панельный бетон: холодный серый, крупнозернистый шум, швы панелей, потёки */
export function makeConcreteTexture(scene: Scene): Texture {
  const rand = mulberry32(1337);
  const img = new ImageData(SIZE, SIZE);
  const d = img.data;

  // Потёки: несколько вертикальных полос с затуханием вниз от случайной высоты
  const streaks: { x: number; y0: number; len: number; dark: number }[] = [];
  for (let i = 0; i < 5; i++) {
    streaks.push({
      x: Math.floor(rand() * SIZE),
      y0: Math.floor(rand() * SIZE * 0.5),
      len: 12 + rand() * 30,
      dark: 0.82 + rand() * 0.1,
    });
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // база + зерно
      let v = 0.62 + (rand() - 0.5) * 0.14;

      // швы панелей каждые 16 px: тёмная линия и светлый кант под ней (объём)
      if (x % 16 === 0 || y % 16 === 0) v *= 0.68;
      else if (x % 16 === 1 || y % 16 === 1) v *= 1.08;

      // потёки
      for (const s of streaks) {
        if (x === s.x && y >= s.y0 && y < s.y0 + s.len) {
          const fade = 1 - (y - s.y0) / s.len;
          v *= 1 - (1 - s.dark) * fade;
        }
      }

      // холодный серый с лёгким тёплым уклоном (пыль)
      const i = (y * SIZE + x) * 4;
      d[i] = Math.min(255, v * 255 * 1.0);
      d[i + 1] = Math.min(255, v * 255 * 0.97);
      d[i + 2] = Math.min(255, v * 255 * 1.05);
      d[i + 3] = 255;
    }
  }

  const tex = new DynamicTexture("concrete", { width: SIZE, height: SIZE }, scene, false);
  tex.getContext().putImageData(img, 0, 0);
  tex.update();
  tex.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}
