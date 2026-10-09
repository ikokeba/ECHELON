import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario, demoCrossingScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { combatLook, standoffBlocks } from "../src/sim/individual.ts";
import { INDIVIDUAL, TRACER_EVERY_TICKS } from "../src/sim/constants.ts";
import { hasLineOfSightIndexed } from "../src/sim/wallIndex.ts";
import { smokeBlocks } from "../src/sim/systems/smoke.ts";

/**
 * 兵士個人の戦闘動作(`[v7.1]` individual.ts)。
 * 計測の出発点: 15m以内で射線の通る敵味方の 27% が互いに見えていなかった(すれ違い)、
 * 屋外で 5m 以内まで寄っている時間が 17%。
 */
describe("個人の戦闘動作", () => {
  it("見えている敵 > 撃ってきた方向 > 命令の警戒方向 の順に向く", () => {
    const w = createWorld(demoCrossingScenario(1));
    const me = w.soldiers.find((s) => s.side === "blue")!;
    const foe = w.soldiers.find((s) => s.side === "red")!;
    me.order = { kind: "move", target: { x: 0, z: 0 }, facing: { x: 1, z: 0 }, issuedTick: 0 };
    me.sees = [];
    expect(combatLook(w, me)).toEqual({ x: 1, z: 0 });
    me.alertFrom = { x: me.pos.x, z: me.pos.z - 10 };
    me.alertUntilTick = w.tick + 10;
    const a = combatLook(w, me)!;
    expect(a.z).toBeCloseTo(-1, 5);
    me.sees = [foe.id];
    const v = combatLook(w, me)!;
    const d = Math.hypot(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z);
    expect(v.x).toBeCloseTo((foe.pos.x - me.pos.x) / d, 5);
    // 担架を担いでいる兵は前を見て運ぶ
    me.bearing = foe.id;
    expect(combatLook(w, me)).toBeNull();
  });

  it("突撃以外では、見えている敵へ STANDOFF より寄る歩を踏まない", () => {
    const w = createWorld(demoCrossingScenario(1));
    const me = w.soldiers.find((s) => s.side === "blue")!;
    const foe = w.soldiers.find((s) => s.side === "red")!;
    foe.pos = { x: me.pos.x, z: me.pos.z + INDIVIDUAL.STANDOFF - 1 };
    me.sees = [foe.id];
    me.order = { kind: "move", target: foe.pos, issuedTick: 0 };
    const toward = { x: me.pos.x, z: me.pos.z + 0.1 };
    const away = { x: me.pos.x, z: me.pos.z - 0.1 };
    expect(standoffBlocks(w, me, me.pos, toward)).toBe(true);
    expect(standoffBlocks(w, me, me.pos, away)).toBe(false);
    me.assaultingUntilTick = w.tick + 30;
    expect(standoffBlocks(w, me, me.pos, toward)).toBe(false);
    me.assaultingUntilTick = 0;
    me.order = { kind: "retreat", target: away, issuedTick: 0 };
    expect(standoffBlocks(w, me, me.pos, toward)).toBe(false);
  });

  it("実戦で、近距離の敵とすれ違わず、屋外で敵の目の前まで歩いていかない", () => {
    const spec = { ...DEFAULT_FORCE, scale: "platoon" as const };
    let pairs = 0;
    let unseen = 0;
    // `[v7.2]` 突入にフラッシュバンが入ってから3シードでは近距離の組が9組に減ったので、
    // 標本を4シードに広げる(判定の閾値は変えない)
    for (const seed of [1, 2, 3, 4]) {
      const w = createWorld(companyClashScenario(seed, { blue: spec, red: { ...spec } }));
      for (let t = 0; t < 4500; t++) {
        stepWorld(w);
        if (t % 10) continue;
        const ok = w.soldiers.filter((s) => s.status === "ok");
        for (const a of ok) {
          if (a.side !== "blue") continue;
          for (const b of ok) {
            if (b.side !== "red") continue;
            if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) > 25) continue;
            if (!hasLineOfSightIndexed(w.wallIndex, a.pos.x, a.pos.z, b.pos.x, b.pos.z)) continue;
            // `[v7.2]` 煙の中の組は「見えるのに見ていない」ではない(煙は視線を遮る、S-2)
            if (smokeBlocks(w, a.eye.x, a.eye.z, b.eye.x, b.eye.z)) continue;
            pairs++;
            if (!a.sees.includes(b.id) && !b.sees.includes(a.id)) unseen++;
          }
        }
      }
    }
    // `[v7.1]` 近距離の命中率を上げてからは至近まで寄る前に決着するので、25m以内で数える
    expect(pairs).toBeGreaterThan(10);
    // 以前は(15m以内で)27%。目が進行方向に縛られなくなったので、ほぼ必ずどちらかが気づく
    expect(unseen / pairs).toBeLessThan(0.05);
  });
});

describe("弾道の描画イベント(`[v7.1]`)", () => {
  it("命中は必ず出し、外れは武器ごとのレートで間引く", () => {
    const w = createWorld(demoCrossingScenario(1));
    let shots = 0;
    let hits = 0;
    let firingTicks = 0;
    for (let t = 0; t < 2400; t++) {
      const before = w.soldiers.filter((s) => s.status !== "ok").length;
      stepWorld(w);
      const after = w.soldiers.filter((s) => s.status !== "ok").length;
      const sh = w.fx.filter((f) => f.kind === "shot");
      shots += sh.length;
      hits += sh.filter((f) => f.kind === "shot" && f.hit).length;
      if (sh.length) firingTicks++;
      // そのティックに倒れた兵がいれば、命中の弾が出ている(擲弾による死傷は除く)
      if (after > before && !w.fx.some((f) => f.kind === "grenade")) {
        expect(sh.some((f) => f.kind === "shot" && f.hit)).toBe(true);
      }
    }
    expect(hits).toBeGreaterThan(0);
    expect(shots).toBeGreaterThan(hits);
    // 毎ティック全員ぶん出していた頃より桁違いに少ない(小銃は12ティックに1発)
    expect(shots / Math.max(1, firingTicks)).toBeLessThan(12 / TRACER_EVERY_TICKS.rifle + 4);
  });
});

void runTicks;
