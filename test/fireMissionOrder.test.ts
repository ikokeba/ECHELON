import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { MORTAR, SIM_HZ } from "../src/sim/constants.ts";
import { DOCTRINES } from "../src/sim/doctrine.ts";
import { orderFireMission } from "../src/sim/playerOrders.ts";
import { fireMissionBlocker } from "../src/sim/systems/indirect.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import type { ControlState } from "../src/sim/control.ts";
import type { FireMission, Vec2 } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 迫撃砲の要請を人間・LLM にも開く(`[v7.2]` ロードマップ S-5)。
 *
 * 守るのはロードマップの原則 P4「人間・AI・LLM が同じ命令を通る」。
 *   - 人間・LLM の要請は AI の中隊長と**同じ関数**(`requestFireMission`)を通り、
 *     弾数・指揮所・要請間隔・射程・火力の統制線が同じに掛かる
 *   - 中隊長に座っている間、AI の中隊長は撃たない(撃つかどうかは座った者が決める)
 */

function battle(seed = 1): World {
  const w = createWorld(companyClashScenario(seed));
  beginPlanning(w);
  beginBattle(w);
  return w;
}

const seatOf = (w: World, side: "blue" | "red" = "blue"): ControlState => ({
  side,
  echelon: "company",
  unitId: w.companies.find((c) => c.side === side)!.companyId,
});

/** AI の中隊長が最初の射撃を要請するまで回す。要請した任務を返す */
function untilFirstMission(w: World, side: "blue" | "red"): FireMission {
  for (let t = 0; t < 400 * SIM_HZ; t++) {
    stepWorld(w);
    const m = w.fireMissions.find((x) => x.side === side);
    if (m) return { ...m, target: { ...m.target } };
  }
  throw new Error("要請が出なかった");
}

describe("迫撃砲の要請 — 人間・LLM(`[v7.2]` S-5)", () => {
  /**
   * いちばん強い形の「同じ経路」の確認。AI が要請したのと同じティックに、同じ点へ
   * 人間が先に要請すれば、AI の要請は「飛翔中」で弾かれ、以後の盤面はAIが撃った
   * 世界と1ビットも違わない。
   */
  it("AIと同じ点・同じティックに人間が要請すれば、AIの要請と厳密に同じ結果になる", () => {
    const a = battle(1);
    const m = untilFirstMission(a, "blue");

    const b = battle(1);
    while (b.tick < m.requestedTick) stepWorld(b);
    const r = orderFireMission(b, m.target, seatOf(b));
    expect(r).toEqual({ ok: true, missionId: expect.any(Number), rounds: m.roundsLeft });
    stepWorld(b);
    const mb = b.fireMissions.find((x) => x.side === "blue")!;
    expect(mb.target).toEqual(m.target);
    expect(mb.nextImpactTick).toBe(m.nextImpactTick);

    for (let i = 0; i < 40 * SIM_HZ; i++) {
      stepWorld(a);
      stepWorld(b);
    }
    expect(b.soldiers.map((s) => [s.status, s.pos.x, s.pos.z])).toEqual(
      a.soldiers.map((s) => [s.status, s.pos.x, s.pos.z]),
    );
    const used = (w: World) => w.companies.map((c) => c.mortarRoundsUsed);
    expect(used(b)).toEqual(used(a));
  }, 300000);

  it("規則(弾・間隔・射程・統制線・飛翔中)は人間にも同じに掛かる", () => {
    const w = battle(1);
    const seat = seatOf(w);
    const co = w.companies.find((c) => c.side === "blue")!;

    // 開戦直後は要請間隔が明けていない(AIも同じ)
    expect(orderFireMission(w, { x: 0, z: 0 }, seat)).toEqual({ ok: false, reason: "cooldown" });

    const m = untilFirstMission(battle(1), "blue");
    while (w.tick < m.requestedTick) stepWorld(w);

    // 指揮所の足元は射程外(最短射程)。盤の反対側の遠方も射程外
    expect(orderFireMission(w, co.cp, seat)).toEqual({ ok: false, reason: "out_of_range" });
    const far = { x: co.cp.x + co.advanceDir.x * 1000, z: co.cp.z + co.advanceDir.z * 1000 };
    expect(orderFireMission(w, far, seat)).toEqual({ ok: false, reason: "out_of_range" });
    // 自分の前線の頂点の上は危険近接(中隊長が報告で持っている線で判断する)
    const node = co.flot.trace.find(
      (n) => Math.hypot(n.pos.x - co.cp.x, n.pos.z - co.cp.z) >= MORTAR.MIN_RANGE,
    );
    expect(node).toBeDefined();
    expect(orderFireMission(w, node!.pos, seat)).toEqual({ ok: false, reason: "danger_close" });

    // 弾かれた要請は何も消費しない
    expect(co.mortarRoundsUsed).toBe(0);
    expect(w.fireMissions.filter((x) => x.side === "blue")).toEqual([]);

    // 通る要請は1回だけ。続けて撃てば要請間隔で弾かれる
    expect(orderFireMission(w, m.target, seat)).toMatchObject({ ok: true });
    expect(co.mortarRoundsUsed).toBe(MORTAR.ROUNDS_PER_MISSION);
    expect(orderFireMission(w, m.target, seat)).toEqual({ ok: false, reason: "cooldown" });
  }, 300000);

  it("撃ち尽くしたら no_rounds、火力支援を持たないドクトリンは no_fire_support", () => {
    const w = battle(1);
    const co = w.companies.find((c) => c.side === "blue")!;
    co.mortarRoundsUsed = MORTAR.ROUNDS_PER_COMPANY;
    expect(fireMissionBlocker(w, co, { x: 0, z: 0 })).toBe("no_rounds");
    w.doctrine = { blue: DOCTRINES.swarm, red: DOCTRINES.swarm };
    expect(fireMissionBlocker(w, co, { x: 0, z: 0 })).toBe("no_fire_support");
  });

  it("中隊長以外の座席は要請できない", () => {
    const w = battle(1);
    const pl = w.platoons.find((p) => p.side === "blue")!;
    expect(orderFireMission(w, { x: 0, z: 0 }, { side: "blue", echelon: "platoon", unitId: pl.platoonId })).toBeNull();
    expect(orderFireMission(w, { x: 0, z: 0 }, null)).toBeNull();
  });

  /**
   * 中隊長に座っている間、AI の中隊長は撃たない。人間が座っても AI が勝手に弾を
   * 使っていたら、撃つかどうかの判断を人間に渡したことにならない(仕様 §4)。
   * 座っていない側(赤)は従来どおり AI が撃つ。
   */
  it("中隊長に人間が座っている間、その中隊のAIは撃たない", () => {
    const w = battle(1);
    w.control = seatOf(w, "blue");
    let blue = 0;
    let red = 0;
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      stepWorld(w);
      for (const f of w.fx) {
        if (f.kind !== "mortar") continue;
        if (f.side === "blue") blue++;
        else red++;
      }
    }
    expect(blue).toBe(0);
    expect(red).toBeGreaterThan(0);
  }, 300000);
});

