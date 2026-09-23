import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { HeightFn } from "./player";
import type { BlockedFn } from "./crowd";
import {
  buildProceduralCharacter,
  CHARACTER_HEIGHT,
  loadCharacterTemplate,
  PLAYER_MODEL_URL,
  tintCharacter,
  type CharacterModel,
  type CharacterTemplate,
} from "./characterModel";
import { clamp, type MotionState } from "./motion";

/** Враг — та же модель, что игрок, но меньше */
export const ENEMY_SCALE = 0.75;
const ELITE_SCALE = 1.35; // относительно обычного (≈ рост игрока)
const HIT_RADIUS = 0.35; // радиус капсулы попаданий при масштабе 1 (модель уже 0.5-юнитовой капсулы)

const ATTACK_RANGE = 1.35; // горизонтальная дистанция удара от центра врага до центра игрока
const ATTACK_HEIGHT = 1.1; // разница высот ступней, при которой удар ещё достаёт (игрок на блоке — не достаёт)
const ATTACK_COOLDOWN = 1.1; // секунды между замахами
const ATTACK_WINDUP = 0.32; // замах: урон проходит в конце, если игрок всё ещё в зоне — можно отпрыгнуть
const LUNGE = 0.45; // выпад модели вперёд на ударе (доля роста)
const TURN_RATE = 9; // 1/с

// --- Толпа: чтобы не шли колонной ---
const SURROUND_DIST = 9; // ближе этого идём не по полю, а обходим игрока на свой угол
const FAN_ANGLE = 0.75; // рад: на сколько враг смещает точку подхода от прямой на игрока
const JITTER_BIAS = 0.35; // постоянный боковой снос вдоль маршрута (у каждого свой)
const JITTER_WANDER = 0.3; // и качающийся
const SPEED_SPREAD = 0.2; // ±20 % к скорости — толпа растягивается
const ANIM_DIST = 55; // дальше этого скелет не анимируем (экономия CPU)

// --- Реакция на урон ---
const HIT_FLASH_TIME = 0.18; // с, вспышка красным
const HIT_FLASH_COLOR = new Color3(1, 0.06, 0.03); // самосвечение на пике: насыщенный красный
const HIT_FLASH_ALBEDO = 0.25; // базовый цвет на пике гасится до этой доли — иначе выходит розово-белый, а не красный
const HIT_FLASH_GLOW: [number, number, number] = [1, 0.1, 0.05]; // ореол GlowLayer (metadata.glow)

/** Статы врага — растут с номером этапа */
export interface EnemyStats {
  hp: number;
  speed: number;
  damage: number;
  tint: Color3;
  /** Золото за убийство */
  gold: number;
  /** Элитный: крупнее и светится (подсветку включает Game через GlowLayer) */
  elite?: boolean;
  /** Дополнительный множитель размера поверх обычного/элитного (боссы) */
  scale?: number;
}

const ELITE_GLOW = new Color3(1, 0.18, 0.12);

/**
 * Дать материалу собственный объект цвета. При перекраске в материал кладут общий `tint` из статов,
 * а сеттеры Babylon (`expandToProperty`) игнорируют присваивание равного по значению цвета —
 * поэтому сначала подсовываем заведомо другой, затем копию.
 */
function ownColor(current: Color3, set: (c: Color3) => void): Color3 {
  const copy = current.clone();
  set(new Color3(copy.r + 1, copy.g, copy.b));
  return copy;
}

/** Итоговый масштаб модели врага: базовый × элитный × множитель босса */
function enemyScale(stats: EnemyStats): number {
  return ENEMY_SCALE * (stats.elite ? ELITE_SCALE : 1) * (stats.scale ?? 1);
}

let nextId = 1;

/**
 * Фабрика врагов: один раз грузит модель игрока как шаблон и клонирует её (свой скелет и риг
 * у каждого, меши склеены в один draw call). Пока шаблон грузится — процедурный человечек.
 */
export class EnemyFactory {
  private template: CharacterTemplate | null = null;
  /** Шаблон загружен (или не загрузился — тогда враги процедурные). До этого спавн лучше подождать. */
  ready = false;

