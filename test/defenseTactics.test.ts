import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { defenseSpotBlocker, defenseSystem, moveDefensivePosition } from "../src/sim/c2/defense.ts";
import { companyAI } from "../src/sim/c2/company.ts";
import { SIM_HZ } from "../src/sim/constants.ts";
import type { Scenario, Side } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 防衛側の戦い方(`[v7.3]` ロードマップ A-4)。待ち伏せ・縦深防御(前進陣地)・逆襲。
 * 原則(ロードマップ §1)が崩れていないことを中心に固める。
 */

function assault(seed = 1, attacker: Side = "blue"): Scenario {
  const sc = companyClashScenario(seed);
  sc.mode = "assault";
  sc.attacker = attacker;
  sc.timeLimitSec = 600;
  return sc;
}

function planned(sc: Scenario): World {
  const w = createWorld(sc);
  beginPlanning(w);
  return w;
}

const squadOf = (w: World, side: Side, squadId: number) =>
  w.soldiers.filter((s) => s.side === side && s.squadId === squadId);

describe("分隊の陣地の立案(`[v7.3]` A-4)", () => {
  it("主陣地の正面に待ち伏せ、他の拠点に前進陣地。就くのはその拠点を守る小隊の小銃分隊", () => {
    const w = planned(assault());
    const co = w.companies.find((c) => c.side === "red")!;
    const amb = w.defense.filter((p) => p.kind === "ambush");
    const fwd = w.defense.filter((p) => p.kind === "forward");
    expect(amb).toHaveLength(1);
    expect(amb[0]!.objectiveId).toBe(co.plan!.mainObjectiveId);
    expect(amb[0]!.killZone).toBeDefined();
    expect(fwd.length).toBeGreaterThan(0);
    for (const p of [...amb, ...fwd]) {
      expect(p.side).toBe("red");
      expect(defenseSpotBlocker(w, p.pos)).toBeNull();
      const task = co.plan!.tasks.find((t) => t.objectiveId === p.objectiveId)!;
      const men = squadOf(w, "red", p.crew!.squadId);
      expect(p.crew!.ftIndex).toBe(-1);
      expect(men.every((s) => s.platoonId === task.platoonId)).toBe(true);
      expect(men.some((s) => s.role === "mg")).toBe(false);
      // 戦闘開始の時点で陣地に就いている
      for (const s of men)
        expect(Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z)).toBeLessThan(30);
    }
    // 攻撃側は持たない(P1)
    expect(w.defense.some((p) => p.side === "blue")).toBe(false);
  });

  it("陣営ラベルを入れ替えても同じ場所に同じ分隊の陣地ができる(P2)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const sw = assault(1, "red");
    for (const s of sw.soldiers) s.side = flip(s.side);
    for (const p of sw.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of sw.squadPlans ?? []) p.side = flip(p.side);
    for (const p of sw.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of sw.companyPlans ?? []) p.side = flip(p.side);
    if (sw.ccp) sw.ccp = { blue: sw.ccp.red, red: sw.ccp.blue };
    const a = planned(assault(1, "blue"));
    const b = planned(sw);
    const shape = (w: World, side: Side) =>
      w.defense
        .filter((p) => p.side === side && (p.kind === "forward" || p.kind === "ambush"))
        .map((p) => [p.kind, p.pos, p.killZone ?? null, p.crew]);
    expect(shape(b, "blue")).toEqual(shape(a, "red"));
  });

  it("待ち伏せを置き直すと殺傷地帯も一緒に動く", () => {
    const w = planned(assault());
    const amb = w.defense.find((p) => p.kind === "ambush")!;
    const kz = { ...amb.killZone! };
    const from = { ...amb.pos };
    const fwd = w.defense.find((p) => p.kind === "forward")!;
    const to = { x: Math.round(fwd.pos.x * 100) / 100, z: Math.round(fwd.pos.z * 100) / 100 };
    const seat = {
      side: "red" as const,
      echelon: "company" as const,
      unitId: w.companies.find((c) => c.side === "red")!.companyId,
    };
    expect(moveDefensivePosition(w, amb.id, to, seat)).toEqual({ ok: true });
    expect(amb.killZone!.x - kz.x).toBeCloseTo(to.x - from.x, 6);
    expect(amb.killZone!.z - kz.z).toBeCloseTo(to.z - from.z, 6);
  });
});

