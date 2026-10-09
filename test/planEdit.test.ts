import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginBattle, beginPlanning } from "../src/sim/c2/planning.ts";
import { editPlan } from "../src/sim/c2/planEdit.ts";
import { companyAI } from "../src/sim/c2/company.ts";
import { decodeSetup, defaultSetup, encodeSetup } from "../src/sim/setupCode.ts";
import { MORTAR, SIM_HZ } from "../src/sim/constants.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import { buildObservation } from "../src/llm/observe.ts";
import type { PlanEdit, Side } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 作戦の書き換え(`[v7.3]` ロードマップ A-1)。
 * 中隊長の座席から、立案中だけ、AI の案の上に重ねて書き換える。
 */

function planned(edits: PlanEdit[] = []): World {
  const sc = companyClashScenario(1);
  sc.planEdits = edits;
  const w = createWorld(sc);
  beginPlanning(w);
  return w;
}

const seatOf = (w: World, side: Side) => ({
  side,
  echelon: "company" as const,
  unitId: w.companies.find((c) => c.side === side)!.companyId,
});
const coOf = (w: World, side: Side) => w.companies.find((c) => c.side === side)!;

describe("作戦の書き換え(`[v7.3]` A-1)— 規則", () => {
  it("書き換えられるのは、その陣営の中隊長の座席から、立案中だけ", () => {
    const w = planned();
    const t = coOf(w, "blue").plan!.tasks[0]!;
    const e: PlanEdit = { side: "blue", op: "start", platoonId: t.platoonId, startSec: 30 };
    expect(editPlan(w, e, seatOf(w, "red"))).toEqual({ ok: false, reason: "not_your_plan" });
    expect(editPlan(w, e, null)).toEqual({ ok: false, reason: "not_your_plan" });
    expect(editPlan(w, e, seatOf(w, "blue"))).toEqual({ ok: true });
    beginBattle(w);
    expect(editPlan(w, e, seatOf(w, "blue"))).toEqual({ ok: false, reason: "not_planning" });
  });

  it("任務・主攻を書き換えると、役割と命令文が作り直される", () => {
    const w = planned();
    const co = coOf(w, "blue");
    const seat = seatOf(w, "blue");
    const other = co.plan!.tasks.find((t) => t.role !== "main" && t.objectiveId !== null)!;
    expect(
      editPlan(w, { side: "blue", op: "main", objectiveId: other.objectiveId! }, seat).ok,
    ).toBe(true);
    const main = co.plan!.tasks.filter((t) => t.role === "main");
    expect(main).toHaveLength(1);
    expect(main[0]!.platoonId).toBe(other.platoonId);
    expect(co.plan!.mainObjectiveId).toBe(other.objectiveId);
    expect(co.plan!.edited).toBe(true);
    expect(main[0]!.order).toContain("主攻");

    // 予備にすると任務が掩護(集結地点)になり、拠点を持たない
    expect(
      editPlan(
        w,
        {
          side: "blue",
          op: "task",
          platoonId: other.platoonId,
          mission: "reserve",
          objectiveId: null,
        },
        seat,
      ).ok,
    ).toBe(true);
    const t = co.plan!.tasks.find((x) => x.platoonId === other.platoonId)!;
    expect(t.role).toBe("reserve");
    expect(t.objectiveId).toBeNull();
    const pl = w.platoons.find((p) => p.side === "blue" && p.platoonId === other.platoonId)!;
    expect(pl.mission.kind).toBe("screen");
    // 存在しない拠点・小隊・早すぎる射撃計画は通らない
    expect(editPlan(w, { side: "blue", op: "main", objectiveId: 999 }, seat)).toEqual({
      ok: false,
      reason: "no_objective",
    });
    expect(editPlan(w, { side: "blue", op: "start", platoonId: 999, startSec: 1 }, seat)).toEqual({
      ok: false,
      reason: "no_platoon",
    });
    expect(
      editPlan(
        w,
        { side: "blue", op: "fires", fires: [{ target: { x: 0, z: 0 }, atSec: 10 }] },
        seat,
      ),
    ).toEqual({
      ok: false,
      reason: "fires_too_early",
    });
    expect(
      editPlan(
        w,
        {
          side: "blue",
          op: "fires",
          fires: [
            { target: { x: 0, z: 0 }, atSec: 50 },
            { target: { x: 5, z: 0 }, atSec: 60 },
          ],
        },
        seat,
      ),
    ).toEqual({ ok: false, reason: "fires_too_close" });
  });

  it("書き換えは初期条件(コード)に載り、そこから同じ作戦になる(P3)", () => {
    const w = planned();
    const seat = seatOf(w, "blue");
    const t = coOf(w, "blue").plan!.tasks[1]!;
    const edits: PlanEdit[] = [
      { side: "blue", op: "route", platoonId: t.platoonId, via: [{ x: 10.123, z: -60.456 }] },
      { side: "blue", op: "start", platoonId: t.platoonId, startSec: 20 },
      {
        side: "blue",
        op: "phaseLine",
        line: [
          { x: -100, z: -40 },
          { x: 100, z: -40 },
        ],
      },
      { side: "blue", op: "fires", fires: [{ target: { x: 0, z: 10 }, atSec: 60 }] },
    ];
    for (const e of edits) expect(editPlan(w, e, seat).ok).toBe(true);

    const tuning = {
      detectRange: 150,
      fovDeg: 120,
      fireAlignDeg: 25,
      moveSpeed: 3.4,
      turnRateDeg: 180,
    };
    const setup = defaultSetup("company", tuning);
    setup.deployment = { spawn: {}, objectives: null, plan: w.planEdits };
    const back = decodeSetup(encodeSetup(setup, tuning), tuning)!;
    expect(back.deployment!.plan).toEqual(w.planEdits);

    const w2 = planned(back.deployment!.plan);
    const shape = (x: World) => JSON.stringify(x.companies.map((c) => c.plan));
    expect(shape(w2)).toEqual(shape(w));
  });
});

