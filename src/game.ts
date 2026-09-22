import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import "@babylonjs/core/Collisions/collisionCoordinator";
import "@babylonjs/core/Culling/ray";

import { Terrain } from "./terrain";
import { ChunkManager } from "./chunks";
import { Player } from "./player";
import { createPlayerModel, PLAYER_MODEL_URL, type CharacterModel, type HeldWeapon } from "./characterModel";
import { EnemyFactory, type Enemy, type EnemyStats } from "./enemy";
import { CrowdSeparator } from "./crowd";
import { GoldPool } from "./gold";
import { WeaponSystem, WEAPON_TIERS } from "./weapons";
import { Gun, Sword, type Weapon } from "./weapon";
import { ProjectilePool } from "./projectiles";
import { Input } from "./input";
import { FlowField } from "./flowField";
import { rollUpgrades } from "./upgrades";
import { ThirdPersonCamera } from "./thirdPersonCamera";
import { setupLighting, setupPostFx, setupShadows, setupSky } from "./environment";

const STAGE_DURATION = 30; // секунд на этап; по истечении — пауза и выбор улучшения
const MAX_ALIVE = 160; // предохранитель: каждый враг — свой скиннованный меш, толпа больше не бесплатна
const SPAWNS_PER_FRAME = 2; // клон модели стоит пару миллисекунд — толпу выпускаем порциями
const BOSS_STAGE_EVERY = 10; // каждый кратный этап — штурм
const BOSS_CROWD_MULT = 4; // толпа на штурме во столько раз больше
const ELITE_EVERY = 10; // каждый N-й враг штурмовой толпы — элитный
const ENEMY_SHADOWS = true; // тени от врагов (второй скиннованный проход на каждого)
const SPAWN_MIN_DIST = 26; // враги появляются за краем экрана...
const SPAWN_MAX_DIST = 42; // ...но в пределах загруженных чанков и окна flow field
const LEASH_DIST = 90; // враг, отставший дальше этого, переносится к игроку
const AIM_FALLBACK_DIST = 60; // если под прицелом ничего нет — стреляем «в горизонт» по камере
const HAND_GUN_COOLDOWN = 0.22; // базовый кулдаун пистолета в руке, с
const SWORD_COOLDOWN = 0.45; // базовый кулдаун удара мечом, с

/** Стартовое оружие на выбор */
const START_WEAPONS: { id: HeldWeapon; title: string; desc: string }[] = [
  { id: "gun", title: "Пистолет", desc: "Быстрые точные выстрелы на любую дистанцию. Ствол греется — разброс растёт при непрерывной стрельбе." },
  { id: "sword", title: "Меч", desc: "Взмах бьёт всех врагов в секторе перед собой, урон ×3. Опасно близко, зато толпа режется целиком." },
];

export class Game {
  private engine: Engine;
  private scene: Scene;
  private camera!: ThirdPersonCamera;
  private player!: Player;
  private enemies: Enemy[] = [];
  private enemyFactory: EnemyFactory;
  private crowd = new CrowdSeparator();
  private projectiles: ProjectilePool;
  private gold: GoldPool;
  private weapons: WeaponSystem;
  /** Оружие в руке (пистолет или меч) — с общими stats игрока; null до выбора на старте */
  private primary: Weapon | null = null;
  /** Очередь на спавн: статы врагов, которых выпустим в ближайшие кадры */
  private pendingSpawns: EnemyStats[] = [];
  private input = new Input();
  private dirLight: DirectionalLight;
  private shadows: ShadowGenerator;
  private glow: GlowLayer;
  private lightDir = new Vector3(0.35, -1, 0.25).normalize();

  // --- Состояние этапа ---
  private terrain!: Terrain;
  private flowField!: FlowField;
  private chunks: ChunkManager;
  private stage = 1;
  private stageTimer = STAGE_DURATION;
  private spawnTimer = 0;
  private choosing = false;
  private dead = false;

  private firing = false;
  private flashTimer: number | undefined;

