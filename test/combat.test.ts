import { describe, it, expect } from "vitest";
import { createRng } from "../src/sim/rng.ts";
import { rollShot, isSuppressed } from "../src/sim/systems/combat.ts";
import { canSee } from "../src/sim/systems/perception.ts";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario, makeSoldier, resetIds } from "../src/sim/scenario.ts";
import {
  BLEED_OUT_SEC,
  DETECT_RANGE,
  KIA_ON_HIT_CHANCE,
  SIM_DT,
  SUPPRESSION_ACC_PENALTY,
} from "../src/sim/constants.ts";
import type { AABB } from "../src/sim/types.ts";

describe("rollShot", () => {
  it("splits hits into KIA/WIA near the spec's 30/70", () => {
    const rng = createRng(4242);
    let hits = 0;
    let lethal = 0;
    for (let i = 0; i < 400000; i++) {
      const r = rollShot(rng, { shooterSuppressed: false, shooterIsMarksman: false });
      if (r.hit) {
        hits++;
        if (r.lethal) lethal++;
      }
    }
    expect(hits).toBeGreaterThan(1000);
    expect(lethal / hits).toBeGreaterThan(KIA_ON_HIT_CHANCE - 0.03);
    expect(lethal / hits).toBeLessThan(KIA_ON_HIT_CHANCE + 0.03);
  });

  it("suppression costs the shooter ~40% of its hits (spec §8.6)", () => {
    const n = 500000;
    const countHits = (suppressed: boolean) => {
      const rng = createRng(777);
      let hits = 0;
      for (let i = 0; i < n; i++) {
        if (rollShot(rng, { shooterSuppressed: suppressed, shooterIsMarksman: false }).hit) hits++;
      }
      return hits;
    };
    const ratio = countHits(true) / countHits(false);
    expect(ratio).toBeGreaterThan(1 - SUPPRESSION_ACC_PENALTY - 0.03);
    expect(ratio).toBeLessThan(1 - SUPPRESSION_ACC_PENALTY + 0.03);
  });

  it("the marksman loses much less accuracy than a rifleman (spec §8.6 [v5])", () => {
    const n = 300000;
    const countHits = (marksman: boolean) => {
      const rng = createRng(31337);
      let hits = 0;
      for (let i = 0; i < n; i++) {
        if (rollShot(rng, { shooterSuppressed: true, shooterIsMarksman: marksman }).hit) hits++;
      }
      return hits;
    };
    expect(countHits(true)).toBeGreaterThan(countHits(false) * 1.3);
  });
});

describe("isSuppressed", () => {
  it("is true only until the stamped tick", () => {
    const s = makeSoldier({ side: "blue", platoonId: 0, squadId: 0, fireteamId: 0, pos: { x: 0, z: 0 } });
    s.suppressedUntilTick = 10;
    expect(isSuppressed(s, 9)).toBe(true);
    expect(isSuppressed(s, 10)).toBe(false);
  });
});

describe("canSee", () => {
  const mk = (x: number, z: number, fx: number, fz: number, side: "blue" | "red") =>
    makeSoldier({ side, platoonId: 0, squadId: 0, fireteamId: 0, pos: { x, z }, facing: { x: fx, z: fz } });

  it("sees a target ahead within range with clear LOS", () => {
    resetIds();
    const a = mk(0, 0, 0, 1, "blue");
    const b = mk(0, 10, 0, -1, "red");
    expect(canSee([], a, b)).toBe(true);
  });

  it("does not see a target behind it", () => {
    resetIds();
    const a = mk(0, 0, 0, 1, "blue");
    const b = mk(0, -10, 0, 1, "red");
    expect(canSee([], a, b)).toBe(false);
  });

  it("does not see beyond DETECT_RANGE", () => {
    resetIds();
    const a = mk(0, 0, 0, 1, "blue");
    const b = mk(0, DETECT_RANGE + 2, 0, -1, "red");
    expect(canSee([], a, b)).toBe(false);
  });

  it("is blocked by a wall", () => {
    resetIds();
    const walls: AABB[] = [{ cx: 0, cz: 5, hw: 4, hd: 0.4 }];
    const a = mk(0, 0, 0, 1, "blue");
    const b = mk(0, 10, 0, -1, "red");
    expect(canSee(walls, a, b)).toBe(false);
  });
});

describe("integrated combat", () => {
  it("produces casualties when two squads meet", () => {
    const w = createWorld(demoCrossingScenario(9));
    runTicks(w, 3600); // 2 minutes
    const casualties = w.soldiers.filter((s) => s.status !== "ok").length;
    expect(casualties).toBeGreaterThan(0);
  });

  it("bleeds an untreated WIA out to KIA after the spec's 45s", () => {
    const w = createWorld(demoCrossingScenario(3));
    const victim = w.soldiers[0]!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + Math.round(BLEED_OUT_SEC / SIM_DT);
    // 出血タイマー**だけ**を見るために、負傷者を完全に孤立させる。
    //   - 同陣営を除去: バディエイド(仕様 §9)が実装された今、同分隊員が健在なら
    //     手当されて助かってしまう
    //   - 敵陣営も除去: 即死ルール(仕様 §9)が実装された今、他に撃つ相手がいない敵は
    //     倒れている兵士へ火力を向け、45秒を待たずに戦死させてしまう
    for (const s of w.soldiers) {
      if (s.id !== victim.id) s.status = "kia";
    }
    runTicks(w, Math.round((BLEED_OUT_SEC - 1) / SIM_DT));
    expect(victim.status).toBe("wia");
    runTicks(w, Math.round(2 / SIM_DT));
    expect(victim.status).toBe("kia");
  });

  it("stays deterministic with combat in the loop", () => {
    const snap = (seed: number) => {
      const w = createWorld(demoCrossingScenario(seed));
      runTicks(w, 1800);
      return JSON.stringify(
        w.soldiers.map((s) => [s.id, s.status, Math.round(s.pos.x * 1e6), Math.round(s.pos.z * 1e6)]),
      );
    };
    expect(snap(11)).toEqual(snap(11));
  });

  it("resolves shots simultaneously — no first-mover advantage", () => {
    // Iterating soldiers blue-first and applying each hit immediately would let
    // blue kill red before red ever rolls, in the same tick. Combat therefore
    // rolls against start-of-tick state and applies afterwards, so a soldier
    // killed this tick still gets its shot off (spec §2/§13 force symmetry).
    // Assert it directly: a mutual point-blank engagement can end with BOTH
    // sides hit on the same tick.
    let sawMutual = false;
    for (let seed = 1; seed <= 40 && !sawMutual; seed++) {
      const w = createWorld(demoCrossingScenario(seed));
      let prevBlueOk = w.soldiers.filter((s) => s.side === "blue" && s.status === "ok").length;
      let prevRedOk = w.soldiers.filter((s) => s.side === "red" && s.status === "ok").length;
      for (let t = 0; t < 6000; t++) {
        runTicks(w, 1);
        const b = w.soldiers.filter((s) => s.side === "blue" && s.status === "ok").length;
        const r = w.soldiers.filter((s) => s.side === "red" && s.status === "ok").length;
        if (b < prevBlueOk && r < prevRedOk) {
          sawMutual = true;
          break;
        }
        prevBlueOk = b;
        prevRedOk = r;
      }
    }
    expect(sawMutual).toBe(true);
  }, 60000);
});