  constructor(private scene: Scene) {
    loadCharacterTemplate(scene, PLAYER_MODEL_URL)
      .then((t) => {
        this.template = t;
        if (t) console.info("[enemy] шаблон врага загружен из", PLAYER_MODEL_URL);
      })
      .catch((err) => console.warn("[enemy] шаблон не загрузился, враги процедурные:", err))
      .finally(() => (this.ready = true));
  }

  create(pos: Vector3, stats: EnemyStats): Enemy {
    return new Enemy(this.scene, this.buildModel(stats), pos, stats);
  }

  private buildModel(stats: EnemyStats): CharacterModel {
    const scale = enemyScale(stats);
    // У боссов самосвечение слабее пропорционально размеру — иначе bloom заливает их в белый
    const emissive = stats.elite ? ELITE_GLOW.scale(0.5 / (stats.scale ?? 1)) : stats.tint.scale(0.12);
    let model: CharacterModel;
    if (this.template) {
      model = this.template.instantiate({ scale, tint: stats.tint, emissive, meshName: "enemy" });
    } else {
      model = buildProceduralCharacter(this.scene, { weapon: "none" });
      model.root.scaling.setAll(scale);
      tintCharacter(model, stats.tint, emissive);
      for (const m of model.meshes) m.name = "enemy";
    }
    for (const m of model.meshes) {
      m.isPickable = true;
      // Свечение элиты; у боссов приглушено пропорционально размеру, иначе bloom заливает их в белый столб
      if (stats.elite) m.metadata = { ...(m.metadata ?? {}), elite: true, glowMult: 1 / (stats.scale ?? 1) ** 2 };
    }
    return model;
  }
}

/** Преследователь: идёт к игроку, обходя стены, окружает и бьёт вблизи с замахом. */
export class Enemy {
  readonly id = nextId++;
  /** Центр капсулы: движение и поворот. Модель — дочерний узел. */
  readonly node: TransformNode;
  readonly model: CharacterModel;
  readonly elite: boolean;
  readonly gold: number;
  alive = true;

  private hp: number;
  private speed: number;
  private damage: number;
  private attackTimer = 0;
  private windup = 0;
  /** Замедление: множитель скорости, пока slowT > 0 */
  private slowMult = 1;
  private slowT = 0;
  /** Вспышка от урона: остаток времени и материалы с исходным самосвечением */
  private flashT = 0;
  private flashMats: { mat: StandardMaterial | PBRMaterial; base: Color3; albedo: Color3 }[] = [];
  /** Смещение центра капсулы над землёй (= половина роста) */
  private halfHeight: number;
  private scale: number;

  // Индивидуальность в толпе
  private sideBias: number;
  private wanderPhase: number;
  private wanderFreq: number;
  private fanSign: number;
  private time = 0;
  private motion: MotionState = {
    moving: false,
    speed: 0,
    strafe: 0,
    airborne: false,
    vy: 0,
    airTime: 0,
    land: 0,
    crouch: 0,
    yawRate: 0,
  };

  constructor(scene: Scene, model: CharacterModel, pos: Vector3, stats: EnemyStats) {
    this.hp = stats.hp;
    this.speed = stats.speed * (1 + SPEED_SPREAD * (Math.random() * 2 - 1));
    this.damage = stats.damage;
    this.gold = stats.gold;
    this.elite = stats.elite === true;
    this.scale = enemyScale(stats);
    this.halfHeight = (CHARACTER_HEIGHT / 2) * this.scale;

    this.sideBias = Math.random() * 2 - 1;
    this.wanderPhase = Math.random() * Math.PI * 2;
    this.wanderFreq = 0.5 + Math.random() * 0.8;
    this.fanSign = Math.random() < 0.5 ? -1 : 1;

    this.node = new TransformNode("enemyRoot", scene);
    this.node.position.copyFrom(pos);
    this.model = model;
    model.root.parent = this.node;
    model.root.position.set(0, -this.halfHeight, 0);

    // Материалы — свои у каждого врага (клонированы при перекраске), можно мигать ими без оглядки на соседей
    const seen = new Set<Material>();
    const collect = (mat: Material | null) => {
      if (!mat || seen.has(mat)) return;
      seen.add(mat);
      if (mat instanceof MultiMaterial) for (const s of mat.subMaterials) collect(s);
      else if (mat instanceof StandardMaterial) {
        mat.diffuseColor = ownColor(mat.diffuseColor, (c) => (mat.diffuseColor = c));
        mat.emissiveColor = ownColor(mat.emissiveColor, (c) => (mat.emissiveColor = c));
        this.flashMats.push({ mat, base: mat.emissiveColor.clone(), albedo: mat.diffuseColor.clone() });
      } else if (mat instanceof PBRMaterial) {
        mat.albedoColor = ownColor(mat.albedoColor, (c) => (mat.albedoColor = c));
        mat.emissiveColor = ownColor(mat.emissiveColor, (c) => (mat.emissiveColor = c));
        this.flashMats.push({ mat, base: mat.emissiveColor.clone(), albedo: mat.albedoColor.clone() });
      }
    };
    for (const m of model.meshes) collect(m.material);
  }

