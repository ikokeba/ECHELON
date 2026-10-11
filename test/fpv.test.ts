import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginBattle, beginPlanning } from "../src/sim/c2/planning.ts";
import { DEFAULT_FORCE, playForce } from "../src/sim/force.ts";
import { droneOf } from "../src/sim/systems/drone.ts";
import { fpvSystem, fpvsOf, launchFpv } from "../src/sim/systems/fpv.ts";
import { shootRate } from "../src/sim/systems/uasShoot.ts";
import { uasDetectionSystem } from "../src/sim/systems/uasDetect.ts";
import { orderFpv } from "../src/sim/playerOrders.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import { FPV, SIM_HZ, UAS_SHOOT } from "../src/sim/constants.ts";
import type { Side, Soldier, Vec2 } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 自爆ドローン(FPV)・徘徊型弾薬(`[v7.7]` ロードマップ B-2)。
 *
 *   - 中隊の像の地点へ飛び、**上から見えた敵**を自分のカメラで捉えて突っ込む
 *   - 建物の中の敵は狙えない(屋内に入れば安全 — ロードマップ §6.3 の一線)
 *   - 観測ドローンと同じく見つかり・撃ち落とされる(速いので当たりにくい)
 *   - AI・人間・LLM が同じ `launchFpv` を通る(P4)。陣営で分岐しない(P2)、決定論(P3)
 */

const SPEC = { ...DEFAULT_FORCE, fpv: true };
const world = (seed = 1): World => createWorld(companyClashScenario(seed, { blue: SPEC, red: { ...SPEC } }));
const blueCo = (w: World) => w.companies.find((c) => c.side === "blue")!;

/** 赤の兵士を1人、地点に立たせる(止まっている) */
function plant(w: World, at: Vec2): Soldier {
  const s = w.soldiers.find((x) => x.side === "red" && x.status === "ok" && x.hqRole === null)!;
  s.pos = { ...at };
  s.eye = { ...at };
  s.path = [];
  s.pathIdx = 0;
  return s;
}

/** FPV だけを回す(ほかの兵は動かない)。起爆したら true */
function fly(w: World, sec: number): boolean {
  for (let t = 0; t < sec * SIM_HZ; t++) {
    w.fx.length = 0;
    w.gunshots.length = 0;
    fpvSystem(w);
    if (w.fx.some((f) => f.kind === "fpv")) return true;
    w.tick++;
  }
  return false;
}

describe("自爆ドローン(`[v7.7]` B-2)— 編成", () => {
  it("編成で付けると、中隊本部の副中隊長が操縦手になり機体を持つ。観測ドローンとは別物", () => {
    const f = playForce();
    f.blue.fpv = true;
    const w = createWorld(companyClashScenario(1, f));
    const teams = fpvsOf(w, blueCo(w));
    expect(teams.length).toBe(1);
    expect(teams[0]!.batteriesLeft).toBe(FPV.AIRFRAMES);
    expect(w.soldierById.get(teams[0]!.operatorId)!.hqRole).toBe("xo");
    // 観測ドローンは観測ドローンのまま
    expect(droneOf(w, blueCo(w))!.kind).toBe("recon");
    // 赤は付けていない
    expect(fpvsOf(w, w.companies.find((c) => c.side === "red")!)).toEqual([]);
    // 既定(テスト・画面とも)では持たない
    expect(createWorld(companyClashScenario(1)).drones.some((d) => d.kind === "fpv")).toBe(false);
  });
});

