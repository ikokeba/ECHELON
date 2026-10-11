import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { droneSystem, taskDrone } from "../src/sim/systems/drone.ts";
import { DRONE, SIM_HZ } from "../src/sim/constants.ts";
import type { Soldier } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * ドローンからの見え方の確率化(`[v7.5]` ロードマップ A-9)。
 * 動いている者は確実に、止まっている者は数秒で、伏せている者はさらに遅れて見つかる。
 */

const SPEC = { ...DEFAULT_FORCE, drone: true };

/** 青のドローンを赤の兵1人の真上に置く盤面。1つを使い回して何度も測る(世界を作るのは重い) */
function bench(seed = 1) {
  const w: World = createWorld(companyClashScenario(seed, { blue: SPEC, red: { ...SPEC } }));
  const co = w.companies.find((c) => c.side === "blue")!;
  const d = w.drones.find((x) => x.side === "blue")!;
  const op = w.soldierById.get(d.operatorId)!;
  const red = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
  /** 何ティックで見つけるか(最大 limit)。毎回、記憶を空にして置き直す */
  const ticksToSpot = (setup: (s: Soldier) => void, limit = 30 * SIM_HZ): number => {
    red.pos = { x: op.pos.x, z: op.pos.z + 60 };
    red.path = [];
    red.pathIdx = 0;
    red.atWindow = false;
    red.prone = false;
    setup(red);
    d.state = "ready";
    d.flightTicksLeft = DRONE.ENDURANCE_SEC * SIM_HZ;
    d.belief.clear();
    taskDrone(w, co, red.pos);
    d.pos = { ...red.pos };
    for (let t = 0; t < limit; t++) {
      w.tick++;
      droneSystem(w);
      if (d.belief.has(`s${red.id}`)) return t;
    }
    return limit;
  };
  return { w, d, red, ticksToSpot };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const N = 24;
const repeat = (f: () => number): number[] => Array.from({ length: N }, f);

describe("ドローンからの見え方(`[v7.5]` A-9)", () => {
  it("動いている者はその場で見つかる", () => {
    const { ticksToSpot } = bench();
    for (let i = 0; i < 5; i++) {
      expect(
        ticksToSpot((s) => {
          s.path = [{ x: s.pos.x + 30, z: s.pos.z }];
        }),
      ).toBe(0);
    }
  });

  it("止まっている者は確率で、伏せている者はさらに遅れて見つかる(熱線があるので数秒のうちに)", () => {
    const { ticksToSpot } = bench();
    const still = repeat(() => ticksToSpot(() => {}) / SIM_HZ);
    const prone = repeat(() => ticksToSpot((s) => (s.prone = true)) / SIM_HZ);
    // 平均の見つかるまでの時間は 1/毎秒の確率 に近い(ばらつきを見て緩めに)
    expect(mean(still)).toBeGreaterThan(0.3 / DRONE.SPOT_RATE_STILL);
    expect(mean(still)).toBeLessThan(2.5 / DRONE.SPOT_RATE_STILL);
    expect(mean(prone)).toBeGreaterThan(mean(still));
    expect(Math.max(...prone)).toBeLessThan(30);
    // 射撃壕に就いている者も伏せと同じ扱い
    const pit = repeat(() => ticksToSpot((s) => (s.atWindow = true)) / SIM_HZ);
    expect(mean(pit)).toBeGreaterThan(mean(still));
  });

  it("一度見つけた相手は、止まっても見失わない。同じ初期条件なら同じ結果(P3)", () => {
    const { w, d, red, ticksToSpot } = bench();
    ticksToSpot((s) => {
      s.path = [{ x: s.pos.x + 1, z: s.pos.z }];
    });
    red.path = [];
    for (let t = 0; t < 5 * SIM_HZ; t++) {
      w.tick++;
      droneSystem(w);
      expect(d.belief.get(`s${red.id}`)!.lastSeenTick).toBe(w.tick);
    }
    const a = bench(5);
    const b = bench(5);
    expect(repeat(() => a.ticksToSpot(() => {}))).toEqual(repeat(() => b.ticksToSpot(() => {})));
  });
});
