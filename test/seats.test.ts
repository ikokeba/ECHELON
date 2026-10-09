import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { controlledSoldierId, swapTo } from "../src/sim/control.ts";
import { orderControlledTo, orderHold } from "../src/sim/playerOrders.ts";
import { casualtiesSystem } from "../src/sim/systems/casualties.ts";
import type { World } from "../src/sim/world.ts";
import type { Soldier } from "../src/sim/types.ts";

function teamOf(w: World, leader: Soldier): Soldier[] {
  return w.soldiers.filter(
    (s) =>
      s.side === leader.side && s.squadId === leader.squadId && s.fireteamId === leader.fireteamId,
  );
}

describe("FTリーダー・一兵卒の座席(`[v7.3]` ロードマップ A-7)", () => {
  it("FTリーダーに座ると4名に移動命令が出せ、FTのAIはそれを書き換えない", () => {
    const w = createWorld(platoonClashScenario(1));
    const leader = w.soldiers.find((s) => s.side === "blue" && s.isFireteamLeader)!;
    swapTo(w, { echelon: "fireteam", side: "blue", unitId: leader.id });
    expect(controlledSoldierId(w)).toBe(leader.id);

    const target = { x: leader.pos.x - 6, z: leader.pos.z - 4 };
    expect(orderControlledTo(w, target)).toBe(true);
    const team = teamOf(w, leader).filter((s) => s.status === "ok");
    const issued = team.map((s) => s.order.issuedTick);
    for (const s of team) expect(s.order.kind).toBe("move");
    // リーダーは目的地そのものへ、隊員は横に並ぶ
    expect(leader.order.target).toEqual(target);

    // 座席はリーダー本人に付く。リーダーが倒れるまでの間、AIは4名に命令を出さない
    let checked = 0;
    for (let t = 0; t < 90 && leader.status === "ok"; t++) {
      stepWorld(w);
      if (leader.status !== "ok") break;
      for (const [i, s] of team.entries()) {
        if (s.status !== "ok" || s.treating !== null || s.bearing !== null) continue;
        expect(s.order.issuedTick).toBe(issued[i]);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("一兵卒に座ると本人だけがAIから外れ、同じFTの仲間はAIのまま動く", () => {
    const w = createWorld(platoonClashScenario(1));
    const me = w.soldiers.find(
      (s) => s.side === "blue" && s.role === "rifleman" && s.fireteamId >= 0,
    )!;
    swapTo(w, { echelon: "soldier", side: "blue", unitId: me.id });
    const target = { x: me.pos.x + 3, z: me.pos.z - 5 };
    expect(orderControlledTo(w, target)).toBe(true);
    const myTick = me.order.issuedTick;

    runTicks(w, 60);
    expect(me.order.issuedTick).toBe(myTick);
    expect(me.order.target).toEqual(target);
    // 仲間にはFTリーダーAIが命令を出し直している
    const mates = teamOf(w, me).filter((s) => s.id !== me.id && s.status === "ok");
    expect(mates.some((s) => s.order.issuedTick > myTick)).toBe(true);

    // 座席を離れれば、AIがまた本人へ命令を出す
    swapTo(w, null);
    runTicks(w, 30);
    expect(me.order.issuedTick).toBeGreaterThan(myTick);
  });

  it("止まって構える命令は、指定した方向を向いた保持になる", () => {
    const w = createWorld(platoonClashScenario(1));
    const me = w.soldiers.find((s) => s.side === "blue" && s.role === "saw")!;
    swapTo(w, { echelon: "soldier", side: "blue", unitId: me.id });
    expect(orderHold(w, { x: me.pos.x + 10, z: me.pos.z })).toBe(true);
    expect(me.order.kind).toBe("hold");
    expect(me.order.facing!.x).toBeCloseTo(1, 5);
    // 中隊・小隊・分隊の座席からは出せない(一階層下までしか触れない、仕様 §4)
    const sq = w.squads.find((s) => s.side === "blue")!;
    swapTo(w, { echelon: "squad", side: "blue", unitId: sq.squadId });
    expect(orderHold(w, null)).toBe(false);
  });

  it("座っている兵士は応急手当に自動では割り当てられない", () => {
    const w = createWorld(platoonClashScenario(1));
    const me = w.soldiers.find(
      (s) => s.side === "blue" && s.role === "rifleman" && s.fireteamId >= 0,
    )!;
    const mate = teamOf(w, me).find((s) => s.id !== me.id)!;
    swapTo(w, { echelon: "soldier", side: "blue", unitId: me.id });
    // 自分のすぐ横で仲間が倒れる
    mate.pos = { x: me.pos.x + 0.5, z: me.pos.z };
    mate.status = "wia";
    mate.bleedOutTick = w.tick + 900;
    casualtiesSystem(w);
    expect(mate.assignedAider).not.toBeNull();
    expect(mate.assignedAider).not.toBe(me.id);
  });

  it("FT・一兵卒への命令も記録され、再生できる", () => {
    const w = createWorld(platoonClashScenario(1));
    w.log = [];
    const leader = w.soldiers.find((s) => s.side === "red" && s.isFireteamLeader)!;
    swapTo(w, { echelon: "fireteam", side: "red", unitId: leader.id });
    stepWorld(w);
    orderControlledTo(w, { x: leader.pos.x, z: leader.pos.z + 5 });
    orderHold(w, null);
    const fns = w.log
      .filter((e) => e.kind === "order")
      .map((e) => (e.kind === "order" ? e.fn : ""));
    expect(fns).toEqual(["orderControlledTo", "orderHold"]);
  });
});
