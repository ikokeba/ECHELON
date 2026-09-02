import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { DOCTRINES, DOCTRINE_KEYS, type Doctrine } from "../src/sim/doctrine.ts";
import { RADIO_LATENCY_SEC, SIM_HZ } from "../src/sim/constants.ts";
import type { Scenario, Side } from "../src/sim/types.ts";

/**
 * 陣営のドクトリン(指揮文化)プリセット。`[v6.8]` 仕様 §13。
 *
 * 検証したいのは3点:
 *   1. 既定(`regular`)は**全係数 identity** で、現行の挙動と1ビットも変わらないこと
 *   2. プリセットが実際に指揮の効き方を変えていること(効かない設定は無意味)
 *   3. 左右で違うドクトリンを与えても、**陣営ラベルを見た分岐が生まれていない**こと
 *
 * 3点目の測り方に注意。仕様 §2/§13 が要求しているのは「コードに陣営を優遇する分岐が
 * 無いこと」であって、対称な地形で結果が幾何的に鏡像になることではない
 * (経路探索の等コスト決着などに由来する開始位置の偏りは既知 — `test/symmetry.test.ts`
 * の末尾を参照)。実際、既定のドクトリンでも中隊マップの損害は90秒あたりから
 * 左右でずれ始める。したがってここも `symmetry.test.ts` と同じ**ラベル入替**で見る:
 * 陣営ラベルとドクトリンを同時に入れ替えたら、結果がそのまま反転すること。
 */
const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");

/** 配置は変えずに陣営ラベルだけ入れ替える(`symmetry.test.ts` と同じ操作)。 */
function swapSides(sc: Scenario): Scenario {
  for (const s of sc.soldiers) s.side = flip(s.side);
  for (const p of sc.fireteamPlans ?? []) p.side = flip(p.side);
  for (const p of sc.squadPlans ?? []) p.side = flip(p.side);
  for (const p of sc.platoonPlans ?? []) p.side = flip(p.side);
  for (const p of sc.companyPlans ?? []) p.side = flip(p.side);
  if (sc.ccp) sc.ccp = { blue: sc.ccp.red, red: sc.ccp.blue };
  return sc;
}

function kiaWith(
  sc: Scenario,
  doctrine: Record<Side, Doctrine>,
  ticks: number,
): Record<Side, number> {
  const w = createWorld(sc);
  w.doctrine.blue = doctrine.blue;
  w.doctrine.red = doctrine.red;
  runTicks(w, ticks);
  return {
    blue: w.soldiers.filter((s) => s.side === "blue" && s.status === "kia").length,
    red: w.soldiers.filter((s) => s.side === "red" && s.status === "kia").length,
  };
}

function positionsAfter(ticks: number, d?: Doctrine): string[] {
  const w = createWorld(platoonClashScenario(1));
  if (d) {
    w.doctrine.blue = d;
    w.doctrine.red = d;
  }
  runTicks(w, ticks);
  return w.soldiers.map((s) => `${s.id}:${s.pos.x.toFixed(4)}:${s.pos.z.toFixed(4)}:${s.status}`);
}

describe("陣営のドクトリン(仕様 §13)`[v6.8]`", () => {
  it("既定は両陣営 regular で、全係数が identity", () => {
    const w = createWorld(platoonClashScenario(1));
    expect(w.doctrine.blue).toBe(DOCTRINES.regular);
    expect(w.doctrine.red).toBe(DOCTRINES.regular);
    const r = DOCTRINES.regular;
    expect(r.decideMul).toEqual({ company: 1, platoon: 1, squad: 1 });
    expect(r.radioLatencyMul).toBe(1);
    expect(r.reportIntervalMul).toBe(1);
    expect(r.initiative).toBe(0);
    expect(r.riskTolerance).toBe(0.5);
  });

  it("regular を明示しても、既定のままと結果が1ビットも変わらない", () => {
    expect(positionsAfter(600, DOCTRINES.regular)).toEqual(positionsAfter(600));
  }, 120000);

  it("プリセットを変えると挙動が変わる(効かない設定になっていない)", () => {
    const base = positionsAfter(600);
    for (const key of DOCTRINE_KEYS.filter((k) => k !== "regular")) {
      expect(positionsAfter(600, DOCTRINES[key]), `${key} が現行と同じ結果`).not.toEqual(base);
    }
  }, 240000);

  it("係数は1つずつ効いている(どれも死んでいない)", () => {
    const base = positionsAfter(600);
    const m = DOCTRINES.militia;
    const only: Array<[string, Doctrine]> = [
      ["decideMul", { ...DOCTRINES.regular, decideMul: m.decideMul }],
      ["radioLatencyMul", { ...DOCTRINES.regular, radioLatencyMul: m.radioLatencyMul }],
      ["reportIntervalMul", { ...DOCTRINES.regular, reportIntervalMul: m.reportIntervalMul }],
      ["initiative", { ...DOCTRINES.regular, initiative: m.initiative }],
    ];
    for (const [name, d] of only) {
      expect(positionsAfter(600, d), `${name} が効いていない`).not.toEqual(base);
    }
  }, 300000);

  it("左右で違うドクトリンでも、ラベルとドクトリンを入れ替えれば結果は反転する(仕様 §2/§13)", () => {
    // 陣営ラベルを見た分岐が入っていれば、ここがずれる
    const ticks = 3000;
    const normal = kiaWith(platoonClashScenario(1), {
      blue: DOCTRINES.militia,
      red: DOCTRINES.regular,
    }, ticks);
    const swapped = kiaWith(swapSides(platoonClashScenario(1)), {
      blue: DOCTRINES.regular,
      red: DOCTRINES.militia,
    }, ticks);
    expect(swapped.blue).toBe(normal.red);
    expect(swapped.red).toBe(normal.blue);
  }, 300000);

  it("無線の遅延倍率が、実際に報告の到達時刻へ乗る(仕様 §5)", () => {
    const latencyOf = (d: Doctrine): number => {
      const w = createWorld(platoonClashScenario(1));
      w.doctrine.blue = d;
      w.doctrine.red = d;
      // 報告は届いた時点で `world.reports` から消えるので、**飛んでいる最中**を捉える。
      // 報告間隔もドクトリンで変わる(疎になる)ので、固定のティック数では掴めない
      let r: { deliverTick: number; sentTick: number } | undefined;
      for (let t = 0; t < 60 * SIM_HZ && !r; t++) {
        runTicks(w, 1);
        r = w.reports.find((x) => x.fromEchelon === "squad");
      }
      expect(r, "分隊からの報告が1件も出ていない").toBeDefined();
      return r!.deliverTick - r!.sentTick;
    };
    const plain = latencyOf(DOCTRINES.regular);
    expect(plain).toBe(Math.round(RADIO_LATENCY_SEC * SIM_HZ));
    expect(latencyOf(DOCTRINES.swarm)).toBeGreaterThan(plain);
    expect(latencyOf(DOCTRINES.militia)).toBeGreaterThan(plain);
  });
});
