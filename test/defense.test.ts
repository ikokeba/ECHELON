import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import {
  defenseIndexOf,
  defenseSpotBlocker,
  inSector,
  moveDefensivePosition,
} from "../src/sim/c2/defense.ts";
import { windowsSystem } from "../src/sim/systems/windows.ts";
import { decodeSetup, defaultSetup, encodeSetup } from "../src/sim/setupCode.ts";
import { DEFENSE, SIM_HZ } from "../src/sim/constants.ts";
import type { Scenario, Side } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 防衛計画フェーズ(`[v7.2]` ロードマップ S-1)。
 *
 * 固定するのはロードマップ §1 の4原則が陣地でも崩れていないこと:
 *   P1 攻撃側は陣地を持たない・見えない(描画の側)。立案は敵情を使わない
 *   P2 陣営ラベルを入れ替えても同じ陣地になる
 *   P3 人間の置き直しは初期条件に載り、そこから同じ陣地が再現する
 *   P4 置ける場所の規則は AI と人間で同じ
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

const seatOf = (w: World, side: Side) => ({
  side,
  echelon: "company" as const,
  unitId: w.companies.find((c) => c.side === side)!.companyId,
});

describe("防衛陣地の立案(`[v7.2]` S-1)", () => {
  it("攻防戦の防御側だけが3種類の陣地を置き、どれも置ける場所にある", () => {
    const w = planned(assault());
    const red = w.defense.filter((p) => p.side === "red");
    expect(w.defense.filter((p) => p.side === "blue")).toEqual([]);
    for (const k of ["mg", "fighting", "alternate"] as const) {
      expect(red.filter((p) => p.kind === k).length, k).toBeGreaterThan(0);
    }
    for (const p of red) expect(defenseSpotBlocker(w, p.pos), JSON.stringify(p)).toBeNull();
    // 機関銃陣地の班は、機関銃を持つ火器分隊のFT
    for (const p of red.filter((x) => x.kind === "mg")) {
      expect(
        w.soldiers.some(
          (s) => s.side === "red" && s.squadId === p.crew!.squadId && s.fireteamId === p.crew!.ftIndex && s.role === "mg",
        ),
      ).toBe(true);
    }
  });

  it("遭遇戦では陣地を置かない", () => {
    const w = planned(companyClashScenario(1));
    expect(w.defense).toEqual([]);
  });

  it("陣営ラベルを入れ替えると、同じ場所に同じ陣地ができる(P2)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const sc = assault(1, "blue");
    const sw = assault(1, "red");
    for (const s of sw.soldiers) s.side = flip(s.side);
    for (const p of sw.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of sw.squadPlans ?? []) p.side = flip(p.side);
    for (const p of sw.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of sw.companyPlans ?? []) p.side = flip(p.side);
    if (sw.ccp) sw.ccp = { blue: sw.ccp.red, red: sw.ccp.blue };
    const a = planned(sc);
    const b = planned(sw);
    const shape = (w: World, side: Side) =>
      w.defense.filter((p) => p.side === side).map((p) => [p.kind, p.pos, p.facing, p.objectiveId]);
    expect(shape(b, "blue")).toEqual(shape(a, "red"));
    expect(shape(b, "blue").length).toBeGreaterThan(0);
  });

  it("予備陣地は、その拠点を守る小隊のFTの後退先になる", () => {
    const w = planned(assault());
    const co = w.companies.find((c) => c.side === "red")!;
    for (const t of co.plan!.tasks) {
      const alt = w.defense.find((p) => p.side === "red" && p.kind === "alternate" && p.objectiveId === t.objectiveId);
      if (!alt) continue;
      const sq = w.squads.find((s) => s.side === "red" && s.platoonId === t.platoonId)!;
      const ft = w.fireteams.find((f) => f.side === "red" && f.squadId === sq.squadId)!;
      expect(ft.rallyPoint).toEqual(alt.pos);
    }
  });
});

