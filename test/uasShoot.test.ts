import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { uasDetectionSystem } from "../src/sim/systems/uasDetect.ts";
import { shootRate, uasShootSystem } from "../src/sim/systems/uasShoot.ts";
import { taskDrone } from "../src/sim/systems/drone.ts";
import { aiReactToUas } from "../src/sim/c2/uasReact.ts";
import { SIM_HZ, UAS_SHOOT } from "../src/sim/constants.ts";
import type { Drone, Soldier, Vec2 } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * ドローンの撃墜(`[v7.5]` ロードマップ A-10、設計メモ §6.3)。
 * 捉えた兵士が撃ち落とせる。小銃では低い確率、対ドローン装備なら高い確率。撃てば銃声で知られる。
 */

const SPEC = { ...DEFAULT_FORCE, drone: true, counterUas: true };
const world = (seed = 1): World =>
  createWorld(companyClashScenario(seed, { blue: SPEC, red: { ...SPEC } }));

/** 屋外の開けた場所(壁から離れた点)に兵士を1人置き、青のドローンをその横 r m に浮かべる */
function setup(w: World, pick: (s: Soldier) => boolean, r: number): { s: Soldier; d: Drone } {
  const s = w.soldiers.find((x) => x.side === "red" && x.status === "ok" && pick(x))!;
  const d = w.drones.find((x) => x.side === "blue")!;
  const at: Vec2 = { x: 0, z: 0 };
  s.pos = { ...at };
  s.path = [];
  s.pathIdx = 0;
  s.atWindow = false;
  d.state = "flying";
  d.target = null;
  d.pos = { x: at.x + r, z: at.z };
  return { s, d };
}

/** 探知 → 撃墜を1ティックずつ回す。落ちたティック(落ちなければ -1) */
function shootFor(w: World, d: Drone, sec: number): number {
  for (let t = 0; t < sec * SIM_HZ; t++) {
    w.gunshots.length = 0;
    w.fx.length = 0;
    uasDetectionSystem(w);
    uasShootSystem(w);
    if (d.state === "lost") return t;
    w.tick++;
  }
  return -1;
}

describe("対ドローン装備(`[v7.5]` A-10)— 編成", () => {
  it("編成で付けると、小銃分隊ごとにブラボー組のFTリーダー1名が持つ", () => {
    const w = world();
    const holders = w.soldiers.filter((s) => s.quals.counterUas);
    expect(holders.length).toBeGreaterThan(0);
    for (const h of holders) {
      expect(h.fireteamId).toBe(1);
      expect(h.isFireteamLeader).toBe(true);
    }
    const squads = new Set(holders.map((h) => `${h.side}:${h.squadId}`));
    expect(squads.size).toBe(holders.length);
    expect(createWorld(companyClashScenario(1)).soldiers.some((s) => s.quals.counterUas)).toBe(
      false,
    );
  });
});

