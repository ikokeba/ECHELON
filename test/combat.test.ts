import { describe, it, expect } from "vitest";
import { createRng, next, ratePerTick } from "../src/sim/rng.ts";
import { combatSystem, rollShot, isSuppressed } from "../src/sim/systems/combat.ts";
import { canSee, perceptionSystem } from "../src/sim/systems/perception.ts";
import { createWorld, setBlockers } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario, makeSoldier, resetIds } from "../src/sim/scenario.ts";
import {
  BLEED_OUT_SEC,
  DETECT_RANGE,
  DM_DETECT_RANGE,
  HIT_RATE_PER_SEC,
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
      const r = rollShot(rng, { shooterSuppressed: false, shooterIsMarksman: false, shooterMoving: false, shooterIsSaw: false });
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
        if (rollShot(rng, { shooterSuppressed: suppressed, shooterIsMarksman: false, shooterMoving: false, shooterIsSaw: false }).hit) hits++;
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
        if (
          rollShot(rng, {
            shooterSuppressed: true,
            shooterIsMarksman: marksman,
            shooterMoving: false,
            shooterIsSaw: false,
          }).hit
        ) {
          hits++;
        }
      }
      return hits;
    };
    expect(countHits(true)).toBeGreaterThan(countHits(false) * 1.3);
  });

  it("突撃フェーズの射手は命中率が上がる(F-6, 仕様 §6 `[v6.1]`)", () => {
    const n = 300000;
    const countHits = (assaulting: boolean) => {
      const rng = createRng(4242);
      let hits = 0;
      for (let i = 0; i < n; i++) {
        if (
          rollShot(rng, {
            shooterSuppressed: false,
            shooterIsMarksman: false,
            shooterMoving: false,
            shooterIsSaw: false,
            shooterAssaulting: assaulting,
          }).hit
        ) {
          hits++;
        }
      }
      return hits;
    };
    expect(countHits(true)).toBeGreaterThan(countHits(false) * 1.4);
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

  it("選抜射手(SDMR)は通常の索敵距離を超えて敵を捉える(仕様 §10)", () => {
    resetIds();
    const dm = makeSoldier({
      side: "blue",
      platoonId: 0,
      squadId: 0,
      fireteamId: 1,
      pos: { x: 0, z: 0 },
      facing: { x: 0, z: 1 },
      quals: { designatedMarksman: true },
    });
    const rifleman = makeSoldier({
      side: "blue",
      platoonId: 0,
      squadId: 0,
      fireteamId: 0,
      pos: { x: 0, z: 0 },
      facing: { x: 0, z: 1 },
    });
    const far = mk(0, DETECT_RANGE + 40, 0, -1, "red"); // 60m — 通常の索敵距離の外
    expect(canSee([], dm, far, DM_DETECT_RANGE)).toBe(true);
    expect(canSee([], rifleman, far)).toBe(false); // 既定の索敵距離では見えない
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
    //   - 敵陣営も除去: 擲弾の巻き添えで即死ルール(仕様 §9)が効くと、
    //     45秒を待たずに戦死してしまう(直接射撃は `[v7.4]` から負傷者を狙わない)
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
    // 走査順に沿って命中を即時適用すると、先に見られる陣営が同一ティック内で
    // 相手を倒し、相手は判定すら行えない。戦闘はティック開始時点の状態に対して
    // 全員が判定し、そのあとで効果をまとめて適用する(仕様 §2/§13 戦力対称性)。
    //
    // これは戦闘解決の**構造**の性質なので、実戦の中で「両軍が同時に倒れる瞬間」を
    // 探すのではなく直接確かめる。1回の戦闘で損害が発生するティックは片軍あたり
    // 数回しかないため、偶然の同時発生を待つ検証は本質的に不安定になる。
    //
    // 両陣営の乱数ストリームに「必ず命中する」状態を仕込み、点射距離で対峙させて
    // 戦闘を1ティックだけ回す。両者とも倒れれば、判定が同時に行われた証拠になる。
    const hitP = ratePerTick(HIT_RATE_PER_SEC, SIM_DT);
    let hittingState = -1;
    for (let s = 1; s < 100000; s++) {
      if (next({ state: s }) < hitP) {
        hittingState = s;
        break;
      }
    }
    expect(hittingState).toBeGreaterThan(0);

    const w = createWorld(demoCrossingScenario(1));
    // 遮蔽は本件の関心事ではない。射線が通ることを保証するため取り除く
    setBlockers(w, []);
    for (const s of w.soldiers) s.status = "kia";
    const blue = w.soldiers.find((s) => s.side === "blue")!;
    const red = w.soldiers.find((s) => s.side === "red")!;
    blue.status = "ok";
    red.status = "ok";
    blue.pos = { x: 0, z: 0 };
    blue.facing = { x: 0, z: 1 };
    red.pos = { x: 0, z: 6 };
    red.facing = { x: 0, z: -1 };
    for (const s of [blue, red]) {
      s.path = [];
      s.pathIdx = 0;
      s.suppressedUntilTick = 0;
    }

    perceptionSystem(w);
    expect(blue.sees).toContain(red.id);
    expect(red.sees).toContain(blue.id);

    w.rngBySide.blue.state = hittingState;
    w.rngBySide.red.state = hittingState;
    combatSystem(w);

    expect(blue.status).not.toBe("ok");
    expect(red.status).not.toBe("ok");
  });
});
