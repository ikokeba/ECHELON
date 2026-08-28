import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario } from "../src/sim/scenario.ts";
import type { World } from "../src/sim/world.ts";

function snapshot(w: World): string {
  return JSON.stringify(
    w.soldiers.map((s) => [
      s.id,
      Math.round(s.pos.x * 1e6),
      Math.round(s.pos.z * 1e6),
      Math.round(s.facing.x * 1e6),
      Math.round(s.facing.z * 1e6),
      s.pathIdx,
      s.status,
    ]),
  );
}

describe("simulation determinism", () => {
  it("two runs of the same scenario are bit-identical after 600 ticks", () => {
    const a = createWorld(demoCrossingScenario(1));
    const b = createWorld(demoCrossingScenario(1));
    runTicks(a, 600);
    runTicks(b, 600);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it("advances soldiers toward their objective", () => {
    const w = createWorld(demoCrossingScenario(1));
    const blue = w.soldiers.filter((s) => s.side === "blue");
    const z0 = blue.reduce((acc, s) => acc + s.pos.z, 0) / blue.length;
    runTicks(w, 300); // 10s
    const z1 = blue.reduce((acc, s) => acc + s.pos.z, 0) / blue.length;
    expect(z1).toBeGreaterThan(z0 + 5); // moved north, meaningfully
  });

  it("keeps every soldier out of walls", () => {
    const w = createWorld(demoCrossingScenario(1));
    runTicks(w, 600);
    for (const s of w.soldiers) {
      const inWall = w.walls.some(
        (wall) =>
          Math.abs(s.pos.x - wall.cx) < wall.hw + 0.1 &&
          Math.abs(s.pos.z - wall.cz) < wall.hd + 0.1,
      );
      expect(inWall).toBe(false);
    }
  });

  it("is symmetric: mirrored blue/red end mirrored", () => {
    const w = createWorld(demoCrossingScenario(1));
    runTicks(w, 240);
    const blue = w.soldiers.filter((s) => s.side === "blue").sort((p, q) => p.id - q.id);
    const red = w.soldiers.filter((s) => s.side === "red").sort((p, q) => p.id - q.id);
    expect(blue.length).toBe(red.length);
    for (let i = 0; i < blue.length; i++) {
      // red squad is the point reflection of blue through the origin
      expect(blue[i]!.pos.x).toBeCloseTo(-red[i]!.pos.x, 4);
      expect(blue[i]!.pos.z).toBeCloseTo(-red[i]!.pos.z, 4);
    }
  });
});
