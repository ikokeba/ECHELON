import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario } from "../src/sim/scenario.ts";
import { decayedConfidence } from "../src/sim/belief.ts";
import type { FireteamMode } from "../src/sim/types.ts";

describe("belief decay (spec §5 確定値)", () => {
  it("hits the three fixed points exactly", () => {
    expect(decayedConfidence(0)).toBe(1);
    expect(decayedConfidence(30)).toBeCloseTo(0.8, 10);
    expect(decayedConfidence(90)).toBeCloseTo(0.5, 10);
    expect(decayedConfidence(180)).toBeCloseTo(0, 10);
  });

  it("decays monotonically and never goes negative", () => {
    let prev = 1;
    for (let t = 0; t <= 300; t += 3) {
      const c = decayedConfidence(t);
      expect(c).toBeLessThanOrEqual(prev + 1e-12);
      expect(c).toBeGreaterThanOrEqual(0);
      prev = c;
    }
  });
});

describe("fireteam AI", () => {
  it("starts every fireteam in ADVANCE with an empty picture", () => {
    const w = createWorld(demoCrossingScenario(1));
    expect(w.fireteams.length).toBe(4); // 2 squads x 2 fireteams
    for (const ft of w.fireteams) {
      expect(ft.mode).toBe<FireteamMode>("ADVANCE");
      expect(ft.memory.size).toBe(0);
    }
  });

  it("builds a contact picture and leaves ADVANCE once the enemy is seen", () => {
    const w = createWorld(demoCrossingScenario(1));
    runTicks(w, 900); // 30s
    const engaged = w.fireteams.filter((f) => f.mode !== "ADVANCE");
    expect(engaged.length).toBeGreaterThan(0);
    expect(w.fireteams.some((f) => f.memory.size > 0)).toBe(true);
  });

  it("assigns base-of-fire and maneuver roles in CONTACT (spec §6)", () => {
    // 特定の1ティックを覗くのではなく交戦の経過を通して観測する。
    // どの瞬間に接敵するかは移動技術の選択(小隊長の判断)に左右されるため。
    const w = createWorld(demoCrossingScenario(1));
    const kinds = new Set<string>();
    for (let i = 0; i < 3600; i++) {
      runTicks(w, 1);
      for (const s of w.soldiers) if (s.status === "ok") kinds.add(s.order.kind);
    }
    expect(kinds.has("suppress")).toBe(true);
    expect(kinds.has("maneuver")).toBe(true);
  }, 30000);

  it("drops a contact from the picture as soon as it is confirmed KIA (spec §9)", () => {
    const w = createWorld(demoCrossingScenario(2));
    runTicks(w, 2400);
    for (const ft of w.fireteams) {
      for (const key of ft.memory.keys()) {
        const enemy = w.soldierById.get(Number(key.slice(1)));
        expect(enemy?.status).not.toBe("kia");
      }
    }
  });

  it("never puts an enemy contact in a friendly fireteam's picture (spec §5)", () => {
    const w = createWorld(demoCrossingScenario(4));
    runTicks(w, 1200);
    for (const ft of w.fireteams) {
      for (const c of ft.memory.values()) {
        expect(c.side).not.toBe(ft.side);
      }
    }
  });
});

describe("force symmetry (spec §2, §13)", () => {
  it("shows no side bias across many seeds", () => {
    let blueWins = 0;
    let redWins = 0;
    const N = 24;
    for (let seed = 1; seed <= N; seed++) {
      const w = createWorld(demoCrossingScenario(seed));
      runTicks(w, 9000); // 5 minutes
      const b = w.soldiers.filter((s) => s.side === "blue" && s.status === "ok").length;
      const r = w.soldiers.filter((s) => s.side === "red" && s.status === "ok").length;
      if (b > r) blueWins++;
      else if (r > b) redWins++;
    }
    // A systematic advantage (a player-favouring branch, an iteration-order bias,
    // an asymmetric candidate lattice) shows up here as a lopsided split.
    const decided = blueWins + redWins;
    expect(decided).toBeGreaterThan(N * 0.5);
    expect(Math.abs(blueWins - redWins)).toBeLessThanOrEqual(decided * 0.5);
  }, 60000);

  it("resolves a fight — the crossing does not stalemate", () => {
    const w = createWorld(demoCrossingScenario(9));
    runTicks(w, 7200);
    const casualties = w.soldiers.filter((s) => s.status !== "ok").length;
    expect(casualties).toBeGreaterThan(4);
  }, 30000);
});
