import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { droneSystem, taskDrone } from "../src/sim/systems/drone.ts";
import { orderDrone } from "../src/sim/playerOrders.ts";
import { DRONE, RADIO_LATENCY_SEC, SIM_HZ } from "../src/sim/constants.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import { buildObservation } from "../src/llm/observe.ts";
import type { Scenario, Side } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 観測ドローン班(`[v7.3]` ロードマップ A-2)。設計メモ §6.1 の一線 —
 * 「見る主体であって全体像を配る装置ではない」— を中心に固める。
 */

const SPEC = { ...DEFAULT_FORCE, drone: true };
const scenario = (seed = 1): Scenario =>
  companyClashScenario(seed, { blue: SPEC, red: { ...SPEC } });
const coOf = (w: World, side: Side) => w.companies.find((c) => c.side === side)!;
const droneOfSide = (w: World, side: Side) => w.drones.find((d) => d.side === side)!;

describe("観測ドローン(`[v7.3]` A-2)— 編成と飛行", () => {
  it("編成で付けると、中隊本部の無線手が操縦手になり中隊に1機。付けなければ無い", () => {
    const w = createWorld(scenario());
    expect(w.drones).toHaveLength(2);
    for (const d of w.drones) {
      const op = w.soldierById.get(d.operatorId)!;
      expect(op.hqRole).toBe("coRto");
      expect(op.quals.droneOperator).toBe(true);
      expect(d.state).toBe("ready");
      expect(d.batteriesLeft).toBe(DRONE.BATTERIES);
    }
    expect(createWorld(companyClashScenario(1)).drones).toEqual([]);
  });

  it("飛ばし先へ飛び、電池が尽きる前に戻って替え、使い切ったら終わる", () => {
    const w = createWorld(scenario());
    const co = coOf(w, "blue");
    const d = droneOfSide(w, "blue");
    const op = w.soldierById.get(d.operatorId)!;
    const target = { x: op.pos.x, z: op.pos.z + 120 };
    expect(taskDrone(w, co, target)).toEqual({ ok: true });
    expect(d.state).toBe("flying");
    // 遠すぎる先は通らない
    expect(taskDrone(w, co, { x: op.pos.x, z: op.pos.z + DRONE.MAX_RANGE + 50 })).toEqual({
      ok: false,
      reason: "out_of_range",
    });
    const seen: string[] = [];
    for (let t = 0; t < (DRONE.ENDURANCE_SEC + DRONE.SWAP_SEC + 20) * SIM_HZ; t++) {
      w.tick++;
      droneSystem(w);
      if (seen[seen.length - 1] !== d.state) seen.push(d.state);
      if (d.state === "ready" && seen.includes("swapping")) taskDrone(w, co, target);
    }
    expect(seen.slice(0, 4)).toEqual(["flying", "returning", "swapping", "ready"]);
    expect(d.batteriesLeft).toBe(DRONE.BATTERIES - 1);
  });

  it("操縦手が倒れたらドローンは落ちる", () => {
    const w = createWorld(scenario());
    const co = coOf(w, "blue");
    const d = droneOfSide(w, "blue");
    const op = w.soldierById.get(d.operatorId)!;
    taskDrone(w, co, { x: op.pos.x, z: op.pos.z + 60 });
    op.status = "wia";
    droneSystem(w);
    expect(d.state).toBe("lost");
    expect(taskDrone(w, co, op.pos)).toEqual({ ok: false, reason: "lost" });
  });
});

