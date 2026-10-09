import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { hearingSystem } from "../src/sim/systems/hearing.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { HEARING } from "../src/sim/constants.ts";
import type { World } from "../src/sim/world.ts";

/** 青のFTを1つ選び、そのリーダーから見て `dx, dz` の位置に赤の銃声を1発置く */
function shotNear(w: World, dx: number, dz: number, range: number = HEARING.RANGE.rifle) {
  const ft = w.fireteams.find((f) => f.side === "blue")!;
  const leader = w.soldiers.find(
    (s) => s.side === "blue" && s.squadId === ft.squadId && s.fireteamId === ft.ftIndex,
  )!;
  const shooter = w.soldiers.find((s) => s.side === "red")!;
  const pos = { x: leader.pos.x + dx, z: leader.pos.z + dz };
  w.gunshots = [{ sourceId: shooter.id, side: "red", pos, range }];
  return { ft, pos, shooter };
}

describe("音による察知(`[v7.3]` ロードマップ A-5)", () => {
  it("見えていない銃声は、方角と距離の見積もりだけの弱い接触になる", () => {
    const w = createWorld(platoonClashScenario(1));
    const { ft, pos, shooter } = shotNear(w, 37, 41);
    hearingSystem(w);

    const heard = [...ft.memory.values()].filter((c) => c.heard);
    expect(heard).toHaveLength(1);
    const c = heard[0]!;
    // 誰が撃ったかは記憶に入らない(キーは方角の区分)
    expect(c.key).not.toBe(`s${shooter.id}`);
    expect(c.key.startsWith("h")).toBe(true);
    // 位置は真の位置そのものではないが、誤差円の中にはある
    const miss = Math.hypot(c.pos.x - pos.x, c.pos.z - pos.z);
    expect(miss).toBeGreaterThan(0.01);
    expect(miss).toBeLessThanOrEqual(c.posError);
    expect(c.posError).toBeGreaterThanOrEqual(HEARING.ERROR_MIN);
    // 確度は CONTACT にも擲弾の照準にもならない強さ
    expect(c.confidence).toBeLessThan(0.5);
    expect(c.confidence).toBeGreaterThan(0);
  });

  it("聞こえる距離の外、味方の銃声は聞かない", () => {
    const w = createWorld(platoonClashScenario(1));
    const { ft } = shotNear(w, HEARING.RANGE.rifle + 30, 0);
    hearingSystem(w);
    expect([...ft.memory.values()].some((c) => c.heard)).toBe(false);

    w.gunshots = w.gunshots.map((g) => ({
      ...g,
      side: "blue" as const,
      pos: { ...g.pos, x: g.pos.x - 60 },
    }));
    hearingSystem(w);
    expect([...ft.memory.values()].some((c) => c.heard)).toBe(false);
  });

  it("同じ方角の銃声は1件の接触にまとまる", () => {
    const w = createWorld(platoonClashScenario(1));
    const { ft } = shotNear(w, 60, 1);
    hearingSystem(w);
    shotNear(w, 61, -1);
    hearingSystem(w);
    expect([...ft.memory.values()].filter((c) => c.heard)).toHaveLength(1);
  });

  it("聞いた接触は無線で上がり、上位の像では位置がさらに粗くなる", () => {
    const w = createWorld(platoonClashScenario(4));
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      runTicks(w, 60);
      for (const pl of w.platoons) {
        for (const c of pl.belief.values()) {
          if (!c.heard) continue;
          found = true;
          expect(c.side).not.toBe(pl.side);
          expect(c.confidence).toBeLessThan(0.5);
        }
      }
    }
    expect(found).toBe(true);
  });

  it("近くで動く敵の足音は、壁越しでも細かい接触になる", () => {
    const w = createWorld(platoonClashScenario(1));
    const ft = w.fireteams.find((f) => f.side === "blue")!;
    const ear = w.soldiers.find(
      (s) => s.side === "blue" && s.squadId === ft.squadId && s.fireteamId === ft.ftIndex,
    )!;
    const red = w.soldiers.find((s) => s.side === "red")!;
    red.pos = { x: ear.pos.x + 7, z: ear.pos.z };
    w.gunshots = [];
    hearingSystem(w);
    // 止まっている者の足音はしない
    expect([...ft.memory.values()].some((c) => c.heard)).toBe(false);

    red.path = [{ x: red.pos.x + 5, z: red.pos.z }];
    red.pathIdx = 0;
    hearingSystem(w);
    const heard = [...ft.memory.values()].filter((c) => c.heard);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.posError).toBe(HEARING.FOOTSTEP_ERROR);
    expect(Math.hypot(heard[0]!.pos.x - red.pos.x, heard[0]!.pos.z - red.pos.z)).toBeLessThanOrEqual(
      HEARING.FOOTSTEP_ERROR,
    );
  });
});