describe("自爆ドローン(`[v7.7]` B-2)— 飛行と起爆", () => {
  it("屋外の敵は自分のカメラで捉えて突っ込み、機体が1つ減って次の準備に入る", () => {
    let downed = 0;
    for (const seed of [1, 2, 3, 4]) {
      const w = world(seed);
      const t = plant(w, { x: 0, z: 0 });
      const r = launchFpv(w, blueCo(w), { x: 8, z: 5 });
      expect(r.ok).toBe(true);
      expect(fly(w, 60)).toBe(true);
      const d = fpvsOf(w, blueCo(w))[0]!;
      expect(d.state).toBe("swapping");
      expect(d.batteriesLeft).toBe(FPV.AIRFRAMES - 1);
      if (t.status !== "ok") downed++;
    }
    // 当たれば負傷・戦死(KILL_CHANCE 0.75)。4回のうち少なくとも1回は倒れる
    expect(downed).toBeGreaterThan(0);
  });

  it("建物の中の敵は狙えない — 見つけられないまま落ち、誰も倒れない", () => {
    const w = world(1);
    const room = w.buildings[0]!.rooms[0]!.bounds;
    const inside = { x: (room.minX + room.maxX) / 2, z: (room.minZ + room.maxZ) / 2 };
    // 屋外の敵は遠ざけ、建物の中に1人だけ置く
    for (const s of w.soldiers) if (s.side === "red") s.pos = { x: 200, z: 160 };
    const t = plant(w, inside);
    expect(launchFpv(w, blueCo(w), inside).ok).toBe(true);
    expect(fly(w, FPV.ENDURANCE_SEC + 5)).toBe(false);
    expect(t.status).toBe("ok");
    expect(fpvsOf(w, blueCo(w))[0]!.batteriesLeft).toBe(FPV.AIRFRAMES - 1);
  });

  it("操縦手から遠すぎる地点・機体の準備中は飛ばせない。使い切ると spent", () => {
    const w = world(1);
    const co = blueCo(w);
    expect(launchFpv(w, co, { x: 0, z: 400 })).toEqual({ ok: false, reason: "out_of_range" });
    expect(launchFpv(w, co, { x: 0, z: 0 }).ok).toBe(true);
    expect(launchFpv(w, co, { x: 0, z: 0 })).toEqual({ ok: false, reason: "none_ready" });
    const d = fpvsOf(w, co)[0]!;
    d.batteriesLeft = 1;
    fly(w, FPV.ENDURANCE_SEC + 2);
    expect(d.state).toBe("spent");
    expect(launchFpv(w, co, { x: 0, z: 0 })).toEqual({ ok: false, reason: "spent" });
  });

  it("操縦手が倒れると飛んでいる機体も残りの機体も失われる", () => {
    const w = world(1);
    const co = blueCo(w);
    launchFpv(w, co, { x: 0, z: 0 });
    const d = fpvsOf(w, co)[0]!;
    w.soldierById.get(d.operatorId)!.status = "wia";
    fpvSystem(w);
    expect(d.state).toBe("lost");
    expect(launchFpv(w, co, { x: 0, z: 0 })).toEqual({ ok: false, reason: "lost" });
  });

  it("地上から見つかり、撃ち落とせる(観測ドローンより当たりにくい)。落ちても次の機体は残る", () => {
    const w = world(1);
    const co = blueCo(w);
    launchFpv(w, co, { x: 0, z: 0 });
    const d = fpvsOf(w, co)[0]!;
    const s = plant(w, { x: 0, z: 0 });
    d.pos = { x: 20, z: 0 };
    uasDetectionSystem(w);
    expect(s.seesUas).toContain(d.id);
    // 敵兵が見えていても、向かってくる自爆ドローンは撃つ。小銃の確率に FPV の倍率が掛かる
    expect(shootRate(w, s, d)).toBeCloseTo(UAS_SHOOT.RIFLE_RATE * FPV.SHOOT_MUL, 9);
    // 撃ち落とされた
    d.state = "lost";
    d.shotDown = true;
    fpvSystem(w);
    expect(d.state).toBe("swapping");
    expect(d.batteriesLeft).toBe(FPV.AIRFRAMES - 1);
  });
});

describe("自爆ドローン(`[v7.7]` B-2)— 誰が飛ばすか", () => {
  it("AIの中隊長は実戦で飛ばし、敵に損害が出る", () => {
    const f = playForce();
    f.blue.fpv = true;
    f.red.fpv = true;
    const w = createWorld(companyClashScenario(1, f));
    beginPlanning(w);
    beginBattle(w);
    let det = 0;
    let victims = 0;
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      stepWorld(w);
      for (const fx of w.fx) if (fx.kind === "fpv") { det++; victims += fx.victims; }
    }
    expect(det).toBeGreaterThan(0);
    expect(victims).toBeGreaterThan(0);
  }, 400000);

  it("人間・LLM は中隊長の座席から同じ関数で飛ばし、中隊長以外は飛ばせない", () => {
    const w = world(1);
    const seat = { side: "blue" as Side, echelon: "company" as const, unitId: blueCo(w).companyId };
    expect(orderFpv(w, { x: 0, z: 0 }, { ...seat, echelon: "platoon", unitId: 0 })).toBeNull();
    const obs = buildObservation(w, seat)!;
    expect(obs.fpv).toMatchObject({ ready: 1, maxRange: FPV.MAX_RANGE });
    expect(obs.commands.some((c) => c.type === "fpv")).toBe(true);
    const p = parseResponse({ commands: [{ type: "fpv", target: { x: 0, z: 0 } }, { type: "fpv" }] });
    expect(p.response?.commands).toEqual([{ type: "fpv", target: { x: 0, z: 0 } }]);
    expect(p.errors[0]).toMatch(/fpv/);
    const out = applyResponse(w, seat, p.response!);
    expect(out.join("\n")).toMatch(/fpv .*受理/);
    expect(fpvsOf(w, blueCo(w))[0]!.state).toBe("flying");
  });

  /**
   * 陣営ラベルの入れ替えでの厳密な反転は、中隊戦では FPV が無くても 50秒あまりで崩れる
   * (既存の対称性テストは小さな盤面・短い時間で測っている)ので、ここでは決定論だけを固定する。
   * 陣営で分岐しないこと(P2)は、コードに陣営の分岐が無いことと、上の各テストが両軍に同じ規則を
   * 掛けていることで担保する
   */
  it("同じ初期条件なら、同じティックに同じ地点で起爆する(P3)", () => {
    const f = playForce();
    f.blue.fpv = true;
    f.red.fpv = true;
    const run = (): string[] => {
      const w = createWorld(companyClashScenario(2, f));
      const log: string[] = [];
      for (let t = 0; t < 200 * SIM_HZ; t++) {
        stepWorld(w);
        for (const fx of w.fx) {
          if (fx.kind === "fpv") log.push(`${w.tick}:${fx.side}:${fx.at.x.toFixed(3)},${fx.at.z.toFixed(3)}:${fx.victims}`);
        }
      }
      return log;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  }, 400000);
});