  /** Степень вспышки k ∈ [0,1]: самосвечение к красному, базовый цвет гасится, ореол через GlowLayer */
  private setFlash(k: number): void {
    for (const f of this.flashMats) {
      Color3.LerpToRef(f.base, HIT_FLASH_COLOR, k, f.mat.emissiveColor);
      const albedo = f.mat instanceof PBRMaterial ? f.mat.albedoColor : f.mat.diffuseColor;
      Color3.LerpToRef(f.albedo, f.albedo.scale(HIT_FLASH_ALBEDO), k, albedo);
    }
    if (this.elite) return; // элита светится своим цветом всегда
    for (const m of this.model.meshes) {
      if (k > 0) {
        m.metadata = { ...(m.metadata ?? {}), glow: [HIT_FLASH_GLOW[0] * k, HIT_FLASH_GLOW[1] * k, HIT_FLASH_GLOW[2] * k] };
      } else if (m.metadata?.glow) {
        delete m.metadata.glow;
      }
    }
  }

  /** Замедлить: скорость × mult на seconds (повторное — продлевает, множитель берётся сильнейший) */
  applySlow(mult: number, seconds: number): void {
    this.slowMult = this.slowT > 0 ? Math.min(this.slowMult, mult) : mult;
    this.slowT = Math.max(this.slowT, seconds);
  }

  /** Замедлен ли сейчас */
  get slowed(): boolean {
    return this.slowT > 0;
  }

  /** Вспышка красным: самосвечение материалов уходит к HIT_FLASH_COLOR и гаснет обратно */
  private updateFlash(dt: number): void {
    if (this.flashT <= 0) return;
    this.flashT = Math.max(0, this.flashT - dt);
    this.setFlash(this.flashT / HIT_FLASH_TIME);
  }

  /** Радиус капсулы (для попаданий) */
  get hitRadius(): number {
    return HIT_RADIUS * this.scale;
  }

  /** Высота ступней в мире (центр минус половина роста) */
  get feetY(): number {
    return this.node.position.y - this.halfHeight;
  }

  /** Половина длины оси капсулы (между центрами полусфер) */
  get hitHalfAxis(): number {
    return Math.max(0.05, this.halfHeight - this.hitRadius);
  }

  /** Поставить врага на землю в мировой точке (x, z) */
  placeAt(x: number, groundY: number, z: number): void {
    this.node.position.set(x, groundY + this.halfHeight, z);
  }