describe("作戦の実行(`[v7.3]` A-1)", () => {
  it("開始時刻までは出発地点で待ち、経由点を通ってから任務へ向かう", () => {
    const w = planned();
    const seat = seatOf(w, "blue");
    const co = coOf(w, "blue");
    const t = co.plan!.tasks[0]!;
    const via = { x: t.route[0]!.x + 5, z: t.route[0]!.z + 20 };
    editPlan(w, { side: "blue", op: "start", platoonId: t.platoonId, startSec: 10 }, seat);
    editPlan(w, { side: "blue", op: "route", platoonId: t.platoonId, via: [via] }, seat);
    beginBattle(w);
    const pl = w.platoons.find((p) => p.side === "blue" && p.platoonId === t.platoonId)!;
    const task = () => co.plan!.tasks.find((x) => x.platoonId === t.platoonId)!;
    stepWorld(w);
    expect(task().legKey).toBe("wait");
    expect(pl.mission.kind).toBe("screen");

    w.tick = 11 * SIM_HZ;
    co.lastDecisionTick = -1e6;
    companyAI(w);
    expect(task().legKey).toBe("via0");
    expect(pl.objective.x).toBeCloseTo(via.x, 1); // 書き換えは 0.01m に丸めて持つ

    // 経由点に着いたら任務の目標へ
    for (const s of w.soldiers)
      if (s.side === "blue" && s.platoonId === t.platoonId) s.pos = { ...via };
    co.lastDecisionTick = -1e6;
    companyAI(w);
    expect(task().legKey).toBe("mission");
    expect(pl.mission.target).toEqual(task().mission.target);
  });

  it("調整線の手前で待ち、全小隊が着いたら揃って越える", () => {
    const w = planned();
    const co = coOf(w, "blue");
    const line: [{ x: number; z: number }, { x: number; z: number }] = [
      { x: -200, z: -60 },
      { x: 200, z: -60 },
    ];
    editPlan(w, { side: "blue", op: "phaseLine", line }, seatOf(w, "blue"));
    beginBattle(w);
    stepWorld(w);
    co.lastDecisionTick = -1e6;
    companyAI(w);
    const bound = co.plan!.tasks.filter((t) => t.objectiveId !== null && t.role !== "reserve");
    for (const t of bound) {
      const pl = w.platoons.find((p) => p.side === "blue" && p.platoonId === t.platoonId)!;
      expect(t.legKey).toBe("pl");
      // 線の手前(自陣の側)で止まる
      expect(Math.abs(pl.objective.z - -60)).toBeLessThan(10);
    }
    expect(co.plan!.phaseLineLiftedTick ?? null).toBeNull();
    // 全小隊が線に着いた
    for (const s of w.soldiers) {
      if (s.side === "blue" && bound.some((t) => t.platoonId === s.platoonId))
        s.pos = { x: s.pos.x, z: -62 };
    }
    stepWorld(w);
    expect(co.plan!.phaseLineLiftedTick).not.toBeNull();
  });

  it("射撃計画は時刻に、AI と同じ規則で要請される", () => {
    const w = planned();
    const co = coOf(w, "blue");
    const red = w.soldiers.filter((s) => s.side === "red");
    const tgt = {
      x: red.reduce((a, s) => a + s.pos.x, 0) / red.length,
      z: red.reduce((a, s) => a + s.pos.z, 0) / red.length,
    };
    const at = MORTAR.COOLDOWN_SEC + 5;
    expect(
      editPlan(
        w,
        { side: "blue", op: "fires", fires: [{ target: tgt, atSec: at }] },
        seatOf(w, "blue"),
      ).ok,
    ).toBe(true);
    beginBattle(w);
    // 人間が中隊長に座っている(AIの中隊長は自分では撃たない)。計画は座っていても進む
    w.control = seatOf(w, "blue");
    let fired = -1;
    for (let t = 0; t < (at + 35) * SIM_HZ && fired < 0; t++) {
      stepWorld(w);
      if (w.fireMissions.some((m) => m.side === "blue")) fired = w.tick;
    }
    // 時刻より前には撃たない。撃てたなら記録が残る(撃てなければ時機を逸して取りやめ)
    if (fired >= 0) expect(fired).toBeGreaterThanOrEqual(at * SIM_HZ);
    expect(co.plan!.fires![0]!.done).toBe(true);
    expect(co.mortarRoundsUsed > 0).toBe(fired >= 0);
  }, 300000);
});

describe("LLM の作戦の書き換え(`[v7.3]` A-1、P4)", () => {
  it("立案中の中隊長は plan 命令で書き換えられ、観測に作戦が載る。戦闘中は却下される", () => {
    const w = planned();
    const seat = seatOf(w, "blue");
    const obs = buildObservation(w, seat)!;
    expect(obs.phase).toBe("planning");
    expect(obs.plan!.tasks.length).toBeGreaterThan(0);
    expect(obs.commands.map((c) => c.type)).toContain("plan");
    const unit = obs.plan!.tasks[0]!.unit;
    const parsed = parseResponse({ commands: [{ type: "plan", op: "start", unit, atSec: 25 }] });
    expect(parsed.errors).toEqual([]);
    expect(applyResponse(w, seat, parsed.response!)[0]).toContain("受理");
    expect(coOf(w, "blue").plan!.tasks.find((t) => t.platoonId === unit)!.startSec).toBe(25);

    beginBattle(w);
    expect(applyResponse(w, seat, parsed.response!)[0]).toContain("却下");
    expect(buildObservation(w, seat)!.commands.map((c) => c.type)).not.toContain("plan");
  });
});
