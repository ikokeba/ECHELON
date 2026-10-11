import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { crewServedSystem } from "../src/sim/systems/crewServed.ts";
import { CREW_SERVED, DEFENSE, SIM_HZ } from "../src/sim/constants.ts";
import type { Scenario, Side, Soldier } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 機関銃の射手の交代(`[v7.6]` プレイでの指摘、ATP 3-21.8 / FM 3-22.68 の機関銃班)。
 *
 *   - 射手が倒れたら、同じ班の副射手(いなければ弾薬手)が銃を受け継ぐ
 *   - 班が尽きても、陣地の銃には同じ小隊の近くの小銃手が就き、機関銃班へ編入される
 *   - 受け継いだ者は構え直すまで撃たない。受け継ぐ者がいなければ銃は倒れた射手のまま
 */

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

function battle(sc: Scenario): World {
  const w = createWorld(sc);
  beginPlanning(w);
  beginBattle(w);
  return w;
}

function gunners(w: World, side: Side): Soldier[] {
  return w.soldiers.filter((s) => s.side === side && s.role === "mg");
}

describe("機関銃の射手の交代(`[v7.6]`)", () => {
  it("射手が倒れると、同じ班の最も近い隊員(副射手)が銃を受け継ぐ", () => {
    const w = battle(platoonClashScenario(1));
    const g = gunners(w, "blue")[0]!;
    const crew = w.soldiers.filter(
      (s) => s.side === g.side && s.squadId === g.squadId && s.fireteamId === g.fireteamId && s.id !== g.id,
    );
    expect(crew.length).toBe(2);
    const ag = [...crew].sort((a, b) => dist(a.pos, g.pos) - dist(b.pos, g.pos))[0]!;
    g.status = "wia";
    crewServedSystem(w);
    expect(ag.role).toBe("mg");
    expect(g.role).toBe("rifleman");
    // 1丁につき射手は1人のまま
    expect(gunners(w, "blue").length).toBe(2);
    // 構え直すあいだは撃たない
    expect(ag.weaponReadyTick).toBe(w.tick + Math.round(CREW_SERVED.TAKEOVER_SEC * SIM_HZ));
  });

  it("副射手も倒れていれば弾薬手が就き、班が尽きれば銃は倒れた射手のまま(陣地の外)", () => {
    const w = battle(platoonClashScenario(1));
    const g = gunners(w, "blue")[0]!;
    const crew = w.soldiers.filter(
      (s) => s.side === g.side && s.squadId === g.squadId && s.fireteamId === g.fireteamId && s.id !== g.id,
    );
    g.status = "kia";
    crew[0]!.status = "wia";
    crewServedSystem(w);
    expect(crew[1]!.role).toBe("mg");
    // 受け継いだ者も倒れた。班に残りはいない
    crew[1]!.status = "kia";
    crewServedSystem(w);
    expect(crew[1]!.role).toBe("mg");
    expect(w.soldiers.filter((s) => s.role === "mg" && s.status === "ok" && s.side === "blue").length).toBe(1);
  });

  it("陣地の機関銃は、班が尽きても同じ小隊の近くの小銃手が就き、陣地で撃ち続ける", () => {
    const sc = companyClashScenario(1);
    sc.mode = "assault";
    sc.attacker = "blue";
    sc.timeLimitSec = 600;
    const w = battle(sc);
    const post = w.defense.find((p) => p.side === "red" && p.kind === "mg")!;
    expect(post).toBeDefined();
    const crew = w.soldiers.filter(
      (s) => s.side === "red" && s.squadId === post.crew!.squadId && s.fireteamId === post.crew!.ftIndex,
    );
    const g = crew.find((s) => s.role === "mg")!;
    expect(dist(g.pos, post.pos)).toBeLessThanOrEqual(CREW_SERVED.POST_RADIUS);
    for (const s of crew) s.status = "kia";
    // 同じ小隊の小銃分隊から1人、陣地のすぐ脇に置いておく(誰よりも近い)
    const helper = w.soldiers.find(
      (s) =>
        s.side === "red" &&
        s.platoonId === g.platoonId &&
        s.squadId !== g.squadId &&
        s.role === "rifleman" &&
        !s.isFireteamLeader &&
        !s.isSquadLeader &&
        !s.quals.designatedMarksman &&
        !s.quals.antiArmor &&
        s.status === "ok",
    )!;
    helper.pos = { x: post.pos.x + 0.5, z: post.pos.z + 0.5 };
    crewServedSystem(w);
    expect(helper.role).toBe("mg");
    expect(helper.squadId).toBe(post.crew!.squadId);
    expect(helper.fireteamId).toBe(post.crew!.ftIndex);
    // 陣地へ就いて、射界を持つ
    for (let t = 0; t < 20 * SIM_HZ; t++) stepWorld(w);
    if (helper.status === "ok") {
      expect(dist(helper.pos, post.pos)).toBeLessThanOrEqual(DEFENSE.POST_ARRIVE + 0.5);
      expect(helper.sector).not.toBeNull();
    }
  }, 120000);

  it("実戦で倒れた射手の銃が受け継がれ、陣営ラベルを入れ替えても同じ結果になる(P2/P3)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const base = platoonClashScenario(3);
    const swapped = platoonClashScenario(3);
    for (const s of swapped.soldiers) s.side = flip(s.side);
    for (const p of swapped.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.squadPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.companyPlans ?? []) p.side = flip(p.side);
    const a = createWorld(base);
    const b = createWorld(swapped);
    let takeovers = 0;
    const before = new Set(gunners(a, "blue").concat(gunners(a, "red")).map((s) => s.id));
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      stepWorld(a);
      stepWorld(b);
    }
    for (const s of a.soldiers) if (s.role === "mg" && !before.has(s.id)) takeovers++;
    const roles = (w: World, side: Side) =>
      w.soldiers.filter((s) => s.side === side && s.role === "mg").map((s) => s.ordinal).sort();
    expect(roles(a, "blue")).toEqual(roles(b, "red"));
    expect(roles(a, "red")).toEqual(roles(b, "blue"));
    expect(takeovers).toBeGreaterThan(0);
  }, 300000);
});