  // --- DOM ---
  private hudHp = document.getElementById("hp")!;
  private hudEnemies = document.getElementById("enemies")!;
  private hudStage = document.getElementById("stage")!;
  private hudWave = document.getElementById("wave")!;
  private overlay = document.getElementById("overlay")!;
  private deathInfo = document.getElementById("deathInfo")!;
  private upgradeOverlay = document.getElementById("upgradeOverlay")!;
  private upgradeCards = document.getElementById("upgradeCards")!;
  private weaponOverlay = document.getElementById("weaponOverlay")!;
  private weaponCards = document.getElementById("weaponCards")!;
  private flash = document.getElementById("flash")!;
  private hudGold = document.getElementById("gold")!;
  private hudGoldFill = document.getElementById("goldFill")!;
  private hudGoldHint = document.getElementById("goldHint")!;
  private hudWeapons = document.getElementById("weapons")!;
  private crosshair = document.getElementById("crosshair")!;
  private lockHint = document.getElementById("lockHint")!;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.collisionsEnabled = true;

    // Камерой управляем вручную (без camera.attachControl), поэтому
    // подключаем ввод к сцене сами — иначе pointerX/pointerY и клики мертвы.
    this.scene.attachControl();

    // --- Небо, свет, тени ---
    setupSky(this.scene, this.lightDir);
    this.dirLight = setupLighting(this.scene, this.lightDir).sun;

    this.shadows = setupShadows(this.dirLight);

    // Свечение: элитные враги (metadata.elite) и золото (metadata.gold), остальные не светятся
    this.glow = new GlowLayer("glow", this.scene, { blurKernelSize: 48 });
    this.glow.intensity = 1.2;
    this.glow.customEmissiveColorSelector = (mesh, _subMesh, _material, result) => {
      if (mesh.metadata?.elite) result.set(1, 0.18, 0.12, 1);
      else if (mesh.metadata?.gold) result.set(1, 0.75, 0.2, 1);
      else result.set(0, 0, 0, 0);
    };

    this.projectiles = new ProjectilePool(this.scene);
    this.enemyFactory = new EnemyFactory(this.scene);
    this.gold = new GoldPool(this.scene);
    this.shadows.addShadowCaster(this.gold.shadowCaster);
    this.weapons = new WeaponSystem(this.scene, this.projectiles, (e) => this.onEnemyKilled(e));
    this.chunks = new ChunkManager(this.scene, this.shadows);

    // --- Мир и игрок; первый этап начнётся после выбора оружия ---
    this.initWorld();
    this.showWeaponSelect();

    // --- Камера от третьего лица: мышь вращает, колесо — дистанция ---
    this.camera = new ThirdPersonCamera(this.scene, canvas);
    this.camera.yaw = this.player.mesh.rotation.y;
    this.camera.update(1, this.player.cameraAnchor(), this.terrain);
    setupPostFx(this.scene, this.camera.camera);