describe("迫撃砲の要請 — LLM の命令(`[v7.2]` S-5)", () => {
  it("fire_mission を解釈し、壊れた形は理由つきで捨てる", () => {
    const p = parseResponse({
      commands: [
        { type: "fire_mission", target: { x: 10, z: 20 } },
        { type: "fire_mission" },
      ],
    });
    expect(p.response?.commands).toEqual([{ type: "fire_mission", target: { x: 10, z: 20 } }]);
    expect(p.errors[0]).toMatch(/fire_mission/);
  });

  it("中隊長の観測に迫撃砲の状態が載り、命令として使える。他の座席には載らない", () => {
    const w = battle(1);
    const seat = seatOf(w);
    const obs = buildObservation(w, { ...seat, echelon: "company" })!;
    expect(obs.fireSupport).toMatchObject({
      roundsLeft: MORTAR.ROUNDS_PER_COMPANY,
      minRange: MORTAR.MIN_RANGE,
      maxRange: MORTAR.MAX_RANGE,
      dangerClose: MORTAR.DANGER_CLOSE,
      inFlightEtaSec: null,
    });
    expect(obs.fireSupport!.cooldownSec).toBeGreaterThan(0);
    expect(obs.commands.map((c) => c.type)).toContain("fire_mission");

    const pl = w.platoons.find((p) => p.side === "blue")!;
    const po = buildObservation(w, { side: "blue", echelon: "platoon", unitId: pl.platoonId })!;
    expect(po.fireSupport).toBeUndefined();
    expect(po.commands.map((c) => c.type)).not.toContain("fire_mission");
    const r = applyResponse(
      w,
      { side: "blue", echelon: "platoon", unitId: pl.platoonId },
      { commands: [{ type: "fire_mission", target: { x: 0, z: 0 } }] },
    );
    expect(r[0]).toMatch(/中隊長だけ/);
  });

  it("却下の理由を lastResult の文で返し、通れば受理と発数を返す", () => {
    const w = battle(1);
    const seat = { side: "blue" as const, echelon: "company" as const, unitId: seatOf(w).unitId };
    const early = applyResponse(w, seat, {
      commands: [{ type: "fire_mission", target: { x: 0, z: 0 } }],
    });
    expect(early[0]).toMatch(/却下 — 前の要請から間隔が明けていない/);

    const m = untilFirstMission(battle(1), "blue");
    while (w.tick < m.requestedTick) stepWorld(w);
    const target: Vec2 = { x: m.target.x, z: m.target.z };
    const ok = applyResponse(w, seat, { commands: [{ type: "fire_mission", target }] });
    expect(ok[0]).toContain(`受理(${MORTAR.ROUNDS_PER_MISSION}発)`);
    const obs = buildObservation(w, seat)!;
    expect(obs.fireSupport!.inFlightEtaSec).toBeGreaterThan(0);
    expect(obs.fireSupport!.roundsLeft).toBe(MORTAR.ROUNDS_PER_COMPANY - MORTAR.ROUNDS_PER_MISSION);
  }, 300000);
});
