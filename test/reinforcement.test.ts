import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE, DEFAULT_REINFORCEMENT, type ForceSpec } from "../src/sim/force.ts";
import {
  callReinforcement,
  reinforcementEntry,
  reinforcementsLeft,
  topCommandOf,
} from "../src/sim/systems/reinforcement.ts";
import { orderReinforcement } from "../src/sim/playerOrders.ts";
import { SIM_HZ } from "../src/sim/constants.ts";
import { collidesWallIndexed } from "../src/sim/wallIndex.ts";
import type { ReinforcementSpec, Scenario, Side } from "../src/sim/types.ts";

/**
 * 後援部隊(`[v7.0]` systems/reinforcement.ts)。数・規模・出現位置は暫定値で、
 * ここで固定するのは「どの値でも仕組みが正しく動くこと」だけ。
 */

const withReinf = (
  scale: ForceSpec["scale"],
  r: Partial<ReinforcementSpec> = {},
): Record<Side, ForceSpec> => {
  const spec: ForceSpec = {
    ...DEFAULT_FORCE,
    scale,
    reinforcement: { ...DEFAULT_REINFORCEMENT, autoCallBelow: 0, ...r },
  };
  return { blue: { ...spec }, red: { ...spec } };
};

describe("後援部隊の要請", () => {
  it("既定(後援なし)では何も起きず、要請もできない", () => {
    const w = createWorld(companyClashScenario(1));
    expect(w.reinforcement.blue.spec).toBeNull();
    expect(callReinforcement(w, "blue")).toBe(false);
    expect(reinforcementsLeft(w, "blue")).toBe(0);
  });

  it("要請から delaySec 後に分隊が後方へ現れ、最も消耗した小隊の麾下で動き出す", () => {
    const w = createWorld(
      companyClashScenario(1, withReinf("company", { delaySec: 10, size: "squad" })),
    );
    const before = w.soldiers.filter((s) => s.side === "blue").length;
    const squadsBefore = w.squads.filter((s) => s.side === "blue").length;
    // 第1小隊を消耗させる(戦死扱い)→ 増援はそこへ付く
    const pl1 = w.platoons.find((p) => p.side === "blue" && p.platoonId === 1)!;
    for (const s of w.soldiers) {
      if (s.side === "blue" && s.platoonId === 1 && s.fireteamId === 1) s.status = "kia";
    }
    expect(callReinforcement(w, "blue")).toBe(true);
    expect(reinforcementsLeft(w, "blue")).toBe(0);
    runTicks(w, 10 * SIM_HZ - 1);
    expect(w.soldiers.filter((s) => s.side === "blue").length).toBe(before);
    runTicks(w, 2);
    const added = w.soldiers.filter((s) => s.side === "blue").slice(before);
    expect(added.length).toBe(9);
    expect(w.squads.filter((s) => s.side === "blue").length).toBe(squadsBefore + 1);
    const sq = w.squads.find((s) => s.side === "blue" && s.squadId === added[0]!.squadId)!;
    expect(sq.platoonId).toBe(pl1.platoonId);
    expect(sq.commanderId).toBe(added.find((s) => s.isSquadLeader)!.id);
    expect(sq.degradedSinceTick).toBeNull();
    // 現れたのは中隊の指揮所の近く(後方)で、壁の中ではない
    const cp = w.companies.find((c) => c.side === "blue")!.cp;
    for (const s of added) {
      expect(Math.hypot(s.pos.x - cp.x, s.pos.z - cp.z)).toBeLessThan(40);
      expect(collidesWallIndexed(w.wallIndex, s.pos.x, s.pos.z, 0.3)).toBe(false);
      expect(w.soldierById.get(s.id)).toBe(s);
    }
    // FTコントローラも組み込まれ、しばらくすると前へ動いている
    expect(w.fireteams.filter((f) => f.side === "blue" && f.squadId === sq.squadId).length).toBe(2);
    const z0 = added.reduce((a, s) => a + s.pos.z, 0) / added.length;
    runTicks(w, 20 * SIM_HZ);
    const z1 = added.reduce((a, s) => a + s.pos.z, 0) / added.length;
    expect(z1).toBeGreaterThan(z0 + 5); // 青の前進方向は +Z
  });

  it("小隊規模の後援は新しい小隊(3個分隊+小隊本部)として中隊の麾下に入る", () => {
    const w = createWorld(
      companyClashScenario(
        1,
        withReinf("company", { size: "platoon", delaySec: 1, entry: "edge" }),
      ),
    );
    const plBefore = w.platoons.filter((p) => p.side === "red").length;
    expect(callReinforcement(w, "red")).toBe(true);
    runTicks(w, SIM_HZ + 1);
    const pls = w.platoons.filter((p) => p.side === "red");
    expect(pls.length).toBe(plBefore + 1);
    const pl = pls.at(-1)!;
    const men = w.soldiers.filter((s) => s.side === "red" && s.platoonId === pl.platoonId);
    expect(men.length).toBe(29);
    expect(pl.commanderId).toBe(men.find((s) => s.hqRole === "pl")!.id);
    // 盤端 = 赤の前進方向(−Z)の真後ろ → 盤の +Z 側の縁の近く
    const entry = reinforcementEntry(w, "red")!;
    expect(entry.z).toBeGreaterThan(w.bounds.maxZ - 30);
    // 中隊長AIが新しい小隊にも任務を下ろす
    runTicks(w, 10 * SIM_HZ);
    const co = w.companies.find((c) => c.side === "red")!;
    expect(co.platoonMissions.has(pl.platoonId)).toBe(true);
  });

  it("AIの最上位指揮官は戦力が割れたら自分で呼ぶ。人間が座っていれば呼ばない", () => {
    const make = () =>
      createWorld(companyClashScenario(1, withReinf("platoon", { autoCallBelow: 0.7 })));
    const hurt = (w: ReturnType<typeof make>) => {
      let n = 0;
      for (const s of w.soldiers) {
        if (s.side === "blue" && s.hqRole === null && n < 12) {
          s.status = "kia";
          n++;
        }
      }
    };
    const ai = make();
    hurt(ai);
    runTicks(ai, SIM_HZ + 1);
    expect(ai.reinforcement.blue.callsUsed).toBe(1);
    expect(ai.reinforcement.red.callsUsed).toBe(0);

    const human = make();
    const top = topCommandOf(human, "blue")!;
    human.control = { side: "blue", echelon: top.echelon, unitId: top.unitId };
    hurt(human);
    runTicks(human, SIM_HZ + 1);
    expect(human.reinforcement.blue.callsUsed).toBe(0);
    // 人間は自分の判断で呼べる(同じ関数・同じ上限)
    expect(orderReinforcement(human)).toBe(true);
    expect(orderReinforcement(human)).toBe(false); // 回数切れ
  });

  it("最上位でない座席からは要請できない", () => {
    const w = createWorld(companyClashScenario(1, withReinf("company")));
    const pl = w.platoons.find((p) => p.side === "blue")!;
    expect(orderReinforcement(w, { side: "blue", echelon: "platoon", unitId: pl.platoonId })).toBe(
      false,
    );
  });

  it("両軍に同じ後援があれば、陣営ラベルの入替に対して結果が厳密に反転する(仕様 §2/§13)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const make = (): Scenario =>
      companyClashScenario(2, withReinf("platoon", { autoCallBelow: 0.95, delaySec: 20 }));
    const swap = (sc: Scenario): Scenario => {
      for (const s of sc.soldiers) s.side = flip(s.side);
      for (const p of sc.fireteamPlans ?? []) p.side = flip(p.side);
      for (const p of sc.squadPlans ?? []) p.side = flip(p.side);
      for (const p of sc.platoonPlans ?? []) p.side = flip(p.side);
      for (const p of sc.companyPlans ?? []) p.side = flip(p.side);
      if (sc.ccp) sc.ccp = { blue: sc.ccp.red, red: sc.ccp.blue };
      if (sc.reinforcement)
        sc.reinforcement = { blue: sc.reinforcement.red, red: sc.reinforcement.blue };
      return sc;
    };
    const run = (sc: Scenario) => {
      const w = createWorld(sc);
      runTicks(w, 4200);
      const k = (side: Side) =>
        w.soldiers.filter((s) => s.side === side && s.status === "kia").length;
      return {
        kia: { blue: k("blue"), red: k("red") },
        arrived: { blue: w.reinforcement.blue.arrived, red: w.reinforcement.red.arrived },
      };
    };
    const a = run(make());
    const b = run(swap(make()));
    expect(a.arrived.blue + a.arrived.red).toBeGreaterThan(0);
    expect(b.kia).toEqual({ blue: a.kia.red, red: a.kia.blue });
    expect(b.arrived).toEqual({ blue: a.arrived.red, red: a.arrived.blue });
  });
});