describe("陣地での戦い方(`[v7.2]` S-1)", () => {
  it("戦闘開始時点で機関銃の班は陣地に就いており、射界の外は撃たない", () => {
    const w = planned(assault());
    beginBattle(w);
    const mgs = w.defense.filter((p) => p.kind === "mg");
    for (const p of mgs) {
      const g = w.soldiers.find(
        (s) => s.side === p.side && s.squadId === p.crew!.squadId && s.fireteamId === p.crew!.ftIndex && s.role === "mg",
      )!;
      expect(Math.hypot(g.pos.x - p.pos.x, g.pos.z - p.pos.z)).toBeLessThan(0.01);
    }
    let sectorShots = 0;
    for (let t = 0; t < 150 * SIM_HZ; t++) {
      stepWorld(w);
      for (const f of w.fx) {
        if (f.kind !== "shot") continue;
        const s = w.soldierById.get(f.shooterId)!;
        if (!s.sector) continue;
        sectorShots++;
        expect(inSector(s, f.to)).toBe(true);
      }
    }
    expect(sectorShots).toBeGreaterThan(0);
  }, 300000);

  it("射撃壕に就くと窓と同じ補正を受ける(atWindow)。壕の外では受けない", () => {
    const w = planned(assault());
    const pit = w.defense.find((p) => p.kind === "fighting")!;
    const s = w.soldiers.find((x) => x.side === "blue" && x.status === "ok")!;
    s.pos = { ...pit.pos };
    windowsSystem(w);
    expect(s.atWindow).toBe(true);
    s.pos = { x: pit.pos.x + 3, z: pit.pos.z };
    windowsSystem(w);
    expect(s.atWindow).toBe(false);
  });
});

describe("人間による置き直し(`[v7.2]` S-1、P3/P4)", () => {
  it("防御側の中隊長の座席から、AIと同じ規則で置き直せる", () => {
    const w = planned(assault());
    const mg = w.defense.find((p) => p.kind === "mg")!;
    // 攻撃側の座席・壁の中・戦闘開始後は通らない
    expect(moveDefensivePosition(w, mg.id, mg.pos, seatOf(w, "blue"))).toEqual({ ok: false, reason: "not_your_position" });
    const wall = w.buildings[0]!.bounds;
    const inWall = { x: (wall.minX + wall.maxX) / 2, z: (wall.minZ + wall.maxZ) / 2 };
    expect(moveDefensivePosition(w, mg.id, inWall, seatOf(w, "red"))).toMatchObject({ ok: false, reason: "blocked" });
    const far = { x: w.bounds.maxX - 5, z: w.bounds.maxZ - 5 };
    if (!w.objectives.some((o) => Math.hypot(o.pos.x - far.x, o.pos.z - far.z) <= DEFENSE.MAX_FROM_OBJECTIVE)) {
      expect(moveDefensivePosition(w, mg.id, far, seatOf(w, "red")).ok).toBe(false);
    }
    // 他の陣地の位置へ寄せる(置ける場所であることが分かっている)
    const pit = w.defense.find((p) => p.kind === "fighting" && p.side === "red")!;
    const to = { x: Math.round(pit.pos.x * 100) / 100, z: Math.round(pit.pos.z * 100) / 100 };
    expect(moveDefensivePosition(w, mg.id, to, seatOf(w, "red"))).toEqual({ ok: true });
    expect(mg.pos).toEqual(to);
    // 班も新しい陣地へ入っている
    const g = w.soldiers.find(
      (s) => s.side === mg.side && s.squadId === mg.crew!.squadId && s.fireteamId === mg.crew!.ftIndex && s.role === "mg",
    )!;
    expect(g.pos).toEqual(to);
    beginBattle(w);
    expect(moveDefensivePosition(w, mg.id, mg.pos, seatOf(w, "red"))).toEqual({ ok: false, reason: "not_planning" });
  });

  it("置き直しは初期条件(コード)に載り、そこから同じ陣地と同じ戦闘が再現する(P3)", () => {
    const w = planned(assault());
    const mg = w.defense.find((p) => p.kind === "mg")!;
    const pit = w.defense.find((p) => p.kind === "fighting" && p.side === "red")!;
    moveDefensivePosition(w, mg.id, { ...pit.pos }, seatOf(w, "red"));
    const edit = { side: mg.side, idx: defenseIndexOf(w, mg.id), pos: { ...mg.pos } };

    // 初期条件コードを往復させる
    const tuning = { detectRange: 150, fovDeg: 120, fireAlignDeg: 25, moveSpeed: 3.4, turnRateDeg: 180 };
    const setup = defaultSetup("oldQuarter", tuning);
    setup.deployment = { spawn: {}, objectives: null, mode: "assault", attacker: "blue", defense: [edit] };
    const back = decodeSetup(encodeSetup(setup, tuning), tuning)!;
    expect(back.deployment!.defense).toEqual([edit]);

    const sc = assault();
    sc.defenseEdits = back.deployment!.defense;
    const w2 = planned(sc);
    expect(w2.defense.map((p) => [p.kind, p.pos, p.facing])).toEqual(w.defense.map((p) => [p.kind, p.pos, p.facing]));
    beginBattle(w);
    beginBattle(w2);
    for (let t = 0; t < 20 * SIM_HZ; t++) {
      stepWorld(w);
      stepWorld(w2);
    }
    expect(w2.soldiers.map((s) => [s.status, s.pos])).toEqual(w.soldiers.map((s) => [s.status, s.pos]));
  }, 300000);
});
