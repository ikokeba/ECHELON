import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import {
  activeTaskOf,
  beginBattle,
  beginPlanning,
  planOperation,
} from "../src/sim/c2/planning.ts";
import type { OperationPlan, PlanTask, Side } from "../src/sim/types.ts";

/**
 * 戦闘前の作戦立案(`[v6.5]` 仕様 §3① / §11)。
 *
 * 検証したいのは4点:
 *   1. 立案フェーズでは時間が流れないこと(`stepWorld` が何もしない)
 *   2. 中隊長が全拠点に小隊を割り当て、主攻を1つだけ指名すること
 *   3. **点対称の盤面では両陣営の計画が厳密な鏡像になること**(仕様 §2/§13)
 *   4. 立てた計画が実際に麾下を動かすこと(飾りではないこと)
 */

function planOf(side: Side, seed = 1): OperationPlan {
  const w = createWorld(companyClashScenario(seed));
  const co = w.companies.find((c) => c.side === side)!;
  return planOperation(w, co);
}

/** 小隊idの下2桁 = 自軍の中での通し番号。鏡像の小隊どうしで一致する。 */
function ordinalOf(t: PlanTask): number {
  return t.platoonId % 100;
}

describe("作戦立案フェーズ(`[v6.5]`)", () => {
  it("立案中は時間が流れない — stepWorld が何もしない", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    expect(w.phase).toBe("planning");
    const before = w.soldiers.map((s) => ({ x: s.pos.x, z: s.pos.z }));
    runTicks(w, 120);
    expect(w.tick).toBe(0);
    for (let i = 0; i < w.soldiers.length; i++) {
      expect(w.soldiers[i]!.pos.x).toBe(before[i]!.x);
      expect(w.soldiers[i]!.pos.z).toBe(before[i]!.z);
    }
    // 開始すれば普通に進む
    beginBattle(w);
    stepWorld(w);
    expect(w.tick).toBe(1);
  });

  it("createWorld の既定は戦闘フェーズ — テストとバランスハーネスは立案を挟まない", () => {
    const w = createWorld(platoonClashScenario(1));
    expect(w.phase).toBe("battle");
    expect(w.companies.every((c) => c.plan === null)).toBe(true);
    stepWorld(w);
    expect(w.tick).toBe(1);
  });

  it("全ての拠点に小隊が割り当てられ、主攻はちょうど1個小隊", () => {
    for (const side of ["blue", "red"] as Side[]) {
      const plan = planOf(side);
      expect(plan.tasks).toHaveLength(3); // 3個小隊
      const mains = plan.tasks.filter((t) => t.role === "main");
      expect(mains).toHaveLength(1);
      // 3個の拠点が重複なく割り当てられている
      const objIds = plan.tasks.map((t) => t.objectiveId).filter((x): x is number => x !== null);
      expect(new Set(objIds).size).toBe(3);
      // 主攻は「争奪の中心に最も近い拠点」= 中央広場の OBJ BRAVO
      expect(plan.mainObjectiveId).toBe(mains[0]!.objectiveId);
      const main = plan.tasks.find((t) => t.role === "main")!;
      expect(main.order).toContain("主攻");
    }
  });

  it("接近経路は出発地点から目標まで通っていて、盤内に収まる", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    const plan = planOperation(w, co);
    for (const t of plan.tasks) {
      expect(t.route.length).toBeGreaterThanOrEqual(2);
      const last = t.route[t.route.length - 1]!;
      expect(Math.hypot(last.x - t.mission.target.x, last.z - t.mission.target.z)).toBeLessThan(2);
      for (const p of t.route) {
        expect(p.x).toBeGreaterThanOrEqual(w.bounds.minX);
        expect(p.x).toBeLessThanOrEqual(w.bounds.maxX);
        expect(p.z).toBeGreaterThanOrEqual(w.bounds.minZ);
        expect(p.z).toBeLessThanOrEqual(w.bounds.maxZ);
      }
    }
  });

  /**
   * 仕様 §2/§13。中隊マップは点対称なので、両陣営の計画も点対称でなければ
   * 「地形由来ではない有利不利」になる。
   *
   * ここが落ちる典型は**順序づけを世界座標で行った**とき。拠点配列の順に処理すると、
   * ALPHA と CHARLIE が争奪の中心から等距離(完全な同値)なので両陣営とも ALPHA を
   * 先に取り、鏡像にならない。順序はすべて自陣営の前進フレームで決めること。
   */
  it("点対称の盤面では、両陣営の計画が厳密な鏡像になる(仕様 §2/§13)", () => {
    const blue = planOf("blue");
    const red = planOf("red");
    expect(red.tasks).toHaveLength(blue.tasks.length);

    // 拠点の座標表は1度だけ引く(盤面の構築は市街地マップだと秒単位で効く)
    const objectives = createWorld(companyClashScenario(1)).objectives;
    const objOf = (id: number | null): { x: number; z: number } | null =>
      id === null ? null : (objectives.find((x) => x.id === id)?.pos ?? null);

    for (const bt of blue.tasks) {
      const rt = red.tasks.find((t) => ordinalOf(t) === ordinalOf(bt));
      expect(rt, `鏡像の小隊 ${ordinalOf(bt)} が見つからない`).toBeDefined();
      // 役割と任務種別は一致
      expect(rt!.role).toBe(bt.role);
      expect(rt!.mission.kind).toBe(bt.mission.kind);
      // 割り当てられた拠点は点対称の位置にある
      const bo = objOf(bt.objectiveId);
      const ro = objOf(rt!.objectiveId);
      expect(bo).not.toBeNull();
      expect(ro).not.toBeNull();
      expect(Math.abs(bo!.x + ro!.x)).toBeLessThan(1e-6);
      expect(Math.abs(bo!.z + ro!.z)).toBeLessThan(1e-6);
    }
  });

  it("立てた計画が実際に麾下を動かす — 小隊は計画の拠点へ向かう", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    const co = w.companies.find((c) => c.side === "blue")!;
    const plan = co.plan!;
    // 下達の時点で各小隊の任務目標が計画のものになっている
    for (const t of plan.tasks) {
      const pl = w.platoons.find((p) => p.side === "blue" && p.platoonId === t.platoonId)!;
      expect(pl.objective.x).toBeCloseTo(t.mission.target.x, 6);
      expect(pl.objective.z).toBeCloseTo(t.mission.target.z, 6);
    }

    // 戦闘に入り、中隊長の判断周期を何度も回しても割り当てが保たれること。
    // 接敵すると担当区域が脅威の方向へ振れるが、計画の拠点は手放さない
    // (side方向の拠点が最後まで中立で残る、という F-9 への答え)。
    beginBattle(w);
    const before = plan.tasks.map((t) => ({
      id: t.platoonId,
      target: { ...t.mission.target },
    }));
    runTicks(w, 30 * 60);
    for (const b of before) {
      const o = w.objectives.find(
        (x) => Math.hypot(x.pos.x - b.target.x, x.pos.z - b.target.z) < 1,
      );
      if (!o || o.owner === "blue") continue; // 確保済み = 任務完了。以後は保持へ移る
      const task = activeTaskOf(w, co, b.id);
      expect(task, `${b.id} の任務が消えている`).not.toBeNull();
      const pl = w.platoons.find((p) => p.side === "blue" && p.platoonId === b.id);
      if (!pl) continue;
      // 拠点そのもの、または拠点の保持のために広げた持ち場の中にいること
      expect(Math.hypot(pl.objective.x - b.target.x, pl.objective.z - b.target.z)).toBeLessThan(40);
    }
  }, 120000);

  it("拠点を確保しきると任務は完了し、通常の割り当てへ戻る", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    const co = w.companies.find((c) => c.side === "blue")!;
    const t = co.plan!.tasks.find((x) => x.objectiveId !== null)!;
    expect(activeTaskOf(w, co, t.platoonId)).not.toBeNull();
    const o = w.objectives.find((x) => x.id === t.objectiveId)!;
    o.owner = "blue";
    expect(activeTaskOf(w, co, t.platoonId)).toBeNull();
  });
});
