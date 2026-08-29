/**
 * バランス検証ハーネスの実行入口(`npm run balance`)。
 *
 * 仕様 §14 の「戦力バランス(検証済み)」の表を、実シムと同じ `rollShot` で
 * 引き直す。数値がずれた場合、ずれているのは**仕様の想定か constants の値**であって
 * 検証コードの独自実装ではない — ここに並行実装が存在しないことが要点。
 */

import { baselineTeam, mosTeam, runBatch, type BatchStats } from "./engagement.ts";

const N = Number(process.argv[2] ?? 3000);

function pct(v: number): string {
  return `${v.toFixed(1)}%`.padStart(6);
}

function row(label: string, s: BatchStats): string {
  return [
    label.padEnd(30),
    pct(s.winRateA),
    pct(s.winRateB),
    pct(s.drawRate),
    `${s.avgDurationSec.toFixed(1)}s`.padStart(8),
    s.avgSurvivorsOfWinner.toFixed(2).padStart(7),
    s.avgGrenadeKillsA.toFixed(2).padStart(9),
  ].join(" ");
}

const cases: Array<[string, Parameters<typeof runBatch>[1], Parameters<typeof runBatch>[2]]> = [
  ["対照: 均一 vs 均一", baselineTeam, baselineTeam],
  ["MOS編成 vs 均一4名編成", mosTeam, baselineTeam],
  ["MOS編成 vs MOS編成(対称)", mosTeam, mosTeam],
];

console.log(`\nECHELON バランス検証 — ${N}戦/パターン(仕様 §14)\n`);
console.log(
  [
    "パターン".padEnd(30),
    "A勝率".padStart(6),
    "B勝率".padStart(6),
    "引分".padStart(6),
    "平均時間".padStart(8),
    "生存者".padStart(7),
    "擲弾撃破".padStart(9),
  ].join(" "),
);
console.log("-".repeat(84));

for (const [label, a, b] of cases) {
  console.log(row(label, runBatch(N, a, b)));
}

console.log(
  "\n" +
    [
      "読み方:",
      "  対照が50/50から外れていれば、処理順に由来する先手バイアスが残っている",
      "  (仕様 §14 の検証で実際に発生し、修正された不具合)。",
      "  MOS編成の優位が大きすぎる/小さすぎる場合は constants.ts の係数を調整する。",
    ].join("\n"),
);
