import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
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
}

const ELITE_GLOW = new Color3(1, 0.18, 0.12);

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
    const scale = ENEMY_SCALE * (stats.elite ? ELITE_SCALE : 1);
    const emissive = stats.elite ? ELITE_GLOW.scale(0.5) : stats.tint.scale(0.12);
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
      if (stats.elite) m.metadata = { ...(m.metadata ?? {}), elite: true };
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
    this.scale = ENEMY_SCALE * (this.elite ? ELITE_SCALE : 1);
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
      const step = this.speed * dt;
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
    return false;
  }

  kill(): void {
    this.alive = false;
    this.model.dispose();
    this.node.dispose();
  }
}
