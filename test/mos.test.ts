import { describe, it, expect } from "vitest";
import { createRng } from "../src/sim/rng.ts";
import { rollShot } from "../src/sim/systems/combat.ts";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import {
  GRENADE,
  MORALE,
  MOVING_ACC_PENALTY,
  SAW_MOVING_ACC_MUL,
  SIM_HZ,
} from "../src/sim/constants.ts";

const N = 400000;
function hitsWith(ctx: Parameters<typeof rollShot>[1], seed = 90210): number {
  const rng = createRng(seed);
  let hits = 0;
  for (let i = 0; i < N; i++) if (rollShot(rng, ctx).hit) hits++;
  return hits;
}

describe("MOSの戦闘効果(仕様 §14)", () => {
  const base = {
    shooterSuppressed: false,
    shooterIsMarksman: false,
    shooterMoving: false,
    shooterIsSaw: false,
  };

  it("移動しながらの射撃は命中率が下がる", () => {
    const still = hitsWith(base);
    const moving = hitsWith({ ...base, shooterMoving: true });
    const ratio = moving / still;
    expect(ratio).toBeGreaterThan(1 - MOVING_ACC_PENALTY - 0.03);
    expect(ratio).toBeLessThan(1 - MOVING_ACC_PENALTY + 0.03);
  });

  it("SAW手は移動時のペナルティが通常の1.3倍(悪化する)", () => {
    const rifleman = hitsWith({ ...base, shooterMoving: true });
    const saw = hitsWith({ ...base, shooterMoving: true, shooterIsSaw: true });
    expect(saw).toBeLessThan(rifleman);
    const expected = (1 - MOVING_ACC_PENALTY * SAW_MOVING_ACC_MUL) / (1 - MOVING_ACC_PENALTY);
    expect(saw / rifleman).toBeGreaterThan(expected - 0.03);
    expect(saw / rifleman).toBeLessThan(expected + 0.03);
  });

  it("SAW手のペナルティは静止していれば発生しない(移動時のみの効果)", () => {
    expect(hitsWith({ ...base, shooterIsSaw: true })).toBe(hitsWith(base));
  });

  it("擲弾は擲弾手だけが持ち、上限は3発(仕様 §14)", () => {
    const w = createWorld(demoCrossingScenario(1));
    for (const s of w.soldiers) {
      if (s.role === "grenadier") expect(s.grenades).toBe(GRENADE.CHARGES);
      else expect(s.grenades).toBe(0);
    }
  });

  it("擲弾は戦闘の中で実際に消費され、上限を超えない", () => {
    const w = createWorld(platoonClashScenario(3));
    runTicks(w, 9000);
    const gren = w.soldiers.filter((s) => s.role === "grenadier");
    expect(gren.length).toBeGreaterThan(0);
    for (const g of gren) {
      expect(g.grenades).toBeGreaterThanOrEqual(0);
      expect(g.grenades).toBeLessThanOrEqual(GRENADE.CHARGES);
    }
    // 少なくとも1発は使われている
    expect(gren.some((g) => g.grenades < GRENADE.CHARGES)).toBe(true);
  }, 60000);

  it("制圧射撃は回避行動を誘発する(仕様 §14 の行動抑制効果)", () => {
    let sawEvade = false;
    for (let seed = 1; seed <= 4 && !sawEvade; seed++) {
      const w = createWorld(platoonClashScenario(seed));
      for (let t = 0; t < 6000 && !sawEvade; t++) {
        runTicks(w, 1);
        if (w.soldiers.some((s) => s.evadeUntilTick > w.tick)) sawEvade = true;
      }
    }
    expect(sawEvade).toBe(true);
  }, 60000);
});

