import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Scene } from "@babylonjs/core/scene";
import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";

// --- Небо и туман ---
const SKY_TURBIDITY = 6; // мутность атмосферы: больше — белёсый горизонт
const SKY_RAYLEIGH = 1.6; // голубизна
const SKY_LUMINANCE = 1.0;
const FOG_DENSITY = 0.014; // край загруженных чанков (~70 юнитов) должен тонуть в дымке
const FOG_COLOR = new Color3(0.74, 0.8, 0.9); // цвет дымки у горизонта — под небо

// --- Свет ---
const SUN_COLOR = new Color3(1.0, 0.94, 0.82);
const SUN_INTENSITY = 1.15;
const SKY_AMBIENT = new Color3(0.55, 0.65, 0.85); // рассеянный свет неба (сверху)
const GROUND_AMBIENT = new Color3(0.3, 0.27, 0.22); // отражённый от земли (снизу)
const AMBIENT_INTENSITY = 0.7; // теневые грани стен должны читаться, а не быть чёрными

// --- Тени ---
// 1024² на 64 юнита = 16 px/юнит — как было у 2048² на 90, но в 4 раза меньше пикселей карты.
// Тени дальше 32 юнитов от игрока не рисуются — там уже дымка и край экрана.
const SHADOW_MAP_SIZE = 1024;
const SHADOW_FRUSTUM = 64; // сторона квадрата вокруг игрока, в котором есть тени (юниты)

// --- Постобработка ---
const BLOOM_THRESHOLD = 0.8; // светятся только яркие эмиссивы: пули, ствол, элита
const BLOOM_WEIGHT = 0.35;
const EXPOSURE = 1.05;
const CONTRAST = 1.1;
const VIGNETTE_WEIGHT = 1.4;

export interface Lighting {
  sun: DirectionalLight;
  ambient: HemisphericLight;
}

/**
 * Дневное освещение: солнце (тени) + полусферический свет неба.
 * lightDir — куда светит солнце (единичный вектор вниз).
 */
export function setupLighting(scene: Scene, lightDir: Vector3): Lighting {
  const ambient = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  ambient.intensity = AMBIENT_INTENSITY;
  ambient.diffuse = SKY_AMBIENT;
  ambient.groundColor = GROUND_AMBIENT;
  ambient.specular = Color3.Black();

  const sun = new DirectionalLight("sun", lightDir.clone(), scene);
  sun.intensity = SUN_INTENSITY;
  sun.diffuse = SUN_COLOR;
  sun.specular = SUN_COLOR.scale(0.4);
  sun.autoCalcShadowZBounds = true;

  return { sun, ambient };
}

/**
 * Тени от солнца. PCF вместо размытых экспоненциальных: у ESM на призмах стен получалось
 * сплошное самозатенение (грани чёрные целиком), PCF с normalBias даёт чистые грани и мягкий край.
 * Ортокадр теней фиксированного размера вокруг игрока (свет каждый кадр ставится над ним),
 * иначе кадр растягивался на все загруженные чанки и разрешение падало.
 */
export function setupShadows(sun: DirectionalLight): ShadowGenerator {
  sun.shadowFrustumSize = SHADOW_FRUSTUM;
  const gen = new ShadowGenerator(SHADOW_MAP_SIZE, sun);
  gen.usePercentageCloserFiltering = true;
  gen.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  gen.bias = 0.0015;
  gen.normalBias = 0.03;
  gen.darkness = 0.15; // тень не абсолютно чёрная
  return gen;
}

/** Процедурное небо (SkyMaterial): солнце на небе там, откуда светит lightDir. Плюс дымка в цвет горизонта. */
export function setupSky(scene: Scene, lightDir: Vector3): void {
  const sky = new SkyMaterial("sky", scene);
  sky.backFaceCulling = false;
  sky.turbidity = SKY_TURBIDITY;
  sky.rayleigh = SKY_RAYLEIGH;
  sky.luminance = SKY_LUMINANCE;
  sky.mieCoefficient = 0.005;
  sky.mieDirectionalG = 0.8;
  sky.useSunPosition = true;
  sky.sunPosition = lightDir.scale(-100); // солнце — против направления света
  sky.fogEnabled = false;

  const box = CreateBox("skybox", { size: 1000 }, scene);
  box.material = sky;
  box.infiniteDistance = true; // всегда вокруг камеры
  box.isPickable = false;
  box.applyFog = false;
  box.receiveShadows = false;

  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = FOG_DENSITY;
  scene.fogColor = FOG_COLOR;
  scene.clearColor.set(FOG_COLOR.r, FOG_COLOR.g, FOG_COLOR.b, 1);
}

/** Постобработка: сглаживание, лёгкий bloom на эмиссивах, тонмаппинг ACES, виньетка */
export function setupPostFx(scene: Scene, camera: Camera): DefaultRenderingPipeline {
  const pipeline = new DefaultRenderingPipeline("postfx", true, scene, [camera]);
  pipeline.fxaaEnabled = true;

  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = BLOOM_THRESHOLD;
  pipeline.bloomWeight = BLOOM_WEIGHT;
  pipeline.bloomKernel = 48;
  pipeline.bloomScale = 0.5;

  pipeline.imageProcessingEnabled = true;
  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = EXPOSURE;
  ip.contrast = CONTRAST;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = VIGNETTE_WEIGHT;
  ip.vignetteColor.set(0.02, 0.02, 0.05, 0);

  return pipeline;
}
