import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import {
  applyDeployment,
  defaultDeploymentOf,
  DEPLOY_MARGIN,
  isPointSymmetric,
  mirrorPlan,
  type DeploymentPlan,
} from "../src/sim/deployment.ts";
import { OBJECTIVE } from "../src/sim/constants.ts";
import type { Scenario, Side } from "../src/sim/types.ts";

/** 同一陣営内の兵士どうしの距離を並べる(隊形が保たれているかの指紋)。 */
function pairwise(sc: Scenario, side: Side): number[] {
  const men = sc.soldiers.filter((s) => s.side === side);
  const out: number[] = [];
  for (let i = 0; i < men.length; i++) {
    for (let j = i + 1; j < Math.min(men.length, i + 4); j++) {
      out.push(Math.hypot(men[i]!.pos.x - men[j]!.pos.x, men[i]!.pos.z - men[j]!.pos.z));
    }
  }
  return out;
}

/**
 * 配置プラン(`[v6.4]`)。初期展開位置と拠点をプレイヤーが決められるようにしたもの。
 * 最重要の性質は「隊形を壊さない」ことと「点対称に置けば対称性が保たれる」こと。
 */
describe("配置プラン(`[v6.4]`)", () => {
  it("既定のプランを適用しても盤面は変わらない", () => {
    const base = companyClashScenario(1);
    const plan = defaultDeploymentOf(base);
    const out = applyDeployment(companyClashScenario(1), plan);
    for (let i = 0; i < base.soldiers.length; i++) {
      expect(out.soldiers[i]!.pos.x).toBeCloseTo(base.soldiers[i]!.pos.x, 6);
      expect(out.soldiers[i]!.pos.z).toBeCloseTo(base.soldiers[i]!.pos.z, 6);
    }
    expect(isPointSymmetric(plan)).toBe(true);
  });

  it("展開点を動かしても隊形(隊員間の距離)は保たれる", () => {
    const base = platoonClashScenario(1);
    const before = pairwise(base, "blue");
    const plan = defaultDeploymentOf(base);
    plan.spawn.blue = { pos: { x: 40, z: -20 }, facing: { x: -1, z: 0.4 } };
    const out = applyDeployment(platoonClashScenario(1), plan);

    const after = pairwise(out, "blue");
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]!).toBeCloseTo(before[i]!, 6);

    // 重心が指定した地点へ来ていること
    const men = out.soldiers.filter((s) => s.side === "blue");
    const cx = men.reduce((a, s) => a + s.pos.x, 0) / men.length;
    const cz = men.reduce((a, s) => a + s.pos.z, 0) / men.length;
    expect(cx).toBeCloseTo(40, 3);
    expect(cz).toBeCloseTo(-20, 3);

    // 赤には触れていない
    const redBefore = pairwise(base, "red");
    const redAfter = pairwise(out, "red");
    for (let i = 0; i < redBefore.length; i++) expect(redAfter[i]!).toBeCloseTo(redBefore[i]!, 6);
  });

  it("盤外へは置けない(ナビグリッドの外は到達不能になるため)", () => {
    const base = companyClashScenario(1);
    const plan = defaultDeploymentOf(base);
    plan.spawn.blue = { pos: { x: 9999, z: -9999 }, facing: { x: 0, z: 1 } };
    const out = applyDeployment(companyClashScenario(1), plan);
    const men = out.soldiers.filter((s) => s.side === "blue");
    const cx = men.reduce((a, s) => a + s.pos.x, 0) / men.length;
    expect(cx).toBeLessThanOrEqual(base.bounds.maxX - DEPLOY_MARGIN + 1e-6);
    for (const s of out.soldiers) {
      expect(s.pos.x).toBeGreaterThanOrEqual(base.bounds.minX);
      expect(s.pos.x).toBeLessThanOrEqual(base.bounds.maxX);
      expect(s.pos.z).toBeGreaterThanOrEqual(base.bounds.minZ);
      expect(s.pos.z).toBeLessThanOrEqual(base.bounds.maxZ);
    }
  });

  /**
   * 仕様 §2/§13。点対称に置いたなら、そこから先も点対称でなければならない。
   * 「陣営ラベルを入れ替える」既存のテストでは**誰も動かない**ので、
   * 配置に起因する非対称はそちらでは絶対に捕まらない。ここで別に見る。
   */
  it("点対称に置けば、鏡像の兵士どうしが厳密に反転した位置に立つ", () => {
    const base = platoonClashScenario(1);
    const plan = mirrorPlan({
      spawn: { blue: { pos: { x: -30, z: -50 }, facing: { x: 0.3, z: 1 } } },
      objectives: defaultDeploymentOf(base).objectives,
    });
    expect(isPointSymmetric(plan)).toBe(true);
    const out = applyDeployment(platoonClashScenario(1), plan);

    const blue = out.soldiers.filter((s) => s.side === "blue");
    const red = out.soldiers.filter((s) => s.side === "red");
    expect(blue.length).toBe(red.length);
    // 編成上の通し番号(ordinal)が一致する2人が鏡像の関係にある
    for (const b of blue) {
      const r = red.find((s) => s.ordinal === b.ordinal && s.hqRole === b.hqRole);
      if (!r) continue;
      expect(r.pos.x).toBeCloseTo(-b.pos.x, 6);
      expect(r.pos.z).toBeCloseTo(-b.pos.z, 6);
      expect(r.facing.x).toBeCloseTo(-b.facing.x, 6);
      expect(r.facing.z).toBeCloseTo(-b.facing.z, 6);
    }
  });

  it("非対称な配置は非対称だと判定される", () => {
    const plan: DeploymentPlan = {
      spawn: {
        blue: { pos: { x: 0, z: -50 }, facing: { x: 0, z: 1 } },
        red: { pos: { x: 30, z: 50 }, facing: { x: 0, z: -1 } },
      },
      objectives: null,
    };
    expect(isPointSymmetric(plan)).toBe(false);
  });

  it("拠点を置き換えると、各階層の任務目標が新しい拠点へ向く", () => {
    const plan: DeploymentPlan = {
      spawn: {},
      objectives: [
        { label: "OBJ 北", pos: { x: 60, z: 60 }, radius: OBJECTIVE.ROOM_RADIUS },
        { label: "OBJ 南", pos: { x: -60, z: -60 }, radius: OBJECTIVE.ROOM_RADIUS },
      ],
    };
    const out = applyDeployment(companyClashScenario(1), plan);
    expect(out.objectives!.length).toBe(2);
    expect(out.objectives!.map((o) => o.label)).toEqual(["OBJ 北", "OBJ 南"]);
    for (const p of out.companyPlans ?? []) {
      const onAnObjective = out.objectives!.some(
        (o) => Math.hypot(o.pos.x - p.objective.x, o.pos.z - p.objective.z) < 1e-6,
      );
      expect(onAnObjective).toBe(true);
    }
    // 実際に世界が組め、走る
    const w = createWorld(out);
    expect(w.objectives.length).toBe(2);
    runTicks(w, 60);
    expect(w.soldiers.length).toBeGreaterThan(0);
  });

  it("配置を変えたシナリオでも決定性が保たれる(同じ入力 → 同じ結果)", () => {
    const plan: DeploymentPlan = {
      spawn: {
        blue: { pos: { x: -20, z: -60 }, facing: { x: 0.2, z: 1 } },
        red: { pos: { x: 20, z: 60 }, facing: { x: -0.2, z: -1 } },
      },
      objectives: null,
    };
    const run = (): string => {
      const w = createWorld(applyDeployment(platoonClashScenario(4), plan));
      runTicks(w, 600);
      return w.soldiers.map((s) => `${s.pos.x.toFixed(6)},${s.pos.z.toFixed(6)},${s.status}`).join("|");
    };
    expect(run()).toBe(run());
  });
});
