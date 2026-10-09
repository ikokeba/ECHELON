import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { urbanCqbFixture } from "../src/sim/scenario.ts";
import { detonateFlashbang } from "../src/sim/c2/cqbDrill.ts";
import { insideBounds } from "../src/sim/cqb.ts";
import { FLASHBANG, SIM_HZ } from "../src/sim/constants.ts";
import type { CqbStage, FireteamState } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * フラッシュバン(`[v7.2]` 仕様 §8.4、ロードマップ S-3)。
 *
 * 突入ドリルに「投げる」段を1つ足しただけで、効果は部屋単位の制圧(§8.6)そのもの。
 * 確かめるのは (1) 段の順序、(2) 室内の全員が炸裂から STUN_SEC のあいだ制圧される、
 * (3) 持っていなければ従来どおり、(4) 携行数を超えて投げない、の4点。
 */

const key = (ft: FireteamState) => `${ft.side}:${ft.squadId}:${ft.ftIndex}`;

function run(w: World, sec: number, onTick?: () => void): Map<string, CqbStage[]> {
  const seen = new Map<string, CqbStage[]>();
  for (let t = 0; t < sec * SIM_HZ; t++) {
    stepWorld(w);
    onTick?.();
    for (const ft of w.fireteams) {
      if (ft.mode !== "CQB") continue;
      const list = seen.get(key(ft)) ?? [];
      if (list[list.length - 1] !== ft.cqbStage) list.push(ft.cqbStage);
      seen.set(key(ft), list);
    }
  }
  return seen;
}

describe("フラッシュバン(`[v7.2]` S-3)", () => {
  it("扉を開けて投げ込み、炸裂を待ってから流入する(stack > bang > breach)", () => {
    const w = createWorld(urbanCqbFixture(1));
    let bangs = 0;
    const seen = run(w, 90, () => {
      for (const f of w.fx) {
        if (f.kind !== "flashbang") continue;
        bangs++;
        // 炸裂した時点で、その部屋のドアは開いている
        expect(w.doors.some((d) => d.open)).toBe(true);
      }
    });
    const withBang = [...seen.values()].filter((s) => s.join(">").startsWith("stack>bang>breach"));
    expect(withBang.length, JSON.stringify([...seen])).toBeGreaterThan(0);
    expect(bangs).toBeGreaterThan(0);
    // 使った数だけ減っている。携行数を超えない
    for (const ft of w.fireteams) {
      expect(ft.flashbangs).toBeGreaterThanOrEqual(0);
      expect(ft.flashbangs).toBeLessThanOrEqual(FLASHBANG.PER_FIRETEAM);
    }
    const used = w.fireteams.reduce((n, ft) => n + (FLASHBANG.PER_FIRETEAM - ft.flashbangs), 0);
    expect(used).toBe(bangs);
  });

  it("室内の全員を、陣営を問わず STUN_SEC のあいだ制圧する(部屋単位の制圧、§8.6)", () => {
    const w = createWorld(urbanCqbFixture(1));
    const room = w.buildings[0]!.rooms[0]!;
    const cx = (room.bounds.minX + room.bounds.maxX) / 2;
    const cz = (room.bounds.minZ + room.bounds.maxZ) / 2;
    const red = w.soldiers.find((s) => s.side === "red")!;
    const blue = w.soldiers.find((s) => s.side === "blue")!;
    const outside = w.soldiers.find((s) => s.side === "red" && s.id !== red.id)!;
    red.pos = { x: cx, z: cz };
    blue.pos = { x: cx + 0.8, z: cz };
    expect(insideBounds(room.bounds, outside.pos)).toBe(false);

    const ft = w.fireteams.find((f) => f.side === "blue")!;
    const n = detonateFlashbang(w, ft, room);
    expect(n).toBe(2);
    const until = w.tick + Math.round(FLASHBANG.STUN_SEC * SIM_HZ);
    expect(red.suppressedUntilTick).toBe(until);
    expect(blue.suppressedUntilTick).toBe(until);
    expect(outside.suppressedUntilTick).toBe(0);
    expect(w.fx.at(-1)).toMatchObject({ kind: "flashbang", side: "blue", stunned: 2 });
  });

  it("持っていなければ投げずに入る(従来のドリル)", () => {
    const w = createWorld(urbanCqbFixture(1));
    for (const ft of w.fireteams) ft.flashbangs = 0;
    let bangs = 0;
    const seen = run(w, 90, () => {
      bangs += w.fx.filter((f) => f.kind === "flashbang").length;
    });
    expect(bangs).toBe(0);
    for (const stages of seen.values()) expect(stages).not.toContain("bang");
    expect([...seen.values()].some((s) => s.join(">").startsWith("stack>breach"))).toBe(true);
  });
});
