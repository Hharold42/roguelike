import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { clamp, smoothstep, type MotionState } from "./motion";

/**
 * Распознавание гуманоидного скелета без опоры на имена костей (они бывают битыми
 * или на другом языке), постановка «боевой» позы и процедурная анимация поверх него:
 * ходьба, присед сгибом коленей, прыжок/leap, приземление, дыхание и покачивание.
 *
 * Используются только суффиксы стороны (.L/.R, Left/Right) и геометрия:
 * высота кости относительно роста, длина цепочки под ней, вершины меша стоп.
 */

/** Одна ось вращения кости: ось в пространстве родителя и знак, при котором положительный угол двигает конец вдоль ref */
interface Axis {
  axis: Vector3;
  fwd: number;
}

/** Кость с позой покоя и одной-двумя осями качания */
interface Swinger {
  node: TransformNode;
  rest: Quaternion;
  pitch: Axis; // вокруг «вправо»: вперёд/назад
  roll: Axis | null; // вокруг «вперёд»: влево/вправо
  yaw: Axis | null; // вокруг вертикали
}

/** Что риг просит сделать с узлом тела снаружи (он не кость, им владеет CharacterModel) */
export interface RigPose {
  /** На сколько опустить таз (присед, приземление) — ноги согнуты ровно на столько */
  hipDrop: number;
  /** Наклон всего тела вперёд (рад) — только если позвоночника нет */
  bodyLean: number;
}

export interface HumanoidRig {
  /** Направление «вперёд» модели в системе координат, где она была распознана (или null) */
  forward: Vector3 | null;
  /** Есть ли что анимировать */
  animated: boolean;
  /** Сколько частей найдено */
  counts: { thighs: number; knees: number; arms: number; spine: number; head: boolean };
  /** Кисть руки с оружием (правая), плечо этой руки и направление предплечья — в системе модели */
  weaponHand: { node: TransformNode; shoulder: TransformNode; forward: Vector3 } | null;
  /** Шаг процедурной анимации по состоянию движения */
  update(dt: number, state: MotionState): RigPose;
  /** Направить оружейную руку: dir — мировое направление на цель (учитывается наклон вверх/вниз) */
  aim(dir: Vector3): void;
  /** Горизонтальный замах оружейной руки, рад (положительный — к правому боку) */
  swing(angle: number): void;
  /** Вернуть позу покоя */
  reset(): void;
}

type Side = "L" | "R";

const SIDE_L = /(^|[._\-\s])L([._\-\s]|$)|left/i;
const SIDE_R = /(^|[._\-\s])R([._\-\s]|$)|right/i;
const HELPER = /_dummy_|_shadow_|IK|ik_|_ik|twist|捩/i;
/** Рука с оружием — правая */
const WEAPON_SIDE: Side = "R";

function sideOf(name: string): Side | null {
  if (SIDE_L.test(name)) return "L";
  if (SIDE_R.test(name)) return "R";
  return null;
}

const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();

interface Leg { thigh: TransformNode; knee: TransformNode | null; ankle: TransformNode; toe: TransformNode | null }
interface Arm { upper: TransformNode; elbow: TransformNode | null; hand: TransformNode }

// ---------- Параметры анимации (рад, если не сказано иное) ----------
const WALK_RATE = 1.5; // фаза шага на юнит пути
const THIGH_AMP = 0.5;
const KNEE_BASE = 0.12; // колени чуть согнуты на ходу всегда
const KNEE_AMP = 0.85; // добавка при выносе ноги
const ARM_AMP = 0.45;
const ELBOW_BASE = 0.25;
const ELBOW_AMP = 0.5;
const WEAPON_BOB = 0.035;
const AIM_PITCH_MAX = 1.1;
const AIM_RATE = 18; // скорость доворота руки к прицелу (1/с)

const CROUCH_THIGH = 0.9; // бедро вперёд в полном приседе; колено сгибается на 2x — стопа остаётся под тазом
const CROUCH_LEAN = 0.28; // корпус вперёд в приседе (баланс)
const LAND_THIGH = 0.55; // амортизация при приземлении (× импульс)
const LAND_LEAN = 0.2;

const AIR_IN = 0.12; // с, за сколько ноги переходят в позу прыжка после отрыва
const LEAP_MIN_SPEED = 2.5; // юнитов/с: быстрее — leap с разножкой, медленнее — прыжок с поджатыми ногами

