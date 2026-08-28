import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { swapTo, isControlled, controlledSoldierId } from "../src/sim/control.ts";
import { orderControlledTo } from "../src/sim/playerOrders.ts";

describe("ホットスワップ(仕様 §4)", () => {
  it("初期状態は全ユニットAI制御", () => {
    const w = createWorld(platoonClashScenario(1));
    expect(w.control).toBeNull();
  });

  it("いつでも制限なく交代できる — クールダウンも距離制限もない", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads[0]!;
    const pl = w.platoons[0]!;

    swapTo(w, { echelon: "squad", side: sq.side, unitId: sq.squadId });
    expect(isControlled(w.control, "squad", sq.side, sq.squadId)).toBe(true);

    // 同一ティック内で別階層へ飛べる
    swapTo(w, { echelon: "platoon", side: pl.side, unitId: pl.platoonId });
    expect(isControlled(w.control, "platoon", pl.side, pl.platoonId)).toBe(true);
    expect(isControlled(w.control, "squad", sq.side, sq.squadId)).toBe(false);

    swapTo(w, null);
    expect(w.control).toBeNull();
  });

  it("分隊長を操作すると、その分隊長の身体が操作対象になる", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads[0]!;
    swapTo(w, { echelon: "squad", side: sq.side, unitId: sq.squadId });
    const id = controlledSoldierId(w);
    expect(id).not.toBeNull();
    const sl = w.soldierById.get(id!)!;
    expect(sl.isSquadLeader).toBe(true);
    expect(sl.squadId).toBe(sq.squadId);
  });

  it("操作中はその階層のAIが命令を上書きしない", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads[0]!;
    swapTo(w, { echelon: "squad", side: sq.side, unitId: sq.squadId });

    const target = { x: 20, z: -10 };
    orderControlledTo(w, target);
    runTicks(w, 300); // 10秒

    // 分隊長AIが目標を書き戻していないこと(小隊長AIも操作中の分隊は触らない)
    const after = w.squads.find((s) => s.side === sq.side && s.squadId === sq.squadId)!;
    expect(after.objective.x).toBeCloseTo(target.x, 5);
    expect(after.objective.z).toBeCloseTo(target.z, 5);
  });

  it("操作を解除すると、AIが現在の状態のまま判断を再開する(仕様 §4)", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads[0]!;
    swapTo(w, { echelon: "squad", side: sq.side, unitId: sq.squadId });
    orderControlledTo(w, { x: 20, z: -10 });
    runTicks(w, 120);

    // 解除。AIは状態をリセットせず、そのまま引き継ぐ
    const beliefSizeBefore = sq.belief.size;
    swapTo(w, null);
    expect(sq.belief.size).toBe(beliefSizeBefore); // world picture は失われない

    runTicks(w, 300);
    // AIが指揮を取り戻し、小隊長の担当区域割り当てが再び効く
    const pl = w.platoons.find((p) => p.side === sq.side && p.platoonId === sq.platoonId)!;
    expect(pl.squadObjectives.has(sq.squadId)).toBe(true);
  });

  it("操作しても情報の階層は迂回できない(仕様 §5・§13)", () => {
    const w = createWorld(platoonClashScenario(3));
    const pl = w.platoons[0]!;
    swapTo(w, { echelon: "platoon", side: pl.side, unitId: pl.platoonId });
    runTicks(w, 2400);

    // 人間が操作していても、小隊長のworld pictureは無線報告由来のまま。
    // 直接視認(hopError 0)の接触が紛れ込んでいたら情報階層が破れている。
    for (const c of pl.belief.values()) {
      expect(c.hopError).toBeGreaterThan(0);
    }
  });

  it("操作は敵陣営にも同じように適用できる(仕様 §2/§13 の対称性)", () => {
    const w = createWorld(platoonClashScenario(1));
    const redSquad = w.squads.find((s) => s.side === "red")!;
    swapTo(w, { echelon: "squad", side: "red", unitId: redSquad.squadId });
    orderControlledTo(w, { x: -15, z: 5 });
    runTicks(w, 300);
    expect(redSquad.objective.x).toBeCloseTo(-15, 5);
  });

  it("人間が操作しても他のユニットのAIは動き続ける", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads[0]!;
    swapTo(w, { echelon: "squad", side: sq.side, unitId: sq.squadId });
    runTicks(w, 600);

    // 操作していない分隊は前進している
    const others = w.squads.filter((s) => s.squadId !== sq.squadId);
    const moved = others.some((o) => {
      const men = w.soldiers.filter((s) => s.side === o.side && s.squadId === o.squadId);
      return men.some((m) => m.path.length > 0 || m.order.kind !== "hold");
    });
    expect(moved).toBe(true);
  });
});