describe("撃つ・落とす(`[v7.5]` A-10)", () => {
  it("対ドローン装備の持ち主は、届く範囲のドローンを高い確率で落とす。撃てば銃声が鳴る", () => {
    for (const seed of [1, 2, 3]) {
      const w = world(seed);
      const { s, d } = setup(w, (x) => x.quals.counterUas === true, 20);
      w.tick = seed * 7;
      let shots = 0;
      let downed = -1;
      for (let t = 0; t < 60 * SIM_HZ && downed < 0; t++) {
        w.gunshots.length = 0;
        w.fx.length = 0;
        uasDetectionSystem(w);
        uasShootSystem(w);
        if (w.gunshots.some((g) => g.sourceId === s.id)) shots++;
        // `[v7.6]` 装備で撃った弾は色分けのため `cuas` として描く
        for (const f of w.fx) if (f.kind === "shot" && f.shooterId === s.id) expect(f.weapon).toBe("cuas");
        if (d.state === "lost") downed = t;
        w.tick++;
      }
      expect(downed).toBeGreaterThanOrEqual(0);
      expect(d.shotDown).toBe(true);
      expect(shots).toBeGreaterThan(0);
      // 落ちたドローンにはもう飛べと言えない
      const co = w.companies.find((c) => c.side === "blue")!;
      expect(taskDrone(w, co, d.pos)).toEqual({ ok: false, reason: "lost" });
    }
  });

  it("小銃は当たりにくい。毎秒の確率が装備より低く、届かない距離は撃たない(距離は高さを含む)", () => {
    const w = world();
    const { s, d } = setup(w, (x) => x.quals.counterUas === true, 50);
    uasDetectionSystem(w);
    // 装備の距離(40m)の外なので小銃で撃つ
    expect(shootRate(w, s, d)).toBe(UAS_SHOOT.RIFLE_RATE);
    expect(UAS_SHOOT.RIFLE_RATE).toBeLessThan(UAS_SHOOT.KIT_RATE);
    // 距離は高さを含めた斜めの距離。水平20m なら装備の届く範囲
    d.pos = { x: s.pos.x + 20, z: s.pos.z };
    uasDetectionSystem(w);
    expect(shootRate(w, s, d)).toBe(UAS_SHOOT.KIT_RATE);
    d.pos = { x: s.pos.x + 35, z: s.pos.z };
    uasDetectionSystem(w);
    expect(Math.hypot(35, UAS_SHOOT.ALTITUDE)).toBeGreaterThan(UAS_SHOOT.KIT_RANGE);
    expect(shootRate(w, s, d)).toBe(UAS_SHOOT.RIFLE_RATE);
    d.pos = { x: s.pos.x + UAS_SHOOT.RIFLE_RANGE + 5, z: s.pos.z };
    uasDetectionSystem(w);
    expect(shootRate(w, s, d)).toBe(0);
  });

  it("装備の無い者は、陣地に就いているときだけ撃つ。敵兵が見えていればそちらが先", () => {
    const w = world();
    const { s, d } = setup(
      w,
      (x) => !x.quals.counterUas && x.squadId >= 0 && x.role === "rifleman",
      30,
    );
    uasDetectionSystem(w);
    expect(s.seesUas).toContain(d.id);
    expect(shootRate(w, s, d)).toBe(0);
    s.atWindow = true; // 屋外で atWindow = 射撃壕に就いている
    expect(shootRate(w, s, d)).toBe(UAS_SHOOT.RIFLE_RATE);
    s.sees = [w.soldiers.find((x) => x.side === "blue")!.id];
    expect(shootRate(w, s, d)).toBe(0);
  });

  it("隠蔽行動を取っている分隊の者は撃たない。目で捉えていないドローンも撃たない", () => {
    const w = world();
    const { s, d } = setup(w, (x) => x.quals.counterUas === true, 30);
    uasDetectionSystem(w);
    const sq = w.squads.find((q) => q.side === s.side && q.squadId === s.squadId)!;
    sq.uasReact = { kind: "prone", sinceTick: w.tick };
    expect(shootRate(w, s, d)).toBe(0);
    sq.uasReact = null;
    s.seesUas = [];
    expect(shootRate(w, s, d)).toBe(0);
  });

  it("装備の持ち主がいる分隊は、隠れずに撃つほうを選ぶ(S-7 との関係)", () => {
    const w = world();
    const { s } = setup(w, (x) => x.quals.counterUas === true, 30);
    const sq = w.squads.find((q) => q.side === s.side && q.squadId === s.squadId)!;
    sq.uas.set("u1", {
      key: "u1",
      side: "blue",
      pos: { ...s.pos },
      posError: 0,
      hopError: 0,
      lastSeenTick: w.tick,
      confidence: 1,
    });
    expect(aiReactToUas(w, sq)).toBe(false);
    expect(sq.uasReact).toBeNull();
  });

  it("同じ初期条件なら同じティックに落ちる(P3)", () => {
    const a = world(4);
    const b = world(4);
    const da = setup(a, (x) => x.quals.counterUas === true, 35).d;
    const db = setup(b, (x) => x.quals.counterUas === true, 35).d;
    expect(shootFor(a, da, 60)).toBe(shootFor(b, db, 60));
  });
});