  /**
   * Преследование по flow field (обход стен), вблизи — обход игрока на свой угол (окружение).
   * Удар — с замахом: урон проходит в конце ATTACK_WINDUP, если игрок ещё в зоне по горизонтали
   * И по высоте (стоя на блоке, игрок недостижим). Возвращает урон за кадр.
   * blocked — стена ли в точке: проверяем передний край капсулы, при упоре скользим вдоль стены.
   */
  update(
    dt: number,
    playerPos: Vector3,
    getHeight: HeightFn,
    flowDir: { x: number; z: number } | null,
    blocked: BlockedFn,
  ): number {
    if (!this.alive) return 0;
    this.time += dt;
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.slowT = Math.max(0, this.slowT - dt);
    this.updateFlash(dt);

    const p = this.node.position;
    const dx = playerPos.x - p.x;
    const dz = playerPos.z - p.z;
    const dist = Math.hypot(dx, dz);
    // Высота ступней: игрок — центр капсулы минус 1, враг — минус halfHeight
    const feetDiff = Math.abs(playerPos.y - 1 - (p.y - this.halfHeight));
    const canReach = feetDiff <= ATTACK_HEIGHT;
    const inRange = dist <= ATTACK_RANGE + this.hitRadius;

    // Замах: урон в конце, если игрок не ушёл (в т. ч. не подпрыгнул)
    let dealt = 0;
    if (this.windup > 0) {
      this.windup -= dt;
      if (this.windup <= 0) {
        this.windup = 0;
        if (inRange && canReach) dealt = this.damage;
      }
    }

    const x0 = p.x;
    const z0 = p.z;
    let faceX = dx;
    let faceZ = dz;

    if (inRange && canReach) {
      if (this.attackTimer <= 0 && this.windup <= 0) {
        this.attackTimer = ATTACK_COOLDOWN;
        this.windup = ATTACK_WINDUP;
      }
    } else if (this.windup <= 0 && dist > 0.001) {
      let mx: number;
      let mz: number;
      if (dist < SURROUND_DIST || !flowDir) {
        // Подходим не по прямой, а со своего угла — вместе с расталкиванием получается кольцо
        const fan = dist < SURROUND_DIST ? FAN_ANGLE * this.fanSign * clamp((dist - ATTACK_RANGE) / SURROUND_DIST, 0, 1) : 0;
        const a = Math.atan2(dx, dz) + fan;
        mx = Math.sin(a);
        mz = Math.cos(a);
      } else {
        // По полю, но со своим боковым сносом: толпа не сливается в колонну
        const jitter = JITTER_BIAS * this.sideBias + JITTER_WANDER * Math.sin(this.time * this.wanderFreq + this.wanderPhase);
        mx = flowDir.x - flowDir.z * jitter;
        mz = flowDir.z + flowDir.x * jitter;
        const len = Math.hypot(mx, mz) || 1;
        mx /= len;
        mz /= len;
      }
      const step = this.speed * (this.slowT > 0 ? this.slowMult : 1) * dt;
      const r = this.hitRadius;
      const nx = p.x + mx * step;
      const nz = p.z + mz * step;
      if (!blocked(nx + mx * r, nz + mz * r)) {
        p.x = nx;
        p.z = nz;
      } else if (!blocked(nx + Math.sign(mx) * r, p.z)) {
        p.x = nx; // скользим вдоль стены по X
      } else if (!blocked(p.x, nz + Math.sign(mz) * r)) {
        p.z = nz; // ...или по Z
      }
      faceX = mx;
      faceZ = mz;
      // Вблизи смотрим на игрока, даже если обходим его
      if (dist < SURROUND_DIST * 0.5) {
        faceX = dx;
        faceZ = dz;
      }
    }
    p.y = getHeight(p.x, p.z) + this.halfHeight;

    // Плавный поворот по кратчайшей дуге
    if (faceX * faceX + faceZ * faceZ > 1e-6) {
      const target = Math.atan2(faceX, faceZ);
      let delta = target - this.node.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.node.rotation.y += delta * Math.min(1, dt * TURN_RATE);
    }

    // Анимация: по фактической скорости; вдалеке скелет не трогаем
    if (dist < ANIM_DIST) {
      const v = dt > 0 ? Math.hypot(p.x - x0, p.z - z0) / dt : 0;
      const m = this.motion;
      m.moving = v > 0.3;
      m.speed = v / this.scale; // фаза шага — в «единицах роста», иначе маленькие ноги семенят слишком редко
      // Выпад на ударе: модель уходит вперёд и возвращается
      const lunge = this.windup > 0 ? Math.sin((1 - this.windup / ATTACK_WINDUP) * Math.PI) : 0;
      this.model.root.position.z = lunge * LUNGE * this.scale;
      m.crouch = lunge * 0.35;
      this.model.update(dt, m);
    }

    return dealt;
  }

  /** Возвращает true, если враг убит */
  takeDamage(amount: number): boolean {
    this.hp -= amount;
    if (this.hp <= 0) {
      this.kill();
      return true;
    }
    // Вспышка сразу на пике — иначе при быстрой стрельбе кадр без подсветки не даст её заметить
    this.flashT = HIT_FLASH_TIME;
    this.setFlash(1);
    return false;
  }

  kill(): void {
    this.alive = false;
    this.model.dispose();
    this.node.dispose();
  }
}
