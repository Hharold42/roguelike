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
import { WEAPONS, WeaponSystem, type WeaponDef, type WeaponId } from "./weapons";
import { Gun, Sword, type Weapon } from "./weapon";
import {
  AEGIS_RECHARGE,
  COOLING_TIME,
  RAGE_MAX,
  RAGE_STACK,
  RAGE_TIME,
  SHOP_ITEMS,
  VIAL_GOLD_MULT,
  defaultPerks,
  purchasableItems,
  type ItemHost,
  type ShopItem,
} from "./shopItems";
import { craft, type CraftHost, type Ingredient, type Recipe } from "./recipes";
import { Shop, type ShopActions } from "./shop";
import { FortuneWheel, type WheelSlot } from "./wheel";
import { ProjectilePool } from "./projectiles";
import { Input } from "./input";
import { FlowField } from "./flowField";
import { rollUpgrades, UPGRADE_POOL } from "./upgrades";
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
const SPIN_BASE = 50; // цена первого вращения колеса фортуны
const SPIN_STEP = 50; // каждое следующее дороже на столько
/** Цвета секторов колеса: оружия — тёплые, предметы — холодные (чередуются) */
const WEAPON_COLORS = ["#c9832a", "#b8652f", "#a8503a"];
const ITEM_COLORS = ["#2f7fb8", "#2f9c96", "#4a6fb8"];
// Утешительное колесо (пустой сектор основного): обычные улучшения, с шансом BOSS_CHANCE — толпа боссов
const UPGRADE_COLORS = ["#3f9a5a", "#4a8f7a", "#5b9a4a"];
const BOSS_CHANCE = 0.02;
const BOSS_COUNT = 10;
const BOSS_SCALE = 2.2; // поверх элитного размера (≈ 2.2 роста игрока)
const BOSS_HP_MULT = 25; // от обычного врага этапа
const BOSS_DAMAGE_MULT = 3;
const COUPON_CHANCE = 0.03; // шанс купона колеса с обычного врага
const COUPON_CHANCE_ELITE = 0.2; // с элитного/босса
// Магазин
const STOCK_ITEMS = 3; // предметов в ассортименте на этап (+1 оружие)
const COUPON_DISCOUNT = 0.5; // купон в магазине — полцены на одну покупку
const SECOND_WIND_HP = 0.5; // доля HP при «Втором дыхании»
const BULLET_BLAST_MULT = 0.5; // урон взрыва пули (гранатомёт) от урона пули

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

  // --- Колесо фортуны ---
  private wheel = new FortuneWheel();
  /** Утешительное колесо поверх основного: без пустых секторов, крутится само один раз */
  private bonusWheel = new FortuneWheel({ prefix: "bonus", empties: false, autoSpin: true });
  private bonusSpun = false;
  private spinPrice = SPIN_BASE;
  private freeSpins = 0;
  /** Временные бафы предметов: через left секунд вызываем undo; name — для HUD */
  private timedBuffs: { name: string; left: number; undo: () => void }[] = [];
  /** Стартовое оружие (для HUD) */
  private primaryKind: HeldWeapon = "gun";
  private statsHtml = "";

  // --- Магазин, крафт, перки ---
  private shop = new Shop(this.wheel);
  /** Постоянные перки из предметов (ярость, шипы, броня, модификаторы колеса…) */
  private perks = defaultPerks(SPIN_STEP);
  /** Инвентарь для рецептов: сколько раз применён каждый баф / куплен каждый предмет с undo */
  private upgradeCounts = new Map<string, number>();
  private itemCounts = new Map<string, number>();
  /** Ассортимент магазина на этап: id предметов + одно оружие */
  private stock: { items: string[]; weapon: WeaponId | null } = { items: [], weapon: null };
  /** Купон включён — следующая покупка за полцены */
  private couponMode = false;
  private rageStacks = 0;
  private rageTimer = 0;
  private aegisTimer = 0;

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
  private hudStats = document.getElementById("statsHud")!;
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
      const glow = mesh.metadata?.glow as [number, number, number] | undefined;
      if (mesh.metadata?.elite) {
        const k = (mesh.metadata.glowMult as number | undefined) ?? 1;
        result.set(k, 0.18 * k, 0.12 * k, 1);
      }
      else if (mesh.metadata?.gold) result.set(1, 0.75, 0.2, 1);
      else if (glow) result.set(glow[0], glow[1], glow[2], 1); // снаряды и клинки автоматических оружий
      else result.set(0, 0, 0, 0);
    };

    this.projectiles = new ProjectilePool(this.scene);
    this.enemyFactory = new EnemyFactory(this.scene);
    this.gold = new GoldPool(this.scene);
    this.shadows.addShadowCaster(this.gold.shadowCaster);
    this.weapons = new WeaponSystem(
      this.scene,
      this.projectiles,
      (e) => this.onEnemyKilled(e),
      (x, z) => this.terrain.floorAt(x, z),
    );
    this.chunks = new ChunkManager(this.scene, this.shadows);

    // --- Мир и игрок; первый этап начнётся после выбора оружия ---
    this.initWorld();
    this.projectiles.stats = this.player.weaponStats; // крит, пробитие, рикошет пуль — из общих stats
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
    this.primaryKind = kind;
    this.primary =
      kind === "sword"
        ? new Sword(this.scene, this.player.weaponStats, SWORD_COOLDOWN, {
            enemies: () => this.enemies,
            origin: () => this.player.position,
            yaw: () => this.player.mesh.rotation.y,
            floorAt: (x, z) => this.terrain.floorAt(x, z),
            onHit: (e, dmg, point, force) => this.weapons.onWeaponHit(e, dmg, point, this.enemies, force),
            onKill: (e) => this.onEnemyKilled(e),
            dash: (dist) => this.dashPlayer(dist),
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
    this.rollStock();
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

  /**
   * Убитый враг: золото выпадает на землю (с бонусом «Жадности» и множителем «Кошелька»),
   * с небольшим шансом — купон колеса; перки на убийство (вампиризм, ярость, охлаждение).
   */
  private onEnemyKilled(enemy: Enemy): void {
    const p = enemy.node.position;
    const floor = this.terrain.floorAt(p.x, p.z);
    this.gold.spawn(p, Math.round((enemy.gold + this.player.goldBonus) * this.perks.goldMult), floor);
    if (Math.random() < (enemy.elite ? COUPON_CHANCE_ELITE : COUPON_CHANCE)) this.gold.spawnCoupon(p, floor);

    const pk = this.perks;
    if (pk.vampirism > 0) this.player.hp = Math.min(this.player.maxHp, this.player.hp + pk.vampirism);
    if (pk.rage) {
      this.rageStacks = Math.min(RAGE_MAX, this.rageStacks + 1);
      this.rageTimer = RAGE_TIME;
    }
    if (pk.cooling && this.primary instanceof Gun) this.primary.suppressHeat(COOLING_TIME);
  }

  // ---------- Колесо фортуны ----------

  /** Призы на колесе: невыигранные оружия (вес × «Весы») + предметы колеса */
  private wheelSlots(): WheelSlot[] {
    const weapons = this.weapons.available.map<WheelSlot>((w, i) => ({
      id: `w:${w.id}`,
      title: w.title,
      desc: w.desc,
      weight: w.weight * this.perks.weaponWeightMult,
      color: WEAPON_COLORS[i % WEAPON_COLORS.length],
    }));
    const items = SHOP_ITEMS.filter((it) => it.weight > 0).map<WheelSlot>((it, i) => ({
      id: `i:${it.id}`,
      title: it.title,
      desc: it.desc,
      weight: it.weight,
      color: ITEM_COLORS[i % ITEM_COLORS.length],
    }));
    // Чередуем, чтобы редкие оружия не сбивались в одну дугу
    const out: WheelSlot[] = [];
    for (let i = 0; i < Math.max(weapons.length, items.length); i++) {
      if (i < items.length) out.push(items[i]);
      if (i < weapons.length) out.push(weapons[i]);
    }
    return out;
  }

  /** Открыть экран B (колесо / магазин / крафт): игра на паузе, курсор свободен */
  private openWheel(): void {
    this.choosing = true;
    this.firing = false;
    this.camera.unlock();
    this.lockHint.style.display = "none";
    this.wheel.emptyShare = this.perks.emptyShare;
    this.wheel.open(this.wheelSlots(), {
      state: () => ({ price: this.spinPrice, gold: this.player.gold, free: this.freeSpins > 0 }),
      pay: () => {
        if (this.freeSpins > 0) this.freeSpins--;
        else if (this.player.gold >= this.spinPrice) this.player.gold -= this.spinPrice;
        else return false;
        this.spinPrice += this.perks.spinStep;
        this.updateGoldHud();
        this.shop.render();
        return true;
      },
      result: (slot) => this.onWheelResult(slot),
      close: () => {
        this.shop.close();
        this.choosing = false;
        this.lockHint.style.display = "block";
        this.input.takePress("Space");
        this.input.takePress("KeyB");
      },
    });
    this.shop.open(this.shopActions);
  }

  /** Выпавший приз: оружие или предмет; пустой сектор — утешительное колесо */
  private onWheelResult(slot: WheelSlot | null): void {
    if (!slot) {
      // «Счастливая монета» сгорает при первом пусто
      if (this.perks.emptyShare < 0.5) this.perks.emptyShare = 0.5;
      this.openBonusWheel();
    } else {
      const [kind, id] = slot.id.split(":");
      if (kind === "w") this.grantWeapon(id as WeaponId);
      else {
        const item = SHOP_ITEMS.find((it) => it.id === id);
        if (item) this.applyItem(item);
      }
    }
    // «Весы» действуют одно вращение; набор мог измениться (оружие ушло, доля пустых вернулась)
    this.perks.weaponWeightMult = 1;
    this.wheel.emptyShare = this.perks.emptyShare;
    this.wheel.setSlots(this.wheelSlots());
    this.updateGoldHud();
    this.shop.render();
  }

  /**
   * Призы утешительного колеса: все обычные улучшения поровну и «10 боссов» с шансом BOSS_CHANCE
   * (или шансом «Пробирки»). Вес боссов подобран так, чтобы доля среди всех призов была ровно этим шансом.
   */
  private bonusSlots(): WheelSlot[] {
    const w = 100;
    const chance = this.perks.bossChanceNext ?? BOSS_CHANCE;
    const bossWeight = (chance * UPGRADE_POOL.length * w) / (1 - chance);
    const slots = UPGRADE_POOL.map<WheelSlot>((up, i) => ({
      id: `u:${up.id}`,
      title: up.title,
      desc: up.desc,
      weight: w,
      color: UPGRADE_COLORS[i % UPGRADE_COLORS.length],
    }));
    // Боссов ставим в середину, чтобы красный сектор читался на колесе
    slots.splice(Math.floor(slots.length / 2), 0, {
      id: "boss",
      title: `${BOSS_COUNT} БОССОВ`,
      desc: `Десять огромных красных врагов: HP ×${BOSS_HP_MULT}, урон ×${BOSS_DAMAGE_MULT}. Много золота, если выживете`,
      weight: bossWeight,
      color: "#d0202a",
    });
    return slots;
  }

  /** Пустой сектор основного колеса: поверх него открывается утешительное и сразу крутится */
  private openBonusWheel(): void {
    this.bonusSpun = false;
    this.bonusWheel.open(this.bonusSlots(), {
      state: () => ({ price: 0, gold: this.player.gold, free: true }),
      pay: () => {
        if (this.bonusSpun) return false; // одно вращение за открытие
        this.bonusSpun = true;
        return true;
      },
      result: (slot) => this.onBonusResult(slot),
      close: () => {
        // Возвращаемся к основному колесу — оно всё ещё открыто под этим
        this.wheel.refreshUi();
        this.updateGoldHud();
      },
    });
  }

  private onBonusResult(slot: WheelSlot | null): void {
    // «Пробирка» — на одно утешительное колесо
    const vial = this.perks.bossChanceNext !== null;
    this.perks.bossChanceNext = null;
    if (!slot) return;
    if (slot.id === "boss") {
      this.spawnBosses(BOSS_COUNT, vial ? VIAL_GOLD_MULT : 1);
      this.showFlash(`${BOSS_COUNT} БОССОВ!`);
      return;
    }
    this.applyUpgrade(slot.id.slice(2));
  }

  /** Босс: огромный, ярко-красный, светится как элитный, очень крепкий */
  private bossStats(goldMult = 1): EnemyStats {
    const base = this.enemyStats();
    return {
      hp: base.hp * BOSS_HP_MULT,
      speed: base.speed * 0.9,
      damage: base.damage * BOSS_DAMAGE_MULT,
      tint: new Color3(0.8, 0.05, 0.04),
      gold: Math.round((40 + 5 * this.stage) * goldMult),
      elite: true,
      scale: BOSS_SCALE,
    };
  }

  /** Боссы идут в очередь спавна мимо лимита живых — они обязаны прийти все */
  private spawnBosses(count: number, goldMult = 1): void {
    const stats = this.bossStats(goldMult);
    for (let i = 0; i < count; i++) this.pendingSpawns.push(stats);
  }

  // ---------- Инвентарь, магазин, крафт ----------

  /** Применить улучшение (карточка этапа, утешительное колесо) с учётом в инвентаре */
  private applyUpgrade(id: string): void {
    const up = UPGRADE_POOL.find((u) => u.id === id);
    if (!up) return;
    up.apply(this.player);
    this.upgradeCounts.set(id, (this.upgradeCounts.get(id) ?? 0) + 1);
  }

  /** Применить предмет (колесо, магазин); предметы с undo — ингредиенты, считаем их */
  private applyItem(item: ShopItem): void {
    item.apply(this.itemHost);
    if (item.undo) this.itemCounts.set(item.id, (this.itemCounts.get(item.id) ?? 0) + 1);
  }

  private grantWeapon(id: WeaponId): boolean {
    if (!this.weapons.grant(id, this.player)) return false;
    this.refreshShadows();
    return true;
  }

  /** Меши автоматики, появившиеся после grant/крафта, должны отбрасывать тень */
  private refreshShadows(): void {
    for (const m of this.weapons.shadowCasters) this.shadows.addShadowCaster(m);
  }

  /** Потратить ингредиент рецепта: откатить баф/предмет, забрать оружие, списать купоны */
  private consume(ing: Ingredient): void {
    switch (ing.kind) {
      case "upgrade": {
        const up = UPGRADE_POOL.find((u) => u.id === ing.id)!;
        const n = ing.count ?? 1;
        for (let i = 0; i < n; i++) up.undo(this.player);
        this.upgradeCounts.set(ing.id, Math.max(0, (this.upgradeCounts.get(ing.id) ?? 0) - n));
        break;
      }
      case "item": {
        const item = SHOP_ITEMS.find((it) => it.id === ing.id)!;
        const n = ing.count ?? 1;
        for (let i = 0; i < n; i++) item.undo?.(this.itemHost);
        this.itemCounts.set(ing.id, Math.max(0, (this.itemCounts.get(ing.id) ?? 0) - n));
        break;
      }
      case "weapon":
        if (!ing.keep) this.weapons.revoke(ing.id);
        break;
      case "coupon":
        this.freeSpins = Math.max(0, this.freeSpins - ing.count);
        break;
      case "anyWeapon": {
        const last = this.weapons.owned[this.weapons.owned.length - 1];
        if (last) this.weapons.revoke(last);
        break;
      }
    }
  }

  /** Новый ассортимент магазина: STOCK_ITEMS случайных доступных предметов + одно невыигранное оружие */
  private rollStock(): void {
    const pool = purchasableItems(this.itemHost);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const weapons = this.weapons.available;
    this.stock = {
      items: pool.slice(0, STOCK_ITEMS).map((it) => it.id),
      weapon: weapons.length ? weapons[Math.floor(Math.random() * weapons.length)].id : null,
    };
  }

  /** Цена с учётом включённого купона */
  private shopPrice(base: number): number {
    return this.couponMode && this.freeSpins > 0 ? Math.round(base * COUPON_DISCOUNT) : base;
  }

  /** Списать цену покупки (купон тратится, если включён); false — не хватает золота */
  private pay(base: number): boolean {
    const price = this.shopPrice(base);
    if (this.player.gold < price) return false;
    this.player.gold -= price;
    if (price !== base) {
      this.freeSpins--;
      if (this.freeSpins === 0) this.couponMode = false;
    }
    this.updateGoldHud();
    return true;
  }

  /** Что магазину/крафту нужно от игры */
  private get shopActions(): ShopActions {
    const host = this.craftHost;
    const game = this;
    return {
      host,
      stock: () => ({
        // Уникальные предметы могли стать недоступны (куплены на другой вкладке / выпали на колесе)
        items: this.stock.items
          .map((id) => SHOP_ITEMS.find((it) => it.id === id)!)
          .filter((it) => !(it.once && it.owned?.(host))),
        weapon: this.stock.weapon && !this.weapons.has(this.stock.weapon) ? WEAPONS.find((w) => w.id === this.stock.weapon)! : null,
      }),
      get couponMode() {
        return game.couponMode && game.freeSpins > 0;
      },
      toggleCoupon: () => {
        this.couponMode = !this.couponMode && this.freeSpins > 0;
      },
      price: (base) => this.shopPrice(base),
      buyItem: (item) => {
        if (!this.pay(item.price)) return false;
        this.applyItem(item);
        this.stock.items = this.stock.items.filter((id) => id !== item.id);
        return true;
      },
      buyWeapon: (w) => {
        if (this.weapons.has(w.id) || !this.pay(w.price)) return false;
        this.grantWeapon(w.id);
        this.stock.weapon = null;
        this.wheel.setSlots(this.wheelSlots()); // оружие ушло и с колеса
        return true;
      },
      sellWeapon: (id) => {
        if (!this.weapons.revoke(id)) return;
        this.player.gold += this.weapons.sellPrice(id);
        this.wheel.setSlots(this.wheelSlots()); // вернулось на колесо
        this.updateGoldHud();
      },
      craft: (r) => this.craftRecipe(r),
    };
  }

  private craftRecipe(r: Recipe): boolean {
    if (!craft(this.craftHost, r)) return false;
    this.showFlash(r.title);
    this.wheel.setSlots(this.wheelSlots()); // оружие могло уйти в рецепт или появиться
    this.updateGoldHud();
    return true;
  }

  /** Что предметы магазина могут делать с игрой */
  private get itemHost(): ItemHost {
    return {
      player: this.player,
      perks: this.perks,
      primaryKind: this.primaryKind,
      gun: this.primary instanceof Gun ? this.primary : null,
      sword: this.primary instanceof Sword ? this.primary : null,
      killAround: (radius) => {
        const p = this.player.position;
        let n = 0;
        for (const e of this.enemies) {
          if (!e.alive || Vector3.DistanceSquared(e.node.position, p) > radius * radius) continue;
          e.takeDamage(1e9);
          this.onEnemyKilled(e);
          n++;
        }
        this.weapons.blast(new Vector3(p.x, p.y - 1, p.z), radius);
        this.enemies = this.enemies.filter((e) => e.alive);
        return n;
      },
      slowAround: (radius, mult, seconds) => {
        const p = this.player.position;
        for (const e of this.enemies) {
          if (e.alive && Vector3.DistanceSquared(e.node.position, p) <= radius * radius) e.applySlow(mult, seconds);
        }
        this.weapons.blast(new Vector3(p.x, p.y - 1, p.z), radius, new Color3(0.5, 0.8, 1));
      },
      timedBuff: (name, seconds, apply, undo) => {
        apply();
        this.timedBuffs.push({ name, left: seconds, undo });
      },
      freeSpin: () => {
        this.freeSpins++;
      },
      magnet: (mult) => {
        this.gold.magnetDist *= mult;
      },
    };
  }

  /** То же плюс автоматика и инвентарь — для рецептов */
  private get craftHost(): CraftHost {
    const game = this;
    return {
      ...this.itemHost,
      weapons: this.weapons,
      upgradeCount: (id) => this.upgradeCounts.get(id) ?? 0,
      itemCount: (id) => this.itemCounts.get(id) ?? 0,
      get coupons() {
        return game.freeSpins;
      },
      consume: (ing) => this.consume(ing),
      refreshShadows: () => this.refreshShadows(),
    };
  }

  /** Рывок-удар меча: игрок смещается вперёд, пока не упрётся в стену */
  private dashPlayer(distance: number): void {
    const yaw = this.player.mesh.rotation.y;
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const pos = this.player.mesh.position;
    const step = 0.25;
    let moved = 0;
    while (moved + step <= distance) {
      const nx = pos.x + dx * step;
      const nz = pos.z + dz * step;
      if (this.terrain.isWallAt(nx, nz)) break;
      pos.x = nx;
      pos.z = nz;
      moved += step;
    }
    if (moved > 0) pos.y = Math.max(pos.y, this.terrain.floorAt(pos.x, pos.z) + 1);
  }

  private tickTimedBuffs(dt: number): void {
    for (let i = this.timedBuffs.length - 1; i >= 0; i--) {
      const b = this.timedBuffs[i];
      b.left -= dt;
      if (b.left <= 0) {
        b.undo();
        this.timedBuffs.splice(i, 1);
      }
    }
  }

  /** Ярость (стаки сгорают через RAGE_TIME после последнего убийства) и Аегис (щит восстанавливается) */
  private tickPerks(dt: number): void {
    if (this.rageStacks > 0) {
      this.rageTimer -= dt;
      if (this.rageTimer <= 0) this.rageStacks = 0;
    }
    this.player.weaponStats.tempCooldownMult = 1 - RAGE_STACK * this.rageStacks;

    if (this.perks.aegis) {
      if (this.player.shield >= 1) this.aegisTimer = 0;
      else if ((this.aegisTimer += dt) >= AEGIS_RECHARGE) {
        this.aegisTimer = 0;
        this.player.shield = 1;
      }
    }
  }

  /** Взрыв пули (Гранатомёт): кольцо и урон всем вокруг точки попадания, кроме уже поражённого */
  private bulletBlast(point: Vector3, radius: number, bulletDamage: number): void {
    this.weapons.blast(new Vector3(point.x, this.terrain.floorAt(point.x, point.z) + 0.05, point.z), radius, new Color3(1, 0.6, 0.2));
    const dmg = Math.max(1, Math.round(bulletDamage * BULLET_BLAST_MULT));
    for (const e of this.enemies) {
      if (!e.alive || Vector3.DistanceSquared(e.node.position, point) > radius * radius) continue;
      if (e.takeDamage(dmg)) this.onEnemyKilled(e);
    }
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
        this.applyUpgrade(up.id);
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
    this.hudHp.textContent =
      `${Math.ceil(this.player.hp)}/${this.player.maxHp}` + (this.player.shield > 0 ? ` · щит ×${this.player.shield}` : "");
    this.hudEnemies.textContent = String(this.enemies.length);
    this.hudStage.textContent = String(this.stage);
    const s = Math.max(0, Math.ceil(this.stageTimer));
    this.hudWave.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    this.updateGoldHud();
    this.updateStatsHud();
  }

  /** Сводка справа сверху: оружие и его характеристики, автоматика, статы персонажа, предметы, временные бафы */
  private updateStatsHud(): void {
    const p = this.player;
    const st = p.weaponStats;
    const pct = (mult: number) => `${mult >= 1 ? "+" : ""}${Math.round((mult - 1) * 100)}%`;
    const lines: string[] = [];

    const sword = this.primary instanceof Sword ? this.primary : null;
    const gun = this.primary instanceof Gun ? this.primary : null;
    const weaponName = sword ? sword.title : gun ? gun.preset.title : "Пистолет";
    lines.push(`<div class="h">${weaponName}</div>`);
    const dmg = sword
      ? `${st.damage} ×${sword.totalDamageMult.toFixed(1).replace(/\.0$/, "")} за взмах`
      : gun && gun.preset.damageMult !== 1
        ? `${st.damage} ×${gun.preset.damageMult}`
        : `${st.damage}`;
    const shots = sword ? "взмахов" : "снарядов";
    const count = st.projectiles + (gun?.preset.pellets ?? 0);
    let w = `Урон <b>${dmg}</b> · ${shots} <b>${count}</b> · скорость атаки <b>${pct(1 / st.totalCooldownMult)}</b>`;
    if (sword) w += ` · сектор <b>${sword.arcDeg}°</b>`;
    const heat = this.primary?.heatLevel ?? 0;
    if (heat > 0.02) w += ` · нагрев <b>${Math.round(heat * 100)}%</b>`;
    lines.push(`<div>${w}</div>`);
    // Перки оружия из магазина и крафта
    const wp: string[] = [];
    if (st.critChance > 0) wp.push(`крит <b>${Math.round(st.critChance * 100)}%</b>`);
    if (gun && st.pierce > 0) wp.push(`пробитие <b>${st.pierce}</b>`);
    if (gun && st.ricochet) wp.push(`рикошет`);
    if (gun && st.bulletBlast > 0) wp.push(`взрыв пули <b>r${st.bulletBlast}</b>`);
    if (gun && st.bulletLifesteal > 0) wp.push(`вампиризм пуль <b>${Math.round(st.bulletLifesteal * 100)}%</b>`);
    if (sword && st.thunderBlade) wp.push(`молния с каждого удара`);
    if (sword && sword.dash > 0) wp.push(`рывок <b>${sword.dash}</b>`);
    if (this.perks.cooling) wp.push(`охлаждение`);
    if (this.rageStacks > 0) wp.push(`ярость <b>×${this.rageStacks}</b>`);
    else if (this.perks.rage) wp.push(`ярость`);
    if (wp.length) lines.push(`<div>${wp.join(" · ")}</div>`);

    const owned = this.weapons.ownedTitles;
    if (owned.length) lines.push(`<div class="h">Автоматика</div><div>${owned.join(" · ")}</div>`);

    lines.push(`<div class="h">Персонаж</div>`);
    const ch: string[] = [`макс. HP <b>${p.maxHp}</b>`, `скорость <b>${pct(p.speedMult)}</b>`];
    if (p.regen > 0) ch.push(`реген <b>${p.regen.toFixed(1)}/с</b>`);
    if (this.perks.armor < 1) ch.push(`броня <b>${Math.round((1 - this.perks.armor) * 100)}%</b>`);
    if (this.perks.thorns > 0) ch.push(`шипы <b>${Math.round(this.perks.thorns * 100)}%</b>`);
    if (this.perks.vampirism > 0) ch.push(`+<b>${this.perks.vampirism}</b> HP за убийство`);
    if (this.perks.secondWind) ch.push(`второе дыхание`);
    lines.push(`<div>${ch.join(" · ")}</div>`);

    const items: string[] = [];
    if (p.shield > 0) items.push(`щит <b>×${p.shield}</b>${this.perks.aegis ? " (аегис)" : ""}`);
    else if (this.perks.aegis) items.push(`аегис <b>${Math.ceil(AEGIS_RECHARGE - this.aegisTimer)} с</b>`);
    if (p.goldBonus > 0) items.push(`золото с врага <b>+${p.goldBonus}</b>`);
    if (this.perks.goldMult > 1.001) items.push(`золото <b>×${this.perks.goldMult.toFixed(2)}</b>`);
    const magnet = this.gold.magnetMult;
    if (this.perks.goldRush) items.push(`золотая лихорадка`);
    else if (magnet > 1.001) items.push(`магнит <b>×${magnet.toFixed(2)}</b>`);
    if (this.freeSpins > 0) items.push(`купоны <b>×${this.freeSpins}</b>`);
    if (items.length) lines.push(`<div class="h">Предметы</div><div>${items.join(" · ")}</div>`);

    const wheelMods: string[] = [];
    if (this.perks.emptyShare < 0.5) wheelMods.push(`счастливая монета`);
    if (this.perks.weaponWeightMult > 1) wheelMods.push(`весы ×${this.perks.weaponWeightMult}`);
    if (this.perks.spinStep !== SPIN_STEP) wheelMods.push(`скупка +${this.perks.spinStep}`);
    if (this.perks.bossChanceNext !== null) wheelMods.push(`пробирка <b>${Math.round(this.perks.bossChanceNext * 100)}%</b>`);
    if (wheelMods.length) lines.push(`<div class="h">Колесо</div><div>${wheelMods.join(" · ")}</div>`);

    if (this.timedBuffs.length) {
      const b = this.timedBuffs.map((t) => `${t.name} <b>${Math.ceil(t.left)} с</b>`).join(" · ");
      lines.push(`<div class="h">Бафы</div><div class="buff">${b}</div>`);
    }

    const html = lines.join("");
    if (html !== this.statsHtml) {
      this.statsHtml = html;
      this.hudStats.innerHTML = html;
    }
  }

  /** Полоска золота ведёт к цене следующего вращения колеса; при полной — подсказка */
  private updateGoldHud(): void {
    const gold = this.player.gold;
    const price = this.spinPrice;
    const owned = this.weapons.ownedTitles;
    this.hudWeapons.textContent = owned.length ? `Оружие: ${owned.join(", ")}` : "";
    const free = this.freeSpins > 0;
    this.hudGold.textContent = free ? `${gold} (купон)` : `${gold}/${price}`;
    this.hudGoldFill.style.width = free ? "100%" : `${Math.min(100, (gold / price) * 100).toFixed(1)}%`;
    const ready = free || gold >= price;
    this.hudGoldHint.textContent = ready
      ? free
        ? "B — колесо фортуны: бесплатное вращение по купону"
        : `B — колесо фортуны, вращение за ${price}`
      : `Колесо фортуны: следующее вращение ${price} золота`;
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
    const pk = this.perks;
    let damage = 0;
    for (const enemy of this.enemies) {
      const dir = this.flowField.getDirection(enemy.node.position.x, enemy.node.position.z);
      const d = enemy.update(dt, this.player.position, getHeight, dir, blocked);
      if (d <= 0) continue;
      const taken = this.weapons.incomingDamage(enemy, d, this.player) * pk.armor; // Radiance: часть ударов почти безвредна; броня
      damage += taken;
      // Шипы: часть урона возвращается ударившему
      if (pk.thorns > 0 && enemy.takeDamage(Math.max(1, Math.round(taken * pk.thorns)))) this.onEnemyKilled(enemy);
    }
    this.crowd.separate(this.enemies, this.player.position.x, this.player.position.z, blocked);
    if (damage > 0) {
      this.player.takeDamage(damage);
      if (this.player.hp <= 0) this.die();
    }

    // Улучшения оружия: летающий пистолет стреляет сам, Radiance жжёт вокруг
    this.weapons.update(dt, this.player, this.enemies);
    this.projectiles.update(dt, this.enemies, this.terrain, {
      onKill: (e) => this.onEnemyKilled(e),
      onHit: (e, dmg, point) => this.weapons.onWeaponHit(e, dmg, point, this.enemies),
      onBlast: (point, radius, dmg) => this.bulletBlast(point, radius, dmg),
      onHeal: (amount) => {
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + amount);
      },
    });
    // Перекрестие расходится с нагревом ствола (у меча нагрева нет)
    this.crosshair.style.transform = `scale(${(1 + primary.heatLevel * 0.8).toFixed(3)})`;

    // Временные бафы предметов (адреналин) и перки с таймерами
    this.tickTimedBuffs(dt);
    this.tickPerks(dt);

    // Золото: физика монет и подбор; B — колесо фортуны (открывается всегда, крутить — если хватает золота)
    this.player.gold += this.gold.update(dt, this.player.position, (x, z) => this.terrain.floorAt(x, z));
    const coupons = this.gold.takeCoupons();
    if (coupons > 0) {
      this.freeSpins += coupons;
      this.showFlash("Купон колеса фортуны!");
    }
    if (this.input.takePress("KeyB")) this.openWheel();

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
    // Второе дыхание: один раз вместо смерти — половина HP и щит на удар
    if (this.perks.secondWind) {
      this.perks.secondWind = false;
      this.player.hp = Math.ceil(this.player.maxHp * SECOND_WIND_HP);
      this.player.shield += 1;
      this.showFlash("Второе дыхание!");
      return;
    }
    this.dead = true;
    this.firing = false;
    this.camera.unlock();
    this.lockHint.style.display = "none";
    this.deathInfo.textContent = `Этап ${this.stage}. Нажмите R, чтобы начать новый забег`;
    this.overlay.style.display = "flex";
  }
}