const LEAN_PER_SPEED = 0.014; // наклон корпуса вперёд на юнит/с скорости
const STRAFE_ROLL = 0.09; // крен в сторону стрейфа
const WALK_SWAY = 0.035; // покачивание корпуса в такт шагам
const IDLE_BREATH = 0.014; // дыхание (наклон груди)
const IDLE_SWAY = 0.012; // перенос веса с ноги на ногу
const HEAD_AIM = 0.45; // доля наклона прицела, которую повторяет голова
const HEAD_LOOK = 0.07; // амплитуда «оглядывания» головой в покое

/**
 * Распознать риг. Вызывать, когда модель уже нормализована по росту и стоит ногами на y=0,
 * а её корень не повёрнут: forward возвращается в этой системе координат.
 * meshes — скиннованные меши модели (нужны, чтобы понять «вперёд» по стопам, если нет костей носков).
 */
export function detectHumanoidRig(skeleton: Skeleton, height: number, meshes: AbstractMesh[] = [], quiet = false): HumanoidRig | null {
  const nodes: TransformNode[] = [];
  const isBone = new Set<TransformNode>();
  for (const b of skeleton.bones) {
    const n = b.getTransformNode();
    if (n) {
      nodes.push(n);
      isBone.add(n);
    }
  }
  if (nodes.length < 6) return null;
  for (const n of nodes) n.computeWorldMatrix(true);

  const pos = (n: TransformNode) => n.getAbsolutePosition();
  const rel = (n: TransformNode) => pos(n).y / height;
  const helper = (n: TransformNode) => HELPER.test(n.name);

  const boneChildren = (n: TransformNode): TransformNode[] =>
    n.getChildren((c) => c instanceof TransformNode && isBone.has(c as TransformNode), true) as TransformNode[];

  const descendantCount = new Map<TransformNode, number>();
  const countDesc = (n: TransformNode): number => {
    const cached = descendantCount.get(n);
    if (cached !== undefined) return cached;
    let c = 0;
    for (const ch of boneChildren(n)) c += 1 + countDesc(ch);
    descendantCount.set(n, c);
    return c;
  };

  /** Основной ребёнок: не вспомогательный, той же стороны (или без стороны), с наибольшим поддеревом */
  const mainChild = (n: TransformNode, side: Side | null): TransformNode | null => {
    let best: TransformNode | null = null;
    let bestCount = -1;
    for (const ch of boneChildren(n)) {
      if (helper(ch)) continue;
      const s = sideOf(ch.name);
      if (side && s && s !== side) continue;
      if (!side && s) continue; // для осевых цепочек (позвоночник) боковые кости не берём
      const c = countDesc(ch);
      if (c > bestCount) {
        bestCount = c;
        best = ch;
      }
    }
    return best;
  };

  /**
   * Цепочка по основным детям. minSegment — доля роста: сегменты короче не идём
   * (так рука заканчивается на кисти, а не на кончике пальца).
   */
  const chainFrom = (n: TransformNode, side: Side, minSegment = 0): TransformNode[] => {
    const out = [n];
    let cur: TransformNode | null = n;
    for (let i = 0; i < 12 && cur; i++) {
      const next = mainChild(cur, side);
      if (!next) break;
      if (minSegment > 0 && Vector3.Distance(pos(cur), pos(next)) < minSegment * height) break;
      out.push(next);
      cur = next;
    }
    return out;
  };
  const FINGER_SEG = 0.025;

  const isDescendant = (n: TransformNode, ancestor: TransformNode): boolean => {
    let p = n.parent;
    while (p) {
      if (p === ancestor) return true;
      p = p.parent;
    }
    return false;
  };
  const ancestorsOf = (n: TransformNode): TransformNode[] => {
    const out: TransformNode[] = [];
    let p = n.parent as TransformNode | null;
    while (p) {
      if (isBone.has(p)) out.push(p);
      p = p.parent as TransformNode | null;
    }
    return out;
  };
  /** Ближайший общий предок-кость */
  const commonAncestor = (a: TransformNode, b: TransformNode): TransformNode | null => {
    const bs = new Set(ancestorsOf(b));
    bs.add(b);
    return ancestorsOf(a).find((n) => bs.has(n)) ?? null;
  };

  /** Оставить только самые глубокие кандидаты (без кандидатов-потомков) */
  const deepest = (cands: TransformNode[]): TransformNode[] =>
    cands.filter((c) => !cands.some((o) => o !== c && isDescendant(o, c)));

  const legs: { side: Side; leg: Leg }[] = [];
  const arms: { side: Side; arm: Arm }[] = [];
  const sidedNodes = (side: Side) => nodes.filter((n) => sideOf(n.name) === side && !helper(n));

  // --- Ноги ---
  for (const side of ["L", "R"] as Side[]) {
    const sided = sidedNodes(side);

    // Бедро на 38–65% роста, цепочка доходит до земли
    const legCands = deepest(
      sided.filter((n) => {
        const y = rel(n);
        if (y < 0.38 || y > 0.65) return false;
        const chain = chainFrom(n, side);
        return chain.length >= 3 && Math.min(...chain.map(rel)) <= 0.15;
      }),
    );
    for (const thigh of legCands) {
      const chain = chainFrom(thigh, side);
      const ty = rel(thigh);
      const knee = chain.slice(1).find((n) => ty - rel(n) >= 0.12) ?? null;
      const kneeY = knee ? rel(knee) : ty;
      const ankle = chain.slice(1).find((n) => n !== knee && kneeY - rel(n) >= 0.12 && rel(n) <= 0.15) ?? null;
      if (!ankle) continue;
      const toe = mainChild(ankle, side);
      legs.push({ side, leg: { thigh, knee, ankle, toe } });
    }
  }

  if (legs.length === 0) return null;

  // --- Вперёд: по костям носков, иначе по вершинам меша стоп (ступня выступает вперёд от лодыжки) ---
  let forward = toeForward(legs.map((l) => l.leg), pos);
  if (!forward) forward = footMeshForward(skeleton, meshes, legs.map((l) => l.leg), pos, height);

  const notAnimated = (): HumanoidRig => ({
    forward: null,
    animated: false,
    counts: { thighs: legs.length, knees: 0, arms: 0, spine: 0, head: false },
    weaponHand: null,
    update: () => ({ hipDrop: 0, bodyLean: 0 }),
    aim() {},
    swing() {},
    reset() {},
  });
  if (!forward) return notAnimated();

  const lateral = Vector3.Cross(UP, forward).normalize(); // «вправо» модели
  // Центр тела по горизонтали — среднее по всем костям (руки симметричны, среднее ложится на позвоночник)
  const center = new Vector3(0, 0, 0);
  for (const n of nodes) center.addInPlace(pos(n));
  center.scaleInPlace(1 / nodes.length);
  /** Направление «наружу» от тела для кости стороны side */
  const outwardOf = (n: TransformNode): Vector3 => {
    const d = Vector3.Dot(pos(n).subtract(center), lateral);
    return lateral.scale(d >= 0 ? 1 : -1);
  };

  // --- Руки (нужен lateral, чтобы отличить руку от висящей ткани: плащ, юбка, волосы) ---
  for (const side of ["L", "R"] as Side[]) {
    const sided = sidedNodes(side);
    // Плечевая кость на 58–88% роста, цепочка длиннее 20% роста и уходит вбок минимум на 10% роста
    const armCands = deepest(
      sided.filter((n) => {
        const y = rel(n);
        if (y < 0.58 || y > 0.88) return false;
        if (legs.some(({ leg }) => n === leg.thigh || isDescendant(n, leg.thigh))) return false;
        const chain = chainFrom(n, side, FINGER_SEG); // до кисти, пальцы не считаем
        const end = chain[chain.length - 1];
        const span = pos(end).subtract(pos(n));
        return (
          chain.length >= 2 &&
          span.length() >= 0.2 * height &&
          Math.abs(Vector3.Dot(span, lateral)) >= 0.1 * height
        );
      }),
    );
    for (const upper of armCands) {
      const chain = chainFrom(upper, side, FINGER_SEG);
      const hand = chain[chain.length - 1];
      // Локоть — первая кость цепочки дальше 8% роста от плеча (пропускаем кости скрутки)
      const elbow =
        chain.slice(1, -1).find((n) => Vector3.Distance(pos(n), pos(upper)) >= 0.08 * height) ?? null;
      arms.push({ side, arm: { upper, elbow, hand } });
    }
  }

  // --- Таз, позвоночник, голова ---
  // Таз — ближайший общий предок бёдер; грудь — общий предок плеч; позвоночник — кости между ними
  let hips: TransformNode | null = null;
  if (legs.length >= 2) hips = commonAncestor(legs[0].leg.thigh, legs[1].leg.thigh);
  else hips = ancestorsOf(legs[0].leg.thigh)[0] ?? null;
  let chest: TransformNode | null = null;
  if (arms.length >= 2) chest = commonAncestor(arms[0].arm.upper, arms[1].arm.upper);
  else if (arms.length === 1) chest = ancestorsOf(arms[0].arm.upper)[0] ?? null;
  const spine: TransformNode[] = [];
  if (hips && chest && chest !== hips && isDescendant(chest, hips)) {
    let cur: TransformNode | null = chest;
    while (cur && cur !== hips) {
      spine.unshift(cur);
      cur = cur.parent as TransformNode | null;
    }
    // Слишком длинный позвоночник (вспомогательные кости) — оставляем до 3 верхних
    while (spine.length > 3) spine.shift();
  }
  // Голова: от груди вверх по осевым костям (не рукам) до самой верхней
  let head: TransformNode | null = null;
  if (chest) {
    let cur: TransformNode = chest;
    for (let i = 0; i < 6; i++) {
      const kids: TransformNode[] = boneChildren(cur).filter(
        (c) => !helper(c) && !sideOf(c.name) && !arms.some((a) => c === a.arm.upper || isDescendant(a.arm.upper, c)),
      );
      if (kids.length === 0) break;
      // Самая высокая осевая кость
      cur = kids.reduce((best: TransformNode, k: TransformNode) => (rel(k) > rel(best) ? k : best));
      if (rel(cur) > 0.8) head = cur;
    }
  }

  // --- Постановка позы: оружейная рука вперёд, остальные — вдоль тела (T-поза так не остаётся) ---
  for (const { side, arm } of arms) {
    const out = outwardOf(arm.upper);
    const weapon = side === WEAPON_SIDE;
    const upperTarget = weapon
      ? forward.add(out.scale(0.15)).subtract(UP.scale(0.1))
      : UP.scale(-1).add(out.scale(0.25)).add(forward.scale(0.05));
    // Предплечье оружейной руки — строго вперёд: ствол совпадает с направлением взгляда корпуса
    const foreTarget = weapon
      ? forward.clone()
      : UP.scale(-1).add(forward.scale(0.3)).add(out.scale(0.15));
    aimBone(arm.upper, arm.elbow ?? arm.hand, upperTarget.normalize(), pos);
    forceChain(arm.upper, arm.hand);
    if (arm.elbow) {
      aimBone(arm.elbow, arm.hand, foreTarget.normalize(), pos);
      forceChain(arm.elbow, arm.hand);
    }
  }

  const weaponArm = arms.find((a) => a.side === WEAPON_SIDE)?.arm ?? null;
  const weaponHand = weaponArm
    ? {
        node: weaponArm.hand,
        shoulder: weaponArm.upper,
        forward: pos(weaponArm.hand).subtract(pos(weaponArm.elbow ?? weaponArm.upper)).normalize(),
      }
    : null;

  /**
   * Ось вращения кости: мировая ось переводится в пространство родителя, знак определяем
   * пробным поворотом — положительный угол должен двигать probe вдоль ref.
   * probe — конец цепочки (кость) или мировая точка, жёстко связанная с костью.
   */
  const makeAxis = (node: TransformNode, probe: TransformNode | Vector3, axisWorld: Vector3, ref: Vector3): Axis => {
    const rest = ensureQuaternion(node).clone();
    const axis = toParentSpace(node, axisWorld);
    const probeWorld = probe instanceof TransformNode ? null : probe.clone();
    const probeLocal = probeWorld ? Vector3.TransformCoordinates(probeWorld, node.getWorldMatrix().clone().invert()) : null;
    const where = (): Vector3 => {
      if (probe instanceof TransformNode) return pos(probe).clone();
      node.computeWorldMatrix(true);
      return Vector3.TransformCoordinates(probeLocal!, node.getWorldMatrix());
    };
    const end = probe instanceof TransformNode ? probe : node;

    const before = where();
    node.rotationQuaternion = Quaternion.RotationAxis(axis, 0.3).multiply(rest);
    forceChain(node, end);
    const delta = where().subtract(before);
    node.rotationQuaternion = rest.clone();
    forceChain(node, end);
    return { axis, fwd: Vector3.Dot(delta, ref) >= 0 ? 1 : -1 };
  };

  const makeSwinger = (node: TransformNode, probe: TransformNode | Vector3, withRoll = false, withYaw = false): Swinger => ({
    node,
    rest: ensureQuaternion(node).clone(),
    pitch: makeAxis(node, probe, lateral, forward!),
    roll: withRoll ? makeAxis(node, probe, forward!, lateral) : null,
    yaw: withYaw ? makeAxis(node, probe, UP, lateral) : null,
  });

  const thighs: { s: Swinger; side: Side }[] = [];
  const knees: { s: Swinger; side: Side }[] = [];
  // Длина ноги бедро→лодыжка: на столько (×(1−cos θ)) опускается таз при сгибе бедра на θ и колена на 2θ
  let legLen = 0.5 * height;
  for (const { side, leg } of legs) {
    thighs.push({ s: makeSwinger(leg.thigh, leg.ankle), side });
    if (leg.knee) {
      knees.push({ s: makeSwinger(leg.knee, leg.ankle), side });
      legLen = Vector3.Distance(pos(leg.thigh), pos(leg.knee)) + Vector3.Distance(pos(leg.knee), pos(leg.ankle));
    }
  }
  const swingArms: { upper: Swinger; elbow: Swinger | null; side: Side }[] = [];
  let weaponUpper: Swinger | null = null;
  for (const { side, arm } of arms) {
    if (side === WEAPON_SIDE) {
      // Оружейная рука уже смотрит вперёд: положительный pitch = поднять кисть, положительный yaw = кисть вправо
      const s = makeSwinger(arm.upper, arm.hand);
      s.pitch = makeAxis(arm.upper, arm.hand, lateral, UP);
      s.yaw = makeAxis(arm.upper, arm.hand, UP, lateral);
      weaponUpper = s;
    } else {
      const upper = makeSwinger(arm.upper, arm.hand);
      swingArms.push({ upper, elbow: arm.elbow ? makeSwinger(arm.elbow, arm.hand) : null, side });
    }
  }

  // Позвоночник: probe — голова или точка над грудью; pitch (вперёд) и roll (вбок)
  const topProbe = head ?? pos(chest ?? hips ?? nodes[0]).add(UP.scale(0.2 * height));
  const spineSw: Swinger[] = spine.map((b) => makeSwinger(b, topProbe, true));
  // Голова: pitch — макушка вперёд (кивок), yaw — по точке перед лицом
  let headSw: Swinger | null = null;
  if (head) {
    headSw = makeSwinger(head, pos(head).add(UP.scale(0.1 * height)));
    headSw.yaw = makeAxis(head, pos(head).add(forward.scale(0.1 * height)), UP, lateral);
  }

  const all: Swinger[] = [
    ...thighs.map((x) => x.s),
    ...knees.map((x) => x.s),
    ...swingArms.flatMap((a) => (a.elbow ? [a.upper, a.elbow] : [a.upper])),
    ...(weaponUpper ? [weaponUpper] : []),
    ...spineSw,
    ...(headSw ? [headSw] : []),
  ];
  if (!quiet) {
    console.info(
      `[rig] бёдра ${thighs.length}, колени ${knees.length}, руки ${arms.length}, позвоночник ${spine.length}` +
        (head ? ", голова" : "") +
        (weaponHand ? ", оружейная рука найдена" : ""),
    );
  }

  /** Применить углы: q = yaw * roll * pitch * rest */
  const apply = (s: Swinger, pitch: number, roll = 0, yaw = 0) => {
    Quaternion.RotationAxisToRef(s.pitch.axis, pitch * s.pitch.fwd, tmpQ);
    if (s.roll && roll !== 0) {
      Quaternion.RotationAxisToRef(s.roll.axis, roll * s.roll.fwd, tmpQ2);
      tmpQ2.multiplyToRef(tmpQ, tmpQ);
    }
    if (s.yaw && yaw !== 0) {
      Quaternion.RotationAxisToRef(s.yaw.axis, yaw * s.yaw.fwd, tmpQ2);
      tmpQ2.multiplyToRef(tmpQ, tmpQ);
    }
    tmpQ.multiplyToRef(s.rest, s.node.rotationQuaternion!);
  };

  // --- Состояние анимации ---
  let phase = 0;
  let blend = 0; // 0 стоим, 1 идём
  let air = 0; // 0 на земле, 1 поза прыжка
  let leap = 0; // 0 прыжок с места, 1 leap с разножкой
  let leadSign = 1; // какая нога впереди в leap: +1 — L
  let time = 0;
  let lean = 0; // сглаженный наклон корпуса
  let roll = 0; // сглаженный крен
  const restPitch = weaponHand ? Math.asin(clamp(weaponHand.forward.y, -1, 1)) : 0;
  let aimPitch = restPitch;
  let curPitch = restPitch;
  let swingYaw = 0;
  const sign = (side: Side) => (side === "L" ? 1 : -1);

  return {
    forward,
    animated: all.length > 0,
    counts: { thighs: thighs.length, knees: knees.length, arms: arms.length, spine: spine.length, head: !!head },
    weaponHand,
    update(dt, st) {
      time += dt;
      const absSpeed = Math.abs(st.speed);
      const walking = st.moving && !st.airborne;
      blend += ((walking ? 1 : 0) - blend) * Math.min(1, dt * 10);
      if (walking) phase += dt * st.speed * WALK_RATE;
      const sw = Math.sin(phase) * blend;

      // Поза прыжка: плавно входим после отрыва, в момент отрыва запоминаем, какая нога впереди
      if (st.airborne) {
        if (air === 0) {
          leadSign = Math.sin(phase) >= 0 ? 1 : -1;
          leap = absSpeed > LEAP_MIN_SPEED ? 1 : 0;
        }
        air = smoothstep(st.airTime / AIR_IN);
      } else {
        air += (0 - air) * Math.min(1, dt * 14);
        if (air < 0.01) air = 0;
      }
      // На спуске ноги распрямляются к земле — готовимся приземлиться
      const prep = st.airborne ? clamp(-st.vy / 9, 0, 1) : 1;

      // Углы приседа и амортизации: бедро вперёд на θ, колено назад на 2θ — стопа остаётся под тазом
      const thetaC = CROUCH_THIGH * st.crouch;
      const thetaL = LAND_THIGH * st.land;
      const theta = thetaC + thetaL;
      const hipDrop = legLen * (1 - Math.cos(theta));

      // --- Ноги ---
      for (const { s, side } of thighs) {
        let a = THIGH_AMP * sw * sign(side) + theta;
        if (air > 0) {
          const lead = sign(side) === leadSign;
          const tuck = lerp(0.95, 0.3, prep); // прыжок с места: обе ноги поджаты, к земле — вниз
          const leapAngle = lead ? lerp(1.0, 0.35, prep) : lerp(-0.55, 0.15, prep);
          a += air * lerp(tuck, leapAngle, leap);
        }
        apply(s, a);
      }
      for (const { s, side } of knees) {
        const lift = Math.max(0, sw * sign(side));
        let a = -(KNEE_BASE * blend + KNEE_AMP * lift) - 2 * theta;
        if (air > 0) {
          const lead = sign(side) === leadSign;
          const tuck = -lerp(1.5, 0.55, prep);
          const leapAngle = lead ? -lerp(1.1, 0.5, prep) : -lerp(0.3, 0.55, prep);
          a += air * lerp(tuck, leapAngle, leap);
        }
        apply(s, a);
      }

      // --- Корпус ---
      const targetLean =
        LEAN_PER_SPEED * st.speed +
        CROUCH_LEAN * st.crouch +
        LAND_LEAN * st.land +
        air * (leap > 0.5 ? 0.22 : 0.08);
      lean += (targetLean - lean) * Math.min(1, dt * 8);
      const targetRoll = -STRAFE_ROLL * st.strafe - 0.02 * clamp(st.yawRate / 6, -1, 1);
      roll += (targetRoll - roll) * Math.min(1, dt * 6);
      const breath = IDLE_BREATH * Math.sin(time * 1.7) * (1 - blend);
      const sway = WALK_SWAY * Math.sin(phase) * blend + IDLE_SWAY * Math.sin(time * 0.8) * (1 - blend);
      let torsoPitch = 0;
      if (spineSw.length > 0) {
        const n = spineSw.length;
        spineSw.forEach((s, i) => {
          // Грудь наклоняется больше поясницы
          const w = (i + 1) / ((n * (n + 1)) / 2);
          const p = lean * w + (i === n - 1 ? breath : 0);
          torsoPitch += p;
          apply(s, p, (roll + sway) * w);
        });
      }
      if (headSw) {
        // Голова держит горизонт (компенсирует наклон корпуса), смотрит чуть по прицелу и оглядывается в покое
        const look = HEAD_LOOK * Math.sin(time * 0.6) * Math.sin(time * 0.23) * (1 - blend);
        const headPitch = -torsoPitch * 0.7 - HEAD_AIM * (curPitch - restPitch) + 0.03 * Math.sin(phase * 2) * blend;
        apply(headSw, headPitch, 0, look);
      }

      // --- Свободные руки: противофазно ногам, в прыжке уходят вверх-вперёд ---
      for (const { upper, elbow, side } of swingArms) {
        const armSw = -sw * sign(side);
        let a = ARM_AMP * armSw;
        let e = ELBOW_BASE * blend + ELBOW_AMP * Math.max(0, armSw);
        if (air > 0) {
          a += air * lerp(0.9, 0.5, prep);
          e += air * 0.6;
        }
        a += 0.2 * st.crouch;
        apply(upper, a);
        if (elbow) apply(elbow, e);
      }

      // --- Оружейная рука: следует за прицелом, компенсирует наклон корпуса (ствол не уезжает), чуть дышит ---
      if (weaponUpper) {
        curPitch += (aimPitch - curPitch) * Math.min(1, dt * AIM_RATE);
        const bob = WEAPON_BOB * Math.sin(phase * 2) * blend + 0.006 * Math.sin(time * 1.7) * (1 - blend);
        // Наклон корпуса вперёд опускает руку — поднимаем на столько же
        apply(weaponUpper, curPitch - restPitch + torsoPitch + bob + air * 0.12, 0, swingYaw);
      }

      return { hipDrop, bodyLean: spineSw.length > 0 ? 0 : lean };
    },
    aim(dir) {
      const len = dir.length();
      if (len < 1e-6) return;
      const p = Math.asin(clamp(dir.y / len, -1, 1));
      aimPitch = clamp(p, -AIM_PITCH_MAX, AIM_PITCH_MAX);
    },
    swing(angle) {
      swingYaw = angle;
    },
    reset() {
      for (const s of all) s.node.rotationQuaternion!.copyFrom(s.rest);
    },
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------- Вспомогательное ----------

type PosFn = (n: TransformNode) => Vector3;

/** «Вперёд» по костям носков: лодыжка -> носок, усреднённо по ногам */
function toeForward(legs: Leg[], pos: PosFn): Vector3 | null {
  const acc = new Vector3(0, 0, 0);
  let cnt = 0;
  for (const leg of legs) {
    if (!leg.toe) continue;
    const d = pos(leg.toe).subtract(pos(leg.ankle));
    d.y = 0;
    if (d.lengthSquared() > 1e-6) {
      acc.addInPlace(d.normalize());
      cnt++;
    }
  }
  return cnt > 0 && acc.lengthSquared() > 1e-6 ? acc.normalize() : null;
}

/**
 * «Вперёд» по мешу: ступня выступает вперёд от лодыжки. Берём вершины, привязанные к костям ноги
 * и лежащие в самом низу (ниже лодыжки + 10% роста), и смотрим, куда их центр смещён от лодыжки.
 * Работает для ригов без костей носков и даже когда у стопы нет своей кости (веса на голени).
 */
function footMeshForward(
  skeleton: Skeleton,
  meshes: AbstractMesh[],
  legs: Leg[],
  pos: PosFn,
  height: number,
): Vector3 | null {
  // Кость -> индекс ноги
  const legOfBone = new Map<number, number>();
  legs.forEach((leg, li) => {
    for (const n of [leg.thigh, leg.knee, leg.ankle, leg.toe]) {
      if (!n) continue;
      const idx = skeleton.bones.findIndex((b) => b.getTransformNode() === n);
      if (idx >= 0) legOfBone.set(idx, li);
    }
  });
  if (legOfBone.size === 0) return null;
  const maxY = legs.map((leg) => pos(leg.ankle).y + 0.1 * height);

  const acc = legs.map(() => ({ sum: new Vector3(0, 0, 0), n: 0 }));
  const v = new Vector3();
  for (const mesh of meshes) {
    if (mesh.skeleton !== skeleton) continue;
    const p = mesh.getVerticesData(VertexBuffer.PositionKind);
    const mi = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
    const mw = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    if (!p || !mi || !mw) continue;
    mesh.computeWorldMatrix(true);
    const wm = mesh.getWorldMatrix();
    const count = p.length / 3;
    for (let i = 0; i < count; i++) {
      // Доминирующая кость вершины
      let best = 0;
      for (let k = 1; k < 4; k++) if (mw[i * 4 + k] > mw[i * 4 + best]) best = k;
      const li = legOfBone.get(mi[i * 4 + best]);
      if (li === undefined) continue;
      v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      Vector3.TransformCoordinatesToRef(v, wm, v);
      if (v.y > maxY[li]) continue;
      acc[li].sum.addInPlace(v);
      acc[li].n++;
    }
  }

  const dir = new Vector3(0, 0, 0);
  let cnt = 0;
  legs.forEach((leg, li) => {
    const a = acc[li];
    if (a.n < 3) return;
    const d = a.sum.scale(1 / a.n).subtract(pos(leg.ankle));
    d.y = 0;
    if (d.lengthSquared() > 1e-6) {
      dir.addInPlace(d.normalize());
      cnt++;
    }
  });
  return cnt > 0 && dir.lengthSquared() > 1e-6 ? dir.normalize() : null;
}

function ensureQuaternion(node: TransformNode): Quaternion {
  if (!node.rotationQuaternion) {
    node.rotationQuaternion = Quaternion.FromEulerVector(node.rotation);
    node.rotation.setAll(0);
  }
  return node.rotationQuaternion;
}

/** Мировой вектор -> система координат родителя кости (нормированный) */
function toParentSpace(node: TransformNode, worldDir: Vector3): Vector3 {
  if (!node.parent) return worldDir.clone();
  const inv = (node.parent as TransformNode).getWorldMatrix().clone().invert();
  return Vector3.TransformNormal(worldDir, inv).normalize();
}

/**
 * Повернуть кость так, чтобы направление на end совпало с targetDir (мировое).
 * Знак поворота проверяем по факту — зеркальные трансформы glTF иначе не угадать.
 */
function aimBone(node: TransformNode, end: TransformNode, targetDir: Vector3, pos: PosFn): void {
  const rest = ensureQuaternion(node).clone();
  const current = pos(end).subtract(pos(node)).normalize();
  const dot = Math.max(-1, Math.min(1, Vector3.Dot(current, targetDir)));
  const angle = Math.acos(dot);
  if (angle < 1e-3) return;
  let axis = Vector3.Cross(current, targetDir);
  if (axis.lengthSquared() < 1e-8) axis = Vector3.Cross(current, Math.abs(current.y) < 0.9 ? UP : new Vector3(1, 0, 0));
  const axisP = toParentSpace(node, axis.normalize());

  const tryAngle = (a: number): number => {
    node.rotationQuaternion = Quaternion.RotationAxis(axisP, a).multiply(rest);
    forceChain(node, end);
    return Vector3.Dot(pos(end).subtract(pos(node)).normalize(), targetDir);
  };
  const plus = tryAngle(angle);
  const minus = tryAngle(-angle);
  if (plus >= minus) tryAngle(angle);
}

/** Принудительно пересчитать мировые матрицы от node вниз до end (родители раньше детей) */
function forceChain(node: TransformNode, end: TransformNode): void {
  const path: TransformNode[] = [];
  let cur: TransformNode | null = end;
  while (cur && cur !== node) {
    path.push(cur);
    cur = cur.parent as TransformNode | null;
  }
  node.computeWorldMatrix(true);
  for (let i = path.length - 1; i >= 0; i--) path[i].computeWorldMatrix(true);
}
