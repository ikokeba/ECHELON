import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { applyDeployment, defaultDeploymentOf, type ObjectivePlacement } from "../src/sim/deployment.ts";
import { advanceSequels, beginBattle, beginPlanning, planOperation } from "../src/sim/c2/planning.ts";
import { COMPANY_DECIDE_SEC, SIM_HZ } from "../src/sim/constants.ts";
import { playForce } from "../src/sim/force.ts";
import type { Scenario, Side } from "../src/sim/types.ts";

/**
 * 拠点が多い・遠いときに確保の対象から外れない(`[v7.6]` プレイでの指摘)。
 *
 *   1. 立案: 小隊より拠点が多いとき、行き渡らなかった拠点を「続く目標」として近い小隊へ積む
 *   2. 実行: いまの目標を確保したら、続く目標へ進む(すでに取れている拠点は飛ばす)
 *   3. 戦況: 過半数に届かないなら、手の空いた小隊は距離の制限なく未確保の拠点へ向かう
 */

function withObjectives(objs: ObjectivePlacement[]): Scenario {
  const sc = companyClashScenario(1, playForce());
  return applyDeployment(sc, { ...defaultDeploymentOf(sc), objectives: objs });
}

/** 点対称の5拠点。2つは盤の隅に近い */
const FIVE: ObjectivePlacement[] = [
  { label: "A", pos: { x: 0, z: 0 }, radius: 6 },
  { label: "B", pos: { x: -120, z: 0 }, radius: 6 },
  { label: "C", pos: { x: 120, z: 0 }, radius: 6 },
  { label: "D", pos: { x: -190, z: 100 }, radius: 6 },
  { label: "E", pos: { x: 190, z: -100 }, radius: 6 },
];

describe("拠点の取りこぼし(`[v7.6]`)", () => {
  it("小隊より拠点が多いと、残りの拠点は主攻以外の小隊の続く目標になる(両軍で同じ形)", () => {
    const w = createWorld(withObjectives(FIVE));
    beginPlanning(w);
    for (const side of ["blue", "red"] as Side[]) {
      const plan = w.companies.find((c) => c.side === side)!.plan!;
      const covered = new Set<number>();
      for (const t of plan.tasks) {
        if (t.objectiveId !== null) covered.add(t.objectiveId);
        for (const id of t.sequel ?? []) covered.add(id);
      }
      // 5つすべてが誰かの任務か続く目標になっている
      expect(covered.size).toBe(5);
      const main = plan.tasks.find((t) => t.role === "main")!;
      expect(main.sequel ?? []).toEqual([]);
      expect(plan.tasks.filter((t) => t.sequel && t.sequel.length > 0).length).toBeGreaterThan(0);
      // 命令文に続く目標が書かれている
      for (const t of plan.tasks.filter((x) => x.sequel)) expect(t.order).toContain("続いて");
    }
    const shape = (side: Side) =>
      w.companies
        .find((c) => c.side === side)!
        .plan!.tasks.map((t) => [t.platoonId % 100, t.role, t.sequel?.length ?? 0])
        .sort();
    expect(shape("blue")).toEqual(shape("red"));
  });

  it("いまの目標を確保すると続く目標へ進み、すでに取れている拠点は飛ばす", () => {
    const w = createWorld(withObjectives(FIVE));
    beginPlanning(w);
    beginBattle(w);
    const co = w.companies.find((c) => c.side === "blue")!;
    const t = co.plan!.tasks.find((x) => x.sequel && x.sequel.length > 0)!;
    const first = t.objectiveId!;
    const seq = [...t.sequel!];
    // 確保していない間は進まない
    advanceSequels(w, co);
    expect(t.objectiveId).toBe(first);
    // 今の目標を確保した。続く目標の先頭もすでに取れている(と置く)なら、それを飛ばす
    w.objectives.find((o) => o.id === first)!.owner = "blue";
    if (seq.length > 1) w.objectives.find((o) => o.id === seq[0])!.owner = "blue";
    advanceSequels(w, co);
    const want = seq.length > 1 ? seq[1]! : seq[0]!;
    expect(t.objectiveId).toBe(want);
    expect(t.mission.kind).toBe("seize");
    expect(t.mission.target).toEqual(w.objectives.find((o) => o.id === want)!.pos);
    expect(t.order).toContain("続いて");
  });

  it("過半数に届かないとき、手の空いた小隊は遠い拠点へも向かう(立案なし)", () => {
    // 盤の両端の2拠点 + 中央。正面幅の内側にあるのは中央だけ
    const w = createWorld(
      withObjectives([
        { label: "A", pos: { x: 0, z: 0 }, radius: 6 },
        { label: "B", pos: { x: -200, z: 0 }, radius: 6 },
        { label: "C", pos: { x: 200, z: 0 }, radius: 6 },
      ]),
    );
    for (let t = 0; t < Math.round((COMPANY_DECIDE_SEC + 1) * SIM_HZ); t++) stepWorld(w);
    for (const side of ["blue", "red"] as Side[]) {
      const co = w.companies.find((c) => c.side === side)!;
      const targets = [...co.platoonObjectives.values()];
      const near = (x: number) => targets.some((p) => Math.hypot(p.x - x, p.z) < 12);
      // 3個小隊が3拠点を1つずつ受け持つ。両端の拠点も誰かの目標になっている
      expect(near(-200)).toBe(true);
      expect(near(200)).toBe(true);
      // 拠点を割り当てた小隊は掩護(踏み込まない)にしない
      for (const [id, m] of co.platoonMissions) {
        if (Math.abs(Math.abs(m.target.x) - 200) < 12) expect(m.kind, String(id)).toBe("seize");
      }
    }
  }, 120000);

  it("立案した作戦は両軍で鏡像になる(続く目標を積んでも)", () => {
    const w = createWorld(withObjectives(FIVE));
    const blue = planOperation(w, w.companies.find((c) => c.side === "blue")!);
    const red = planOperation(w, w.companies.find((c) => c.side === "red")!);
    const posOf = (id: number) => w.objectives.find((o) => o.id === id)!.pos;
    const seqPos = (p: typeof blue) =>
      p.tasks
        .map((t) => ({ k: t.platoonId % 100, s: (t.sequel ?? []).map(posOf) }))
        .sort((a, b) => a.k - b.k);
    const b = seqPos(blue);
    const r = seqPos(red);
    for (let i = 0; i < b.length; i++) {
      expect(r[i]!.s.map((p) => ({ x: -p.x + 0, z: -p.z + 0 }))).toEqual(b[i]!.s.map((p) => ({ x: p.x + 0, z: p.z + 0 })));
    }
  });
});
