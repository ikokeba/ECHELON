import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginBattle, beginPlanning } from "../src/sim/c2/planning.ts";
import { DOCTRINES } from "../src/sim/doctrine.ts";
import { effectiveForce, forceSize, playForce } from "../src/sim/force.ts";
import { formationSlots } from "../src/sim/formation.ts";
import { trapSystem } from "../src/sim/systems/traps.ts";
import { tunnelSystem } from "../src/sim/systems/tunnel.ts";
import { isOffField } from "../src/sim/systems/litter.ts";
import { buildingAt } from "../src/sim/cqb.ts";
import { decodeSetup, defaultSetup, encodeSetup } from "../src/sim/setupCode.ts";
import { SIM_HZ, TRAP } from "../src/sim/constants.ts";
import type { Scenario } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 新しいドクトリン・編成の型(`[v7.7]` ロードマップ B-4)。
 * 変えるのは指揮の効き方(ドクトリン)と駒・資源(編成)だけで、兵士1名の強さには触れない(P2)。
 */

function hybridDefense(seed = 1): Scenario {
  const f = playForce();
  f.red.template = "hybrid";
  const sc = companyClashScenario(seed, f);
  sc.mode = "assault";
  sc.attacker = "blue";
  sc.timeLimitSec = 900;
  return sc;
}

function planned(sc: Scenario): World {
  const w = createWorld(sc);
  beginPlanning(w);
  return w;
}

describe("ドクトリン(`[v7.7]` B-4)", () => {
  it("分散型・混成型のドクトリンがあり、既存の3つは散開の度合い 1(従来どおり)", () => {
    expect(DOCTRINES.regular.dispersion).toBe(1);
    expect(DOCTRINES.militia.dispersion).toBe(1);
    expect(DOCTRINES.swarm.dispersion).toBe(1);
    expect(DOCTRINES.distributed.dispersion).toBeGreaterThan(1);
    expect(DOCTRINES.hybrid.dispersion).toBeGreaterThan(1);
  });

  it("散開の度合いは隊形の間隔を広げる(既定の 1 では従来と同じ位置)", () => {
    const dir = { x: 0, z: 1 };
    const base = formationSlots([], { x: 0, z: 0 }, dir, 4);
    const same = formationSlots([], { x: 0, z: 0 }, dir, 4, { spread: 1 });
    expect(same.map((s) => s.pos)).toEqual(base.map((s) => s.pos));
    const wide = formationSlots([], { x: 0, z: 0 }, dir, 4, { spread: 1.8 });
    const spanOf = (sl: typeof base) => Math.max(...sl.map((s) => Math.hypot(s.pos.x, s.pos.z)));
    expect(spanOf(wide)).toBeGreaterThan(spanOf(base) * 1.5);
  });

  it("分散型の分隊は2個FTを目標への軸の左右へ離して向かわせる", () => {
    const w = createWorld(companyClashScenario(1));
    w.doctrine = { blue: DOCTRINES.distributed, red: DOCTRINES.regular };
    for (let t = 0; t < 3 * SIM_HZ; t++) stepWorld(w);
    let apart = 0;
    let together = 0;
    for (const sq of w.squads) {
      const fts = w.fireteams.filter((f) => f.side === sq.side && f.squadId === sq.squadId);
      if (fts.length < 2) continue;
      const d = Math.hypot(fts[0]!.objective.x - fts[1]!.objective.x, fts[0]!.objective.z - fts[1]!.objective.z);
      if (sq.side === "blue" && d > 10) apart++;
      if (sq.side === "red" && d < 1e-6) together++;
    }
    expect(apart).toBeGreaterThan(0);
    expect(together).toBeGreaterThan(0);
  });
});

describe("編成の型 — ドローン中心(`[v7.7]` B-4)", () => {
  it("中隊に観測・自爆ドローン、各小隊の無線手も自爆ドローン。火器分隊は持たない", () => {
    const f = playForce();
    f.blue.template = "drone";
    const w = createWorld(companyClashScenario(1, f));
    const blue = w.soldiers.filter((s) => s.side === "blue");
    expect(blue.some((s) => s.role === "mg")).toBe(false);
    expect(blue.filter((s) => s.quals.fpvOperator).map((s) => s.hqRole).sort()).toEqual(
      ["plRto", "plRto", "plRto", "xo"],
    );
    expect(w.drones.filter((d) => d.side === "blue" && d.kind === "fpv").length).toBe(4);
    expect(w.drones.some((d) => d.side === "blue" && d.kind === "recon")).toBe(true);
    // 頭数の表示も型を通す(火器分隊のぶん減る)
    expect(forceSize(f.blue)).toBe(blue.length);
    expect(effectiveForce(f.blue).weaponsSquad).toBe(false);
    // 赤は標準のまま
    expect(w.soldiers.some((s) => s.side === "red" && s.role === "mg")).toBe(true);
  });

  it("初期条件コードに型が載って往復する(標準は載らない)", () => {
    const tuning = { detectRange: 150, fovDeg: 100, fireAlignDeg: 25, moveSpeed: 3.4, turnRateDeg: 180 };
    const s = defaultSetup("company", tuning);
    s.force.blue.template = "drone";
    s.force.red.template = "standard";
    const back = decodeSetup(encodeSetup(s, tuning), tuning)!;
    expect(back.force.blue.template).toBe("drone");
    expect(back.force.red.template).toBeUndefined();
  });
});

