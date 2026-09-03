import { describe, it, expect } from "vitest";
import { COMMON_SLIDERS, POSTURE_KNOBS } from "../src/ui/tuningDefs.ts";
import { postureFromRisk } from "../src/sim/tuning.ts";
import { DEFAULT_TUNING_UI } from "../src/ui/store.ts";

/**
 * デバッグスライダーの範囲が、定数の既定値を含んでいることの確認。`[v6.9]`
 *
 * これが要るのは、スライダーの範囲と `constants.ts` の値が別々に育つため。
 * 実際、索敵距離のスライダーは上限 40 のまま残っていて、仕様 §10 の射程を本来の値へ
 * 戻して `DETECT_RANGE` が 150 になった時点で右端に張り付いていた。
 *
 * 見た目だけの問題では済まない。`<input type="range">` は範囲外の値を**表示上だけ**
 * 丸めるので、つまむまでシムは 150 のまま動く。つまんだ瞬間に 40 以下へ落ちて
 * 索敵距離が 1/4 になり、しかも既定へ戻す方法が「リセット」しかない。
 */
describe("デバッグスライダーの範囲(`[v6.9]`)", () => {
  it.each(COMMON_SLIDERS)("$label の範囲が既定値を含む", (def) => {
    const v = DEFAULT_TUNING_UI[def.key];
    expect(def.min).toBeLessThan(def.max);
    expect(v).toBeGreaterThanOrEqual(def.min);
    expect(v).toBeLessThanOrEqual(def.max);
  });

  it("既定値がスライダーの端に張り付いていない(範囲の取り直しが要る合図)", () => {
    for (const def of COMMON_SLIDERS) {
      const v = DEFAULT_TUNING_UI[def.key];
      const frac = (v - def.min) / (def.max - def.min);
      expect.soft(frac, `${def.label} は既定値が端に寄りすぎている`).toBeGreaterThan(0.02);
      expect.soft(frac, `${def.label} は既定値が端に寄りすぎている`).toBeLessThan(0.98);
    }
  });
});

/**
 * 陣営別の性格パラメータも同じ理由で見張る。こちらは既定値が「identity(倍率1 /
 * 絶対値=定数)」であることに意味があるので、`postureFromRisk(0.5)` の返す値が
 * 範囲の内側にあることを確かめる(仕様 §13 の「既定は現行と一致」を守るため)。
 */
describe("性格パラメータのスライダー範囲(`[v6.9]`)", () => {
  const identity = postureFromRisk(0.5);
  it.each(POSTURE_KNOBS)("$label の範囲が identity 値を含む", (def) => {
    const v = identity[def.key];
    expect(def.min).toBeLessThan(def.max);
    expect(v).toBeGreaterThanOrEqual(def.min);
    expect(v).toBeLessThanOrEqual(def.max);
  });
});
