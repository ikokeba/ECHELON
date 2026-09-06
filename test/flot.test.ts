import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { SCENARIOS, type ScenarioKey } from "../src/sim/scenario.ts";
import { forwardOf } from "../src/sim/c2/flot.ts";
import { SIM_HZ } from "../src/sim/constants.ts";
import type { Side } from "../src/sim/types.ts";

/**
 * 前線(FLOT)と統合・再編(`[v6.16]` 仕様 §5/§6/§11)。
 *
 * 米陸軍の FLOT(ADP 1-02 / FM 3-90)と consolidation & reorganization
 * (ATP 3-21.8)を実装したもの。ここで固定するのは4つ:
 *
 *   1. **前線は報告からしか引かれない**(仕様 §5)。盤面の真値ではない
 *   2. 前進フレームで持つので、陣営ラベルの入替で厳密に反転する(仕様 §2/§13)
 *   3. 拠点を確保した小隊は統合・再編に入り、逆襲の予想方向へ正対する
 *   4. 統合中でない小隊は統合しない(奪ってもいない拠点で足を止めない)
 */

function battle(seed = 1) {
  const w = createWorld(companyClashScenario(seed));
  beginPlanning(w);
  beginBattle(w);
  return w;
}

describe("前線と統合・再編(`[v6.16]`)", () => {
  /**
   * 中隊長の線は必ず**過去のもの**で、盤面の真値と一致しない。ここが一致したら
   * どこかで `world.soldiers` を直読みしている。
   */
  it("前線は報告由来で、盤面の真値より古い(仕様 §5)", () => {
    const w = battle(1);
    let sampled = 0;
    let everDiffered = false;
    for (let t = 0; t < 240 * SIM_HZ; t++) {
      stepWorld(w);
      if (t % (10 * SIM_HZ) !== 0) continue;
      for (const co of w.companies) {
        if (co.flot.sources === 0) continue;
        sampled++;
        // 線の根拠は送信済みの報告なので、必ず現在ティックより前
        expect(co.flot.asOfTick).toBeLessThan(w.tick);
        // 真の「前から2番目の小隊重心」と比べる
        const fwd = w.platoons
          .filter((p) => p.side === co.side)
          .map((p) => {
            const m = w.soldiers.filter(
              (s) => s.side === p.side && s.platoonId === p.platoonId && s.status === "ok",
            );
            if (m.length === 0) return -Infinity;
            return forwardOf(p.advanceDir, {
              x: m.reduce((a, s) => a + s.pos.x, 0) / m.length,
              z: m.reduce((a, s) => a + s.pos.z, 0) / m.length,
            });
          })
          .sort((a, b) => b - a);
        const truth = fwd.length >= 2 ? fwd[1]! : fwd[0]!;
        if (Number.isFinite(truth) && Math.abs(truth - co.flot.forward) > 2) everDiffered = true;
      }
    }
    expect(sampled).toBeGreaterThan(0);
    expect(everDiffered, "前線が常に真値と一致している = 盤面を直読みしている").toBe(true);
  }, 300000);

  /**
   * 前線を世界座標の z で持つと、点対称の盤面で両陣営の「前」が逆になり、
   * 比較がそのまま反転しない。前進フレームで持っていることの確認。
   */
  it("陣営ラベルの入替に対し前線が厳密に反転する(仕様 §2/§13)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const base = companyClashScenario(5);
    const swapped = companyClashScenario(5);
    for (const s of swapped.soldiers) s.side = flip(s.side);
    for (const p of swapped.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.squadPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.companyPlans ?? []) p.side = flip(p.side);
    if (swapped.ccp) swapped.ccp = { blue: swapped.ccp.red, red: swapped.ccp.blue };

    const a = createWorld(base);
    const b = createWorld(swapped);
    runTicks(a, 90 * SIM_HZ);
    runTicks(b, 90 * SIM_HZ);
    const co = (w: typeof a, side: Side) => w.companies.find((c) => c.side === side)!;
    for (const [x, y] of [
      [co(a, "blue"), co(b, "red")],
      [co(a, "red"), co(b, "blue")],
    ] as const) {
      expect(y.flot.sources).toBe(x.flot.sources);
      expect(y.flot.forward).toBeCloseTo(x.flot.forward, 6);
      expect(y.flot.lead).toBeCloseTo(x.flot.lead, 6);
    }
  }, 300000);

  /**
   * 統合・再編(ATP 3-21.8)。**拠点を確保して初めて入る**段階なので、
   * 入っている小隊は必ずその拠点を自軍が保有している。
   */
  it("統合・再編に入るのは自軍が確保した拠点を守る小隊だけ(ATP 3-21.8)", () => {
    let entered = 0;
    for (const key of ["oldQuarter", "bazaar"] as ScenarioKey[]) {
      const w = createWorld(SCENARIOS[key].make(2));
      beginPlanning(w);
      beginBattle(w);
      for (let t = 0; t < 240 * SIM_HZ; t++) {
        stepWorld(w);
        if (t % SIM_HZ !== 0) continue;
        for (const pl of w.platoons) {
          const c = pl.consolidation;
          if (!c) continue;
          entered++;
          const o = w.objectives.find((x) => x.id === c.objectiveId);
          expect(o, "統合の対象が実在する拠点でない").toBeTruthy();
          expect(o!.owner, `${pl.side} が保有していない拠点で統合している`).toBe(pl.side);
          // 警戒方向は単位ベクトル
          expect(Math.hypot(c.watch.x, c.watch.z)).toBeCloseTo(1, 6);
        }
      }
    }
    expect(entered, "どの盤面でも統合・再編に入らない").toBeGreaterThan(0);
  }, 300000);

  /**
   * 逆。**まだ誰も確保していない盤面では誰も統合しない** — 奪ってもいない拠点で
   * 足を止めたら、それは統合ではなく単なる停止になる。
   */
  it("確保が起きるまでは誰も統合・再編に入らない", () => {
    const w = battle(3);
    for (let t = 0; t < 60 * SIM_HZ; t++) {
      stepWorld(w);
      if (w.objectives.some((o) => o.owner !== null)) return; // 確保が起きたらそこまで
      expect(w.platoons.every((p) => p.consolidation === null)).toBe(true);
    }
  }, 300000);
});