describe("編成の型 — 混成型の仕掛け爆弾(`[v7.7]` B-4)", () => {
  it("混成型の防御側だけが、拠点の入口の外に仕掛け爆弾を置く", () => {
    const w = planned(hybridDefense());
    const traps = w.defense.filter((p) => p.kind === "trap");
    expect(traps.length).toBeGreaterThan(0);
    expect(traps.every((p) => p.side === "red")).toBe(true);
    for (const p of traps) expect(buildingAt(w.buildings, p.pos)).toBeNull();
    // 標準の防御側は置かない
    const sc = hybridDefense();
    sc.forceTemplate = { red: "standard" };
    expect(planned(sc).defense.some((p) => p.kind === "trap")).toBe(false);
  });

  it("敵が踏めば炸裂して1回で終わる。味方は踏んでも何も起きない", () => {
    const w = planned(hybridDefense());
    beginBattle(w);
    const trap = w.defense.find((p) => p.kind === "trap")!;
    const friend = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
    friend.pos = { ...trap.pos };
    trapSystem(w);
    expect(trap.stage ?? "set").toBe("set");
    friend.pos = { x: trap.pos.x + 50, z: trap.pos.z };
    const foe = w.soldiers.find((s) => s.side === "blue" && s.status === "ok")!;
    foe.pos = { x: trap.pos.x + 0.5, z: trap.pos.z };
    trapSystem(w);
    expect(trap.stage).toBe("sprung");
    expect(w.fx.some((f) => f.kind === "trap")).toBe(true);
  });

  it("近くで罠の方を向いている敵は気づいて外す。躍進前進なら気づきやすい", () => {
    let careful = 0;
    let hasty = 0;
    for (const technique of ["bounding_overwatch", "traveling"] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const w = planned(hybridDefense(seed));
        beginBattle(w);
        const trap = w.defense.find((p) => p.kind === "trap")!;
        const foe = w.soldiers.find((s) => s.side === "blue" && s.status === "ok" && s.fireteamId >= 0)!;
        const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === foe.squadId && f.ftIndex === foe.fireteamId)!;
        ft.technique = technique;
        foe.pos = { x: trap.pos.x, z: trap.pos.z - (TRAP.SPOT_RANGE - 1) };
        foe.facing = { x: 0, z: 1 };
        for (let t = 0; t < 3 * SIM_HZ && trap.stage !== "released"; t++) {
          trapSystem(w);
          w.tick++;
        }
        if (trap.stage === "released") {
          if (technique === "bounding_overwatch") careful++;
          else hasty++;
        }
      }
    }
    expect(careful).toBeGreaterThan(hasty);
  }, 120000);
});

describe("編成の型 — 混成型のトンネル(`[v7.7]` B-4)", () => {
  it("混成型の防御側だけがトンネルを掘る。拠点の建物と別の建物を結ぶ", () => {
    const w = planned(hybridDefense());
    expect(w.tunnels.length).toBeGreaterThan(0);
    for (const t of w.tunnels) {
      expect(t.side).toBe("red");
      expect(t.a.buildingId).not.toBe(t.b.buildingId);
      expect(buildingAt(w.buildings, t.a.pos)?.id).toBe(t.a.buildingId);
      expect(buildingAt(w.buildings, t.b.pos)?.id).toBe(t.b.buildingId);
    }
    const sc = hybridDefense();
    sc.forceTemplate = { red: "standard" };
    expect(planned(sc).tunnels).toEqual([]);
  });

  it("結ばれた建物を目指す兵は地下を通り、地下にいる間は盤上にいない。時間がたてば出口に出る", () => {
    const w = planned(hybridDefense());
    beginBattle(w);
    const t = w.tunnels[0]!;
    const s = w.soldiers.find((x) => x.side === "red" && x.status === "ok" && x.fireteamId >= 0)!;
    const ft = w.fireteams.find((f) => f.side === "red" && f.squadId === s.squadId && f.ftIndex === s.fireteamId)!;
    s.pos = { ...t.a.pos };
    ft.mode = "ADVANCE";
    ft.objective = { ...t.b.pos };
    tunnelSystem(w);
    expect(s.tunnel).not.toBeNull();
    expect(isOffField(s)).toBe(true);
    const arrive = s.tunnel!.arriveTick;
    w.tick = arrive;
    tunnelSystem(w);
    expect(s.tunnel).toBeNull();
    expect(buildingAt(w.buildings, s.pos)?.id).toBe(t.b.buildingId);
    expect(isOffField(s)).toBe(false);
  });

  it("攻撃側(青)は相手のトンネルを使えない", () => {
    const w = planned(hybridDefense());
    beginBattle(w);
    const t = w.tunnels[0]!;
    const s = w.soldiers.find((x) => x.side === "blue" && x.status === "ok" && x.fireteamId >= 0)!;
    const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === s.squadId && f.ftIndex === s.fireteamId)!;
    s.pos = { ...t.a.pos };
    ft.objective = { ...t.b.pos };
    tunnelSystem(w);
    expect(s.tunnel ?? null).toBeNull();
  });
});