describe("ドローンが見たものの流れ(`[v7.3]` A-2、§5 / P1)", () => {
  it("上から見るので壁越しに見えるが、建物の中は見えない。見たものは操縦手の記憶に入る", () => {
    const w = createWorld(scenario());
    const d = droneOfSide(w, "blue");
    const co = coOf(w, "blue");
    // 赤の兵を1人、ドローンの真下・屋外へ。もう1人を建物の中へ
    const outside = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
    const b = w.buildings[0]!.bounds;
    const inside = w.soldiers.find((s) => s.side === "red" && s.id !== outside.id)!;
    inside.pos = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
    const op = w.soldierById.get(d.operatorId)!;
    outside.pos = { x: op.pos.x, z: op.pos.z + 60 };
    taskDrone(w, co, outside.pos);
    d.pos = { ...outside.pos };
    w.tick++;
    droneSystem(w);
    expect(d.belief.has(`s${outside.id}`)).toBe(true);
    if (Math.hypot(inside.pos.x - d.pos.x, inside.pos.z - d.pos.z) <= DRONE.VIEW_RADIUS) {
      expect(d.belief.has(`s${inside.id}`)).toBe(false);
    }
    // 中隊長の像には、まだ入っていない(無線を経る)
    expect(co.belief.has(`s${outside.id}`)).toBe(false);
  });

  it("中隊長の像には無線の遅延を経て、粒度を1段粗くして届く", () => {
    const w = createWorld(scenario());
    const d = droneOfSide(w, "blue");
    const co = coOf(w, "blue");
    const op = w.soldierById.get(d.operatorId)!;
    const red = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
    red.pos = { x: op.pos.x + 10, z: op.pos.z + 80 };
    taskDrone(w, co, red.pos);
    d.pos = { ...red.pos };
    let seenTick = -1;
    let arriveTick = -1;
    for (let t = 0; t < 12 * SIM_HZ && arriveTick < 0; t++) {
      stepWorld(w);
      if (seenTick < 0 && d.belief.has(`s${red.id}`)) seenTick = w.tick;
      const c = co.belief.get(`s${red.id}`);
      if (c && arriveTick < 0) {
        arriveTick = w.tick;
        expect(c.hopError).toBeGreaterThan(0);
      }
    }
    expect(seenTick).toBeGreaterThanOrEqual(0);
    expect(arriveTick).toBeGreaterThanOrEqual(
      seenTick + Math.round(RADIO_LATENCY_SEC * SIM_HZ) - 1,
    );
  });

  it("ドローンが変えるのは中隊長の像だけ。小隊長・分隊長の像は飛ばさない場合と同じ(末端は古いまま)", () => {
    const run = (fly: boolean): World => {
      const w = createWorld(scenario());
      const co = coOf(w, "blue");
      // 人間が中隊長に座る(AIの中隊長が飛ばし先を決めないように)。両方の世界で同じ
      w.control = { side: "blue", echelon: "company", unitId: co.companyId };
      if (fly) {
        const red = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
        taskDrone(w, co, red.pos);
        droneOfSide(w, "blue").pos = { ...red.pos };
      }
      runTicks(w, 8 * SIM_HZ);
      return w;
    };
    const a = run(false);
    const b = run(true);
    const picture = (w: World) =>
      JSON.stringify([
        w.squads.filter((x) => x.side === "blue").map((x) => [...x.belief.entries()]),
        w.platoons.filter((x) => x.side === "blue").map((x) => [...x.belief.entries()]),
      ]);
    expect(picture(b)).toEqual(picture(a));
    // 中隊長の像だけが新しくなっている
    expect(coOf(b, "blue").belief.size).toBeGreaterThan(coOf(a, "blue").belief.size);
  });
});

describe("ドローンを飛ばす人(`[v7.3]` A-2、P2/P4)", () => {
  it("AI の中隊長は自分で飛ばす。人間・LLM は中隊長の座席から同じ関数で", () => {
    const w = createWorld(scenario());
    runTicks(w, 20 * SIM_HZ);
    expect(w.drones.every((d) => d.state === "flying")).toBe(true);

    const w2 = createWorld(scenario());
    const co = coOf(w2, "blue");
    const seat = { side: "blue" as const, echelon: "company" as const, unitId: co.companyId };
    const op = w2.soldierById.get(droneOfSide(w2, "blue").operatorId)!;
    const pl = {
      side: "blue" as const,
      echelon: "platoon" as const,
      unitId: w2.platoons.find((p) => p.side === "blue")!.platoonId,
    };
    expect(orderDrone(w2, op.pos, pl)).toBeNull();
    const obs = buildObservation(w2, seat)!;
    expect(obs.drone!.state).toBe("ready");
    expect(obs.commands.map((c) => c.type)).toContain("drone");
    const parsed = parseResponse({
      commands: [{ type: "drone", target: { x: op.pos.x, z: op.pos.z + 50 } }],
    });
    expect(applyResponse(w2, seat, parsed.response!)[0]).toContain("受理");
    expect(droneOfSide(w2, "blue").state).toBe("flying");
  });

  it("陣営ラベルを入れ替えても結果が厳密に反転する(P2)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const a = scenario();
    const b = scenario();
    for (const s of b.soldiers) s.side = flip(s.side);
    for (const p of b.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of b.squadPlans ?? []) p.side = flip(p.side);
    for (const p of b.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of b.companyPlans ?? []) p.side = flip(p.side);
    if (b.ccp) b.ccp = { blue: b.ccp.red, red: b.ccp.blue };
    const wa = createWorld(a);
    const wb = createWorld(b);
    runTicks(wa, 1500);
    runTicks(wb, 1500);
    const kia = (w: World, side: Side) =>
      w.soldiers.filter((s) => s.side === side && s.status === "kia").length;
    expect(kia(wb, "blue")).toBe(kia(wa, "red"));
    expect(kia(wb, "red")).toBe(kia(wa, "blue"));
    const shape = (w: World, side: Side) =>
      w.drones.filter((d) => d.side === side).map((d) => [d.state, d.pos]);
    expect(shape(wb, "blue")).toEqual(shape(wa, "red"));
  }, 300000);
});