describe("待ち伏せと前進陣地の振る舞い(`[v7.3]` A-4)", () => {
  it("待ち伏せは撃ち始めるまで1発も撃たない", () => {
    const w = planned(assault());
    beginBattle(w);
    const amb = w.defense.find((p) => p.kind === "ambush")!;
    const ids = new Set(squadOf(w, "red", amb.crew!.squadId).map((s) => s.id));
    let setTicks = 0;
    for (let t = 0; t < 60 * SIM_HZ && amb.stage === "set"; t++) {
      stepWorld(w);
      if (amb.stage !== "set") break;
      setTicks++;
      for (const g of w.gunshots) expect(ids.has(g.sourceId)).toBe(false);
    }
    expect(setTicks).toBeGreaterThan(0);
  });

  it("前進陣地の分隊は押されたら拠点へ下がり、着いたら通常の指揮へ戻る", () => {
    const w = planned(assault());
    beginBattle(w);
    const fp = w.defense.find((p) => p.kind === "forward")!;
    const men = squadOf(w, "red", fp.crew!.squadId);
    // 1人が倒れる = 押された
    const victim = men.find((s) => !s.isSquadLeader)!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + 9000;
    w.tick = 36; // 判断の周期(0.3秒 = 9ティック)に合わせる
    defenseSystem(w);
    expect(fp.stage).toBe("withdraw");
    const o = w.objectives.find((x) => x.id === fp.objectiveId)!;
    for (const s of men.filter((x) => x.status === "ok" && x.treating === null)) {
      expect(s.order.kind).toBe("retreat");
      expect(Math.hypot(s.order.target!.x - o.pos.x, s.order.target!.z - o.pos.z)).toBeLessThan(15);
    }
    // 拠点に着いたら役目を終える
    for (const s of men) s.pos = { ...o.pos };
    defenseSystem(w);
    expect(fp.stage).toBe("released");
  });
});

describe("逆襲(`[v7.3]` A-4)", () => {
  it("拠点を奪われたら、手の空いた小隊を差し向け、取り返したら解く", () => {
    const w = planned(assault());
    beginBattle(w);
    const co = w.companies.find((c) => c.side === "red")!;
    const lostTask = co.plan!.tasks.find(
      (t) => t.objectiveId !== null && t.objectiveId !== co.plan!.mainObjectiveId,
    )!;
    const o = w.objectives.find((x) => x.id === lostTask.objectiveId)!;
    o.owner = "blue";
    o.progressBy = "blue";
    w.tick = 900;
    co.lastDecisionTick = -1e6;
    companyAI(w);
    expect(co.counterattack).not.toBeNull();
    expect(co.counterattack!.objectiveId).toBe(o.id);
    const pl = w.platoons.find(
      (p) => p.side === "red" && p.platoonId === co.counterattack!.platoonId,
    )!;
    expect(pl.mission.kind).toBe("seize");
    expect(pl.mission.target).toEqual(o.pos);

    // 取り返した
    o.owner = "red";
    co.lastDecisionTick = -1e6;
    companyAI(w);
    expect(co.counterattack).toBeNull();
  });

  it("遭遇戦・攻撃側は逆襲しない", () => {
    const w = planned(assault());
    beginBattle(w);
    const blue = w.companies.find((c) => c.side === "blue")!;
    for (const o of w.objectives) o.owner = "red";
    w.tick = 900;
    blue.lastDecisionTick = -1e6;
    companyAI(w);
    expect(blue.counterattack).toBeNull();
  });
});