    // --- Стрельба и захват курсора: нативные события, чтобы не зависеть от внутренностей движка ---
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.dead || this.choosing) return;
      // Первый клик по полю захватывает курсор; стреляем только с захваченным курсором
      if (!this.camera.locked) this.camera.lock();
      else this.firing = true;
    });
    window.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.firing = false;
    });
    window.addEventListener("blur", () => (this.firing = false));
    document.addEventListener("pointerlockchange", () => {
      const locked = this.camera.locked;
      this.crosshair.style.display = locked ? "block" : "none";
      this.lockHint.style.display = locked || this.dead || this.choosing ? "none" : "block";
      if (!locked) this.firing = false;
    });

    window.addEventListener("keydown", (e) => {
      if (this.dead && e.code === "KeyR") location.reload();
    });
  }

  start(): void {
    this.scene.onBeforeRenderObservable.add(() => this.update());
    this.engine.runRenderLoop(() => this.scene.render());
  }

  resize(): void {
    this.engine.resize();
  }

  // ---------- Мир ----------

  /** Создаёт бесконечный мир и игрока. Вызывается один раз: мир между этапами не меняется. */
  private initWorld(): void {
    this.terrain = new Terrain();
    this.chunks.setTerrain(this.terrain);

    const spawnH = this.terrain.getHeight(this.terrain.spawn.x, this.terrain.spawn.z);
    this.player = new Player(
      this.scene,
      new Vector3(this.terrain.spawn.x, spawnH + 1, this.terrain.spawn.z),
    );
    this.chunks.update(this.player.position.x, this.player.position.z, true); // старт: всё сразу

    this.flowField = new FlowField(this.terrain);
    this.flowField.recompute(this.player.position.x, this.player.position.z);
  }

  /** Стартовый экран: выбор оружия. Игра стоит, пока не выбрано */
  private showWeaponSelect(): void {
    this.choosing = true;
    this.lockHint.style.display = "none";
    this.weaponCards.innerHTML = "";
    for (const w of START_WEAPONS) {
      const card = document.createElement("button");
      card.className = "card";
      card.innerHTML = `<h3>${w.title}</h3><p>${w.desc}</p>`;
      card.onclick = () => this.pickWeapon(w.id);
      this.weaponCards.appendChild(card);
    }
    this.weaponOverlay.style.display = "flex";
  }

  /** Выбрано стартовое оружие: модель с ним в руке, экземпляр Weapon на общих stats, первый этап */
  private pickWeapon(kind: HeldWeapon): void {
    this.primary =
      kind === "sword"
        ? new Sword(this.scene, this.player.weaponStats, SWORD_COOLDOWN, {
            enemies: () => this.enemies,
            origin: () => this.player.position,
            yaw: () => this.player.mesh.rotation.y,
            onHit: (e, dmg, point) => this.weapons.onWeaponHit(e, dmg, point, this.enemies),
            onKill: (e) => this.onEnemyKilled(e),
          })
        : new Gun(this.projectiles, this.player.weaponStats, { baseCooldown: HAND_GUN_COOLDOWN });

    // Модель: сразу процедурная; если есть /models/player.glb — подменится, когда загрузится
    const setModel = (model: CharacterModel) => {
      if (this.player.model) {
        for (const m of this.player.model.meshes) this.shadows.removeShadowCaster(m);
      }
      this.player.attachModel(model);
      for (const m of model.meshes) this.shadows.addShadowCaster(m);
    };
    setModel(createPlayerModel(this.scene, PLAYER_MODEL_URL, setModel, undefined, kind));

    this.weaponOverlay.style.display = "none";
    this.choosing = false;
    this.lockHint.style.display = "block";
    this.beginStage();
  }

  // ---------- Этапы и спавн ----------

  /** Штурмовой этап: каждый кратный BOSS_STAGE_EVERY */
  private isBossStage(): boolean {
    return this.stage % BOSS_STAGE_EVERY === 0;
  }

  /** Размер толпы, которая приходит в начале этапа (на штурме — в BOSS_CROWD_MULT раз больше) */
  private crowdSize(): number {
    const base = 10 + 4 * (this.stage - 1);
    return this.isBossStage() ? base * BOSS_CROWD_MULT : base;
  }

  /** Интервал постоянного спавна (секунды): с каждым этапом враги идут чаще */
  private spawnInterval(): number {
    return Math.max(0.35, 1.6 * Math.pow(0.9, this.stage - 1));
  }

  /** Статы новых врагов — растут с номером этапа */
  private enemyStats(): EnemyStats {
    const t = Math.min(1, (this.stage - 1) / 8);
    return {
      hp: 3 + Math.round(1.5 * (this.stage - 1)),
      speed: Math.min(4.2 + 0.3 * (this.stage - 1), 8),
      damage: 8 + 2 * (this.stage - 1),
      tint: Color3.Lerp(new Color3(0.85, 0.22, 0.18), new Color3(0.5, 0.12, 0.7), t),
      gold: 2 + Math.floor(this.stage / 2),
    };
  }

  /** Элитный враг: заметно крепче и злее обычного на этом этапе */
  private eliteStats(): EnemyStats {
    const base = this.enemyStats();
    return {
      hp: base.hp * 6,
      speed: base.speed * 1.1,
      damage: base.damage * 2,
      tint: new Color3(0.7, 0.08, 0.1),
      gold: 12 + 2 * this.stage,
      elite: true,
    };
  }

  /**
   * Начало этапа (бесшовно: мир и позиция игрока не меняются).
   * Новые враги уже усилены под текущий этап, и сразу приходит толпа.
   */
  private beginStage(): void {
    this.stageTimer = STAGE_DURATION;
    this.spawnTimer = this.spawnInterval();
    if (this.isBossStage()) {
      // Штурм: толпа в разы больше, каждый ELITE_EVERY-й — элитный
      this.spawnEnemies(this.crowdSize(), (i) => (i + 1) % ELITE_EVERY === 0);
      this.showFlash(`Этап ${this.stage} — ШТУРМ!`);
    } else {
      this.spawnEnemies(this.crowdSize());
      this.showFlash(`Этап ${this.stage}`);
    }
  }

  /** Случайная открытая и достижимая точка за краем экрана */
  private pickSpawnPoint(): { x: number; z: number } {
    const from = { x: this.player.position.x, z: this.player.position.z };
    let pos = this.terrain.randomOpenPoint(from, SPAWN_MIN_DIST, SPAWN_MAX_DIST);
    for (let t = 0; t < 10 && !this.flowField.isReachable(pos.x, pos.z); t++) {
      pos = this.terrain.randomOpenPoint(from, SPAWN_MIN_DIST, SPAWN_MAX_DIST);
    }
    return pos;
  }

  /**
   * Спавн count врагов с текущими статами этапа (с учётом лимита живых).
   * isElite(i) — сделать ли i-го врага элитным.
   */
  private spawnEnemies(count: number, isElite?: (index: number) => boolean): void {
    const alive = this.enemies.length + this.pendingSpawns.length;
    const n = Math.min(count, MAX_ALIVE - alive);
    if (n <= 0) return;

    const normal = this.enemyStats();
    const elite = isElite ? this.eliteStats() : null;
    for (let i = 0; i < n; i++) this.pendingSpawns.push(elite && isElite!(i) ? elite : normal);
  }

  /** Выпустить из очереди несколько врагов (клон модели не бесплатен — размазываем по кадрам) */
  private flushSpawns(): void {
    if (!this.enemyFactory.ready) return; // первые кадры: ждём шаблон, иначе первая толпа выйдет процедурной
    for (let k = 0; k < SPAWNS_PER_FRAME && this.pendingSpawns.length > 0; k++) {
      const stats = this.pendingSpawns.shift()!;
      const pos = this.pickSpawnPoint();
      const h = this.terrain.getHeight(pos.x, pos.z);
      const enemy = this.enemyFactory.create(new Vector3(pos.x, h, pos.z), stats);
      enemy.placeAt(pos.x, h, pos.z);
      if (ENEMY_SHADOWS) for (const m of enemy.model.meshes) this.shadows.addShadowCaster(m);
      this.enemies.push(enemy);
    }
  }

  /** Постоянный спавн: по одному врагу через spawnInterval() */
  private tickSpawner(dt: number): void {
    this.spawnTimer -= dt;
    while (this.spawnTimer <= 0) {
      this.spawnTimer += this.spawnInterval();
      this.spawnEnemies(1);
    }
    this.flushSpawns();
  }

  /** Отставших врагов переносим к игроку, чтобы толпа не терялась в бесконечном мире */
  private leashEnemies(): void {
    const p = this.player.position;
    for (const enemy of this.enemies) {
      const dx = enemy.node.position.x - p.x;
      const dz = enemy.node.position.z - p.z;
      if (dx * dx + dz * dz < LEASH_DIST * LEASH_DIST) continue;
      const pos = this.pickSpawnPoint();
      enemy.placeAt(pos.x, this.terrain.getHeight(pos.x, pos.z), pos.z);
    }
  }

  /** Убитый враг: золото выпадает на землю */
  private onEnemyKilled(enemy: Enemy): void {
    const p = enemy.node.position;
    this.gold.spawn(p, enemy.gold, this.terrain.floorAt(p.x, p.z));
  }

  /** Конец этапа: пауза и выбор улучшения; после выбора игра продолжается с того же места */
  private onStageEnd(): void {
    this.choosing = true;
    this.firing = false;
    this.camera.unlock();
    this.lockHint.style.display = "none";
    this.upgradeCards.innerHTML = "";

    for (const up of rollUpgrades(3)) {
      const card = document.createElement("button");
      card.className = "card";
      card.innerHTML = `<h3>${up.title}</h3><p>${up.desc}</p>`;
      card.onclick = () => {
        up.apply(this.player);
        this.upgradeOverlay.style.display = "none";
        this.choosing = false;
        this.input.takePress("Space"); // пробел, нажатый в меню, не должен стать прыжком
        this.lockHint.style.display = "block";
        this.stage++;
        this.beginStage();
      };
      this.upgradeCards.appendChild(card);
    }
    this.upgradeOverlay.style.display = "flex";
  }

  // ---------- Игровой цикл ----------

  private update(): void {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    const getHeight = (x: number, z: number) => this.terrain.getHeight(x, z);

    // Камера сначала — чтобы прицел по центру экрана считался по текущему положению мыши...
    this.camera.update(dt, this.player.cameraAnchor(), this.terrain);
    if (!this.dead && !this.choosing) this.simulate(dt, getHeight);
    // ...и после — чтобы догнать игрока, сдвинувшегося за кадр
    this.camera.update(dt, this.player.cameraAnchor(), this.terrain);
    this.dirLight.position = this.player.position.subtract(this.lightDir.scale(40));
    this.dirLight.setDirectionToTarget(this.player.position);

    // HUD
    this.hudHp.textContent = `${Math.ceil(this.player.hp)}/${this.player.maxHp}`;
    this.hudEnemies.textContent = String(this.enemies.length);
    this.hudStage.textContent = String(this.stage);
    const s = Math.max(0, Math.ceil(this.stageTimer));
    this.hudWave.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    this.updateGoldHud();
  }

  /** Полоска золота ведёт к следующему улучшению оружия; при полной — подсказка о покупке */
  private updateGoldHud(): void {
    const gold = this.player.gold;
    const next = this.weapons.next;
    const owned = WEAPON_TIERS.slice(0, this.weapons.tier).map((t) => t.title);
    this.hudWeapons.textContent = owned.length ? `Оружие: ${owned.join(", ")}` : "";
    if (!next) {
      this.hudGold.textContent = `${gold}`;
      this.hudGoldFill.style.width = "100%";
      this.hudGoldHint.style.display = "none";
      return;
    }
    this.hudGold.textContent = `${gold}/${next.cost}`;
    this.hudGoldFill.style.width = `${Math.min(100, (gold / next.cost) * 100).toFixed(1)}%`;
    const ready = gold >= next.cost;
    this.hudGoldHint.textContent = ready ? `B — купить «${next.title}»: ${next.desc}` : `Следующее: ${next.title} — ${next.desc}`;
    this.hudGoldHint.style.opacity = ready ? "1" : "0.6";
    this.hudGoldHint.style.display = "block";
  }

  /** Один шаг игровой логики (не вызывается на паузе и после смерти) */
  private simulate(dt: number, getHeight: (x: number, z: number) => number): void {
    // Таймер этапа: по истечении — пауза и выбор улучшения
    this.stageTimer -= dt;
    if (this.stageTimer <= 0) {
      this.stageTimer = 0;
      this.onStageEnd();
      return;
    }

    // Движение относительно камеры: W — от камеры, D — вправо от неё
    const axis = this.input.moveAxis();
    const moving = axis.x !== 0 || axis.z !== 0;
    const moveDir = moving ? this.camera.forward().scale(axis.z).addInPlace(this.camera.right().scale(axis.x)) : null;
    // Точка под перекрестием — каждый кадр, не только при стрельбе
    const aimPoint = this.pickAimPoint();
    // Оружие всегда наготове: корпус смотрит на точку прицела (камера через плечо смещена,
    // поэтому это не азимут камеры), движение вбок/назад — стрейф
    const faceYaw = aimPoint
      ? Math.atan2(aimPoint.x - this.player.position.x, aimPoint.z - this.player.position.z)
      : this.camera.yaw;
    // Игрок ходит по рельефу и по верху стен
    this.player.update(dt, moveDir, faceYaw, (x, z) => this.terrain.floorAt(x, z), {
      jump: this.input.takePress("Space"),
      jumpHeld: this.input.isDown("Space"),
      crouch: this.input.isDown("ControlLeft") || this.input.isDown("ControlRight") || this.input.isDown("KeyC"),
    });
    // Подгружаем чанки вокруг новой позиции игрока
    this.chunks.update(this.player.position.x, this.player.position.z);
    if (aimPoint) this.player.aim(aimPoint);
    const primary = this.primary!;
    primary.update(dt);
    if (this.firing && aimPoint) {
      // Пистолет: пуля из дула в точку под перекрестием. Меч: серия взмахов по сектору перед корпусом
      primary.tryFire(this.player.muzzle(), aimPoint);
    }
    this.player.swing(primary.swingAngle);

    // Маршруты пересчитываются, когда игрок сменил клетку
    this.flowField.recompute(this.player.position.x, this.player.position.z);

    // Постоянный спавн и подтягивание отставших
    this.tickSpawner(dt);
    this.leashEnemies();

    // Стены для врагов — hex-клетки: O(1) на проверку вместо перебора всех коллайдеров сцены
    const blocked = (x: number, z: number) => this.terrain.isWallAt(x, z);
    let damage = 0;
    for (const enemy of this.enemies) {
      const dir = this.flowField.getDirection(enemy.node.position.x, enemy.node.position.z);
      const d = enemy.update(dt, this.player.position, getHeight, dir, blocked);
      if (d > 0) damage += this.weapons.incomingDamage(enemy, d, this.player); // Radiance: часть ударов почти безвредна
    }
    this.crowd.separate(this.enemies, this.player.position.x, this.player.position.z, blocked);
    if (damage > 0) {
      this.player.takeDamage(damage);
      if (this.player.hp <= 0) this.die();
    }

    // Улучшения оружия: летающий пистолет стреляет сам, Radiance жжёт вокруг
    this.weapons.update(dt, this.player, this.enemies);
    this.projectiles.update(
      dt,
      this.enemies,
      this.terrain,
      (e) => this.onEnemyKilled(e),
      (e, dmg, point) => this.weapons.onWeaponHit(e, dmg, point, this.enemies),
    );
    // Перекрестие расходится с нагревом ствола (у меча нагрева нет)
    this.crosshair.style.transform = `scale(${(1 + primary.heatLevel * 0.8).toFixed(3)})`;

    // Золото: физика монет и подбор; B — купить следующее улучшение оружия
    this.player.gold += this.gold.update(dt, this.player.position, (x, z) => this.terrain.floorAt(x, z));
    if (this.input.takePress("KeyB")) {
      const bought = this.weapons.buy(this.player);
      if (bought) {
        for (const m of this.weapons.shadowCasters) this.shadows.addShadowCaster(m);
        this.showFlash(`Куплено: ${bought.title}`);
      }
    }

    // Убитых из списка убираем сразу — иначе массив растёт бесконечно
    if (this.enemies.some((e) => !e.alive)) {
      this.enemies = this.enemies.filter((e) => e.alive);
    }
  }

  /**
   * Точка прицеливания — что под перекрестием в центре экрана: враг, стена или земля.
   * Если там небо — точка далеко по горизонтальному направлению камеры.
   */
  private pickAimPoint(): Vector3 | null {
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const pick = this.scene.pick(
      w / 2,
      h / 2,
      (m) => m.name === "enemy" || m.name.startsWith("wall_") || this.chunks.isGround(m),
      false,
      this.camera.camera,
    );
    if (pick?.pickedPoint) {
      // Цель слишком близко к игроку (камера смотрит сквозь него) — стреляем по камере
      const dx = pick.pickedPoint.x - this.player.position.x;
      const dz = pick.pickedPoint.z - this.player.position.z;
      if (dx * dx + dz * dz > 1) return pick.pickedPoint;
    }
    return this.player.position.add(this.camera.forward().scale(AIM_FALLBACK_DIST));
  }

  private showFlash(text: string): void {
    this.flash.textContent = text;
    this.flash.style.opacity = "1";
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => (this.flash.style.opacity = "0"), 1600);
  }

  private die(): void {
    this.dead = true;
    this.firing = false;
    this.camera.unlock();
    this.lockHint.style.display = "none";
    this.deathInfo.textContent = `Этап ${this.stage}. Нажмите R, чтобы начать новый забег`;
    this.overlay.style.display = "flex";
  }
}
