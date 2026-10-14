/**
 * Таблица баланса: печатает базовые показатели модели, выведенные величины
 * улучшений, худшие сборки и проверяет инварианты (код возврата 1 при нарушении).
 * Запуск: npm run balance
 */

import {
  BASE_STATS,
  GADGET_BUDGET,
  GADGET_DEFS,
  NORMAL_BUDGET,
  PERK_DEFS,
  SLIGHT_BUDGET,
  SLIGHT_DEFS,
  SLIGHT_MAX_PER_DEF,
  SLIGHT_MAX_STACKS,
  computeStats,
  duelAdvantage,
  magazine,
  power,
  ttk,
  type Loadout,
} from "../src/shared/balance";

/** Потолок силы худшей допустимой сборки (все лёгкие стопки + лучший перк), без гаджета */
const MAX_BUILD_POWER = 0.4;

const pc = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
let failed = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${msg}`);
  if (!ok) failed++;
};

// ---------- База ----------
const mag = magazine(BASE_STATS);
console.log("== База ==");
console.log(`магазин: ${mag.shots.toFixed(2)} выстрелов, блокировка ${mag.lock} с, период ${mag.period.toFixed(2)} с`);
for (const d of [8, 20, 40]) console.log(`TTK на ${String(d).padStart(2)} ю: ${ttk(BASE_STATS, BASE_STATS, d).toFixed(2)} с`);
check(Math.abs(duelAdvantage(BASE_STATS) - 1) < 1e-9, "база против базы: R = 1");

// ---------- Лёгкие ----------
console.log(`\n== Лёгкие улучшения (бюджет ${pc(SLIGHT_BUDGET)} за стопку) ==`);
for (const d of SLIGHT_DEFS) console.log(`${d.id.padEnd(9)} x=${(d.x * 100).toFixed(1).padStart(5)}%   ${pc(d.power).padStart(7)}   ${d.title}: ${d.desc}`);
const skipped = ["rate", "mana", "regen", "reload", "velocity", "thrift", "agility"].filter((id) => !SLIGHT_DEFS.some((d) => d.id === id));
if (skipped.length) console.log(`не вошли в пул (не дают бюджет даже при x=100%): ${skipped.join(", ")}`);
for (const d of SLIGHT_DEFS) check(Math.abs(d.power - SLIGHT_BUDGET) < 0.002, `${d.id}: вклад ${pc(d.power)} ≈ бюджет`);

// ---------- Нормальные ----------
console.log(`\n== Нормальные перки (бюджет ${pc(NORMAL_BUDGET)}) ==`);
for (const d of PERK_DEFS) console.log(`${d.id.padEnd(9)} 1 к ${String(d.oneIn).padEnd(3)} (${(d.chance * 100).toFixed(1)}%)   ${pc(d.power).padStart(7)}   ${d.title}: ${d.desc}`);
for (const d of PERK_DEFS) check(Math.abs(d.power - NORMAL_BUDGET) < NORMAL_BUDGET * 0.2, `${d.id}: вклад ${pc(d.power)} в пределах ±20% бюджета (округление до «1 к N»)`);

// ---------- Гаджеты ----------
console.log(`\n== Гаджеты (бюджет ${GADGET_BUDGET} «сила×с») ==`);
for (const d of GADGET_DEFS) console.log(`${d.id.padEnd(9)} сила ${pc(d.power).padStart(7)} × ${String(d.duration).padStart(2)} с = ${(d.power * d.duration).toFixed(1).padStart(5)}   ${d.title}: ${d.desc}`);

// ---------- Худшие сборки ----------
console.log("\n== Худшие сборки ==");
const ids = SLIGHT_DEFS.map((d) => d.id);
let best = { p: -1, slight: {} as Record<string, number> };
let count = 0;
let sum = 0;
function walk(i: number, left: number, cur: Record<string, number>): void {
  if (i === ids.length) {
    const l: Loadout = { slight: cur, perks: [], gadget: null };
    const p = power(computeStats(l));
    count++;
    sum += p;
    if (p > best.p) best = { p, slight: { ...cur } };
    return;
  }
  for (let n = 0; n <= Math.min(SLIGHT_MAX_PER_DEF, left); n++) {
    if (n) cur[ids[i]] = n;
    else delete cur[ids[i]];
    walk(i + 1, left - n, cur);
  }
  delete cur[ids[i]];
}
walk(0, SLIGHT_MAX_STACKS, {});
console.log(`лёгкие: ${count} сборок, средняя ${pc(sum / count)}, лучшая ${pc(best.p)} ${JSON.stringify(best.slight)}`);
const naive = Math.pow(1 + SLIGHT_BUDGET, SLIGHT_MAX_STACKS) - 1;
console.log(`(аддитивная оценка ${SLIGHT_MAX_STACKS}×${pc(SLIGHT_BUDGET)} = ${pc(naive)} — синергии между стопками видны по разнице)`);
let worst = best.p;
let worstName = "лёгкие";
for (const pk of PERK_DEFS) {
  const p = power(computeStats({ slight: best.slight, perks: [pk.id], gadget: null }));
  console.log(`лучшие лёгкие + ${pk.id.padEnd(8)} ${pc(p)}`);
  if (p > worst) {
    worst = p;
    worstName = `лёгкие + ${pk.id}`;
  }
}
console.log(`лучшие лёгкие + ВСЕ перки сразу ${pc(power(computeStats({ slight: best.slight, perks: PERK_DEFS.map((d) => d.id), gadget: null })))} (по одному каждого; стаки растут дальше до пределов clampStats)`);
check(worst <= MAX_BUILD_POWER, `худшая сборка без гаджета (${worstName}) ${pc(worst)} ≤ ${pc(MAX_BUILD_POWER)}`);
for (const g of GADGET_DEFS) {
  const p = power(computeStats({ slight: best.slight, perks: [], gadget: g.id }));
  console.log(`лучшие лёгкие + гаджет ${g.id.padEnd(7)} ${pc(p)} (на ${g.duration} с)`);
}

console.log(failed ? `\nНарушений: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
