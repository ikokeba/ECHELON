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
        // 頂点は小隊の真の先頭位置とずれる(報告が古いぶん)
        for (const node of co.flot.trace) {
          const men = w.soldiers.filter(
            (s) => s.side === co.side && s.platoonId === node.unitId && s.status === "ok",
          );
          if (men.length === 0) continue;
          const pl = w.platoons.find((p) => p.side === co.side && p.platoonId === node.unitId)!;
          let truth = -Infinity;
          for (const m of men) truth = Math.max(truth, forwardOf(pl.advanceDir, m.pos));
          if (Math.abs(truth - forwardOf(pl.advanceDir, node.pos)) > 2) everDiffered = true;
        }
      }
    }
    expect(sampled).toBeGreaterThan(0);
    expect(everDiffered, "前線が常に真値と一致している = 盤面を直読みしている").toBe(true);
  }, 300000);

  /**
   * `[v6.17]` **前線は直線ではない。** 部下の報告位置を結んだ折れ線なので、部隊が
   * 展開していれば頂点は一直線に乗らない。ここが常に一直線なら、どこかで
   * 「前進フレームでの前方距離」1個に潰している(= 初期配置の軸に固定されている)。
   */
  it("前線は部隊の展開に沿った折れ線になる(直線ではない)", () => {
    const w = createWorld(SCENARIOS.oldQuarter.make(2));
    beginPlanning(w);
    beginBattle(w);
    let maxBend = 0;
    let multiNode = 0;
    for (let t = 0; t < 180 * SIM_HZ; t++) {
      stepWorld(w);
      if (t % (5 * SIM_HZ) !== 0) continue;
      for (const co of w.companies) {
        const tr = co.flot.trace;
        if (tr.length < 3) continue;
        multiNode++;
        // 端点を結んだ直線から中間の頂点がどれだけ外れているか
        const a = tr[0]!.pos;
        const b = tr[tr.length - 1]!.pos;
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        for (let i = 1; i + 1 < tr.length; i++) {
          const p = tr[i]!.pos;
          const off = Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / len;
          maxBend = Math.max(maxBend, off);
        }
      }
    }
    expect(multiNode, "頂点が3つ以上の前線が一度も引かれていない").toBeGreaterThan(0);
    // 実測では数十m膨らむ。10m を下回るなら実質まっすぐ = 潰れている
    expect(maxBend, `前線の凹凸が ${maxBend.toFixed(1)}m しかない`).toBeGreaterThan(10);
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
      // ラベルの入替は陣営名を替えるだけで盤面を動かさないので、対応する部隊の
      // 折れ線は**同じ順・同じ座標**になる。ずれたら側を見て分岐している
      expect(y.flot.trace.length).toBe(x.flot.trace.length);
      x.flot.trace.forEach((n, i) => {
        const m = y.flot.trace[i]!;
        expect(m.unitId).toBe(n.unitId);
        expect(m.pos.x).toBeCloseTo(n.pos.x, 6);
        expect(m.pos.z).toBeCloseTo(n.pos.z, 6);
      });
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