describe("崩壊/後退(仕様 §12 Morale Break)", () => {
  /** 指定FTの隊員を返す。 */
  function ftMembers(w: ReturnType<typeof createWorld>, squadId: number, ftIndex: number) {
    return w.soldiers.filter(
      (s) => s.side === "blue" && s.squadId === squadId && s.fireteamId === ftIndex,
    );
  }

  it("未処置負傷者が50%以上になると潰走する(FT単位の判定)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const men = ftMembers(w, 0, 0);
    expect(men.length).toBe(4);

    // 半数を未処置の負傷者にする
    for (const s of men.slice(0, 2)) {
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = w.tick + 9999;
    }
    runTicks(w, 1);

    const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === 0 && f.ftIndex === 0)!;
    expect(ft.mode).toBe("ROUT");
    expect(men.filter((s) => s.status === "ok").every((s) => s.routed)).toBe(true);
  });

  it("止血済みの負傷者は潰走の要因にならない(未処置のみが条件)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const men = ftMembers(w, 0, 0);
    for (const s of men.slice(0, 2)) {
      s.status = "wia";
      s.stabilized = true; // 処置済み
      s.bleedOutTick = 0;
    }
    runTicks(w, 1);
    const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === 0 && f.ftIndex === 0)!;
    expect(ft.mode).not.toBe("ROUT");
  });

  it("戦死者の割合は判定要因に含まれない(仕様 §12: 単一条件)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const men = ftMembers(w, 0, 0);
    // 3名戦死・1名健常 = 損耗率75%でも、未処置負傷者は0なので潰走しない
    for (const s of men.slice(0, 3)) s.status = "kia";
    runTicks(w, 1);
    const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === 0 && f.ftIndex === 0)!;
    expect(ft.mode).not.toBe("ROUT");
  });

  it("潰走中は自分から撃たないが、撃たれる対象にはなる(仕様 §12)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const men = ftMembers(w, 0, 0);
    for (const s of men.slice(0, 2)) {
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = w.tick + 9999;
    }
    runTicks(w, 2);
    const routed = men.filter((s) => s.status === "ok" && s.routed);
    expect(routed.length).toBeGreaterThan(0);
    // 潰走中でも索敵は続く = 敵から見えるし、こちらも状況は把握している
    for (const s of routed) expect(s.status).toBe("ok");
  });

  it("プレイヤーが操作している兵士は潰走を拒否できる(仕様 §12)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const men = ftMembers(w, 0, 0);
    const hero = men.find((s) => s.isFireteamLeader)!;
    w.control = { echelon: "soldier", side: "blue", unitId: hero.id };

    for (const s of men.filter((m) => m.id !== hero.id).slice(0, 2)) {
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = w.tick + 9999;
    }
    runTicks(w, 1);

    const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === 0 && f.ftIndex === 0)!;
    expect(ft.mode).toBe("ROUT");
    // 部隊は崩れるが、操作中の1人だけは踏みとどまる
    expect(hero.routed).toBe(false);
    const others = men.filter((s) => s.id !== hero.id && s.status === "ok");
    expect(others.every((s) => s.routed)).toBe(true);
  });

  it("一度潰走したら最短時間は続く(条件のふらつきで点滅しない)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const men = ftMembers(w, 0, 0);
    const wounded = men.slice(0, 2);
    for (const s of wounded) {
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = w.tick + 9999;
    }
    runTicks(w, 1);
    const ft = w.fireteams.find((f) => f.side === "blue" && f.squadId === 0 && f.ftIndex === 0)!;
    expect(ft.mode).toBe("ROUT");

    // 条件を即座に解消しても、最短持続時間の内は潰走したまま
    for (const s of wounded) {
      s.status = "ok";
      s.bleedOutTick = 0;
    }
    runTicks(w, Math.round((MORALE.MIN_ROUT_SEC / 2) * SIM_HZ));
    expect(ft.routedSinceTick).not.toBeNull();

    runTicks(w, Math.round((MORALE.MIN_ROUT_SEC / 2 + 2) * SIM_HZ));
    expect(ft.routedSinceTick).toBeNull();
  });
});
