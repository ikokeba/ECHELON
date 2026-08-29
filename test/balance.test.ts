import { describe, it, expect } from "vitest";
import {
  baselineTeam,
  mosTeam,
  runBatch,
  simulateBattle,
} from "../src/balance/engagement.ts";

/**
 * バランス検証ハーネス(仕様 §14「戦力バランス(検証済み)」)。
 *
 * `mos-balance-simulator.jsx` が出した確定値を、**実シムと同じ `rollShot`** で
 * 引き直して再現できるかを見る。ここが崩れたときに疑うべきは constants.ts の係数か
 * 仕様の想定であって、検証コードの独自実装ではない — 並行実装が存在しないため。
 */
describe("戦力バランス検証(仕様 §14)", () => {
  const N = 3000;

  it("同一編成・同一乱数なら必ず相打ちになる — 先手バイアスの構造的な不在", () => {
    // 勝率の統計より強い主張。処理順のどこかに片側だけ先に効く経路があれば、
    // 完全に同じ入力を与えても結果が非対称になる。
    // (仕様 §14 の検証では、対照実験でも先攻側が約54.5%勝つ不具合が見つかっている)
    for (let seed = 1; seed <= 20; seed++) {
      const r = simulateBattle(seed, baselineTeam, baselineTeam, { mirrored: true });
      expect(r.winner, `seed ${seed}`).toBe("draw");
      expect(r.survivorsA).toBe(r.survivorsB);
    }
  });

  it("対照実験(均一 vs 均一)はほぼ50/50", () => {
    const s = runBatch(N, baselineTeam, baselineTeam);
    expect(s.winRateA).toBeGreaterThan(46);
    expect(s.winRateA).toBeLessThan(54);
  }, 60000);

  it("MOS編成は均一編成に対して優位だが、過度ではない(仕様 §14: 約58% vs 約42%)", () => {
    const s = runBatch(N, mosTeam, baselineTeam);
    expect(s.winRateA).toBeGreaterThan(52);
    expect(s.winRateA).toBeLessThan(65);
  }, 60000);

  it("MOS編成同士は約50/50を維持する(編成が対称なら偏らない)", () => {
    const s = runBatch(N, mosTeam, mosTeam);
    expect(s.winRateA).toBeGreaterThan(46);
    expect(s.winRateA).toBeLessThan(54);
  }, 60000);

  it("擲弾の貢献は1戦あたり0.3体前後(仕様 §14 の検証値)", () => {
    const s = runBatch(N, mosTeam, baselineTeam);
    // 小銃による擲弾手の戦果と混ざっていないこと。混ざると1体近くまで膨らむ
    expect(s.avgGrenadeKillsA).toBeGreaterThan(0.15);
    expect(s.avgGrenadeKillsA).toBeLessThan(0.6);
    // 均一編成には擲弾手がいないので0でなければならない
    const control = runBatch(500, baselineTeam, baselineTeam);
    expect(control.avgGrenadeKillsA).toBe(0);
  }, 60000);

  it("同じ引数なら何度回しても同じ結果になる(検証の再現性)", () => {
    const a = runBatch(300, mosTeam, baselineTeam);
    const b = runBatch(300, mosTeam, baselineTeam);
    expect(a).toEqual(b);
  }, 30000);
});
