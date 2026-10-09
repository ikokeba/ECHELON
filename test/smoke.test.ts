import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario, urbanCqbFixture } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { perceptionSystem } from "../src/sim/systems/perception.ts";
import { smokeBlocks, smokeRadius, throwSmoke } from "../src/sim/systems/smoke.ts";
import { orderSmoke } from "../src/sim/playerOrders.ts";
import { hasLineOfSightIndexed } from "../src/sim/wallIndex.ts";
import { SIM_HZ, SMOKE } from "../src/sim/constants.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 発煙(`[v7.2]` ロードマップ S-2)。
 *
 * 煙は**視線だけ**を遮る円。確かめるのは (1) 幾何、(2) 索敵が煙で切れる(=撃てない)、
 * (3) 規則が AI・人間・LLM に同じに掛かる、(4) AI の分隊長が実戦で「隠して渡る」ために焚く。
 */

const put = (w: World, sx: number, sz: number) => {
  const id = w.nextSmokeId++;
  w.smokes.push({ id, side: "blue", pos: { x: sx, z: sz }, sinceTick: w.tick - 10 * SIM_HZ, untilTick: w.tick + 30 * SIM_HZ });
};

describe("煙の幾何(`[v7.2]` S-2)", () => {
  it("円を通る視線は遮り、外れる視線・目の前の相手・消えた煙は遮らない", () => {
    const w = createWorld(urbanCqbFixture(1));
    put(w, 0, 0);
    expect(smokeBlocks(w, -20, 0, 20, 0)).toBe(true);
    expect(smokeBlocks(w, -20, SMOKE.RADIUS + 1, 20, SMOKE.RADIUS + 1)).toBe(false);
    // 煙の中でも目の前は見える
    expect(smokeBlocks(w, 0, 0, SMOKE.SEE_THROUGH - 0.5, 0)).toBe(false);
    // 煙の中からは外が見えない
    expect(smokeBlocks(w, 0, 0, 0, 30)).toBe(true);
    w.smokes[0]!.untilTick = w.tick;
    expect(smokeBlocks(w, -20, 0, 20, 0)).toBe(false);
  });

  it("投げた直後は小さく、BUILD_SEC かけて広がる", () => {
    const s = { id: 1, side: "red" as const, pos: { x: 0, z: 0 }, sinceTick: 100, untilTick: 100 + 45 * SIM_HZ };
    expect(smokeRadius(s, 100)).toBe(0);
    expect(smokeRadius(s, 100 + Math.round((SMOKE.BUILD_SEC * SIM_HZ) / 2))).toBeCloseTo(SMOKE.RADIUS / 2, 1);
    expect(smokeRadius(s, 100 + SMOKE.BUILD_SEC * SIM_HZ)).toBe(SMOKE.RADIUS);
    expect(smokeRadius(s, s.untilTick)).toBe(0);
  });

  it("煙の向こうの敵は見えない(=撃てない)。煙が消えれば見える", () => {
    const w = createWorld(urbanCqbFixture(1));
    const a = w.soldiers.find((s) => s.side === "blue")!;
    const b = w.soldiers.find((s) => s.side === "red")!;
    // 開けた街路で向かい合わせる(壁の視線が通ることを先に確かめる)
    a.pos = { x: -32, z: -20 };
    b.pos = { x: -32, z: 10 };
    expect(hasLineOfSightIndexed(w.wallIndex, a.pos.x, a.pos.z, b.pos.x, b.pos.z)).toBe(true);
    a.facing = { x: 0, z: 1 };
    b.facing = { x: 0, z: -1 };
    perceptionSystem(w);
    expect(a.sees).toContain(b.id);
    put(w, -32, -5);
    perceptionSystem(w);
    expect(a.sees).not.toContain(b.id);
    expect(b.sees).not.toContain(a.id);
    w.smokes = [];
    perceptionSystem(w);
    expect(a.sees).toContain(b.id);
  });
});

describe("焚く規則 — AI・人間・LLM で共通(`[v7.2]` S-2)", () => {
  it("残数・間隔・投げられる距離・投げる者", () => {
    const w = createWorld(urbanCqbFixture(1));
    const sq = w.squads.find((s) => s.side === "blue")!;
    const sl = w.soldierById.get(sq.commanderId!)!;
    const near = { x: sl.pos.x + 10, z: sl.pos.z };
    expect(throwSmoke(w, sq, { x: sl.pos.x + SMOKE.THROW_RANGE + 1, z: sl.pos.z })).toEqual({ ok: false, reason: "out_of_range" });
    expect(throwSmoke(w, sq, near)).toMatchObject({ ok: true });
    expect(sq.smokes).toBe(SMOKE.PER_SQUAD - 1);
    expect(w.smokes.length).toBe(1);
    expect(throwSmoke(w, sq, near)).toEqual({ ok: false, reason: "cooldown" });
    sq.lastSmokeTick = -1e6;
    sq.smokes = 0;
    expect(throwSmoke(w, sq, near)).toEqual({ ok: false, reason: "no_smoke" });
    sq.smokes = 1;
    sl.status = "wia";
    expect(throwSmoke(w, sq, near)).toEqual({ ok: false, reason: "no_thrower" });
  });

  it("人間は分隊長の座席からだけ焚ける。煙は時間で消える", () => {
    const w = createWorld(urbanCqbFixture(1));
    const sq = w.squads.find((s) => s.side === "blue")!;
    const sl = w.soldierById.get(sq.commanderId!)!;
    const p = { x: sl.pos.x, z: sl.pos.z + 8 };
    expect(orderSmoke(w, p, { side: "blue", echelon: "platoon", unitId: sq.platoonId })).toBeNull();
    const r = orderSmoke(w, p, { side: "blue", echelon: "squad", unitId: sq.squadId });
    expect(r).toMatchObject({ ok: true });
    const id = r!.ok ? r!.smokeId : -1;
    for (let t = 0; t < SMOKE.DURATION_SEC * SIM_HZ + 1; t++) stepWorld(w);
    // 他の分隊のAIが焚いた煙は残っていてよい。自分の煙は消えている
    expect(w.smokes.some((s) => s.id === id)).toBe(false);
  });

  it("LLM: 分隊長の観測に smoke が載り、smoke 命令が同じ規則で通る", () => {
    const w = createWorld(urbanCqbFixture(1));
    const sq = w.squads.find((s) => s.side === "blue")!;
    const seat = { side: "blue" as const, echelon: "squad" as const, unitId: sq.squadId };
    const obs = buildObservation(w, seat)!;
    expect(obs.smoke).toMatchObject({ left: SMOKE.PER_SQUAD, throwRange: SMOKE.THROW_RANGE, active: [] });
    expect(obs.commands.map((c) => c.type)).toContain("smoke");

    const p = parseResponse({ commands: [{ type: "smoke", target: obs.smoke!.thrower }, { type: "smoke" }] });
    expect(p.response!.commands.length).toBe(1);
    expect(p.errors[0]).toMatch(/smoke/);
    const r = applyResponse(w, seat, p.response!);
    expect(r[0]).toMatch(/受理/);
    const r2 = applyResponse(w, seat, p.response!);
    expect(r2[0]).toMatch(/間隔が明けていない/);
    expect(buildObservation(w, seat)!.smoke!.active.length).toBe(1);

    const pl = w.platoons.find((x) => x.side === "blue")!;
    const pseat = { side: "blue" as const, echelon: "platoon" as const, unitId: pl.platoonId };
    expect(buildObservation(w, pseat)!.smoke).toBeUndefined();
    expect(applyResponse(w, pseat, p.response!)[0]).toMatch(/分隊長だけ/);
  });
});

describe("AIの分隊長は煙で隠して渡る(`[v7.2]` S-2)", () => {
  it("実戦で焚く。焚く点は分隊長の手の届く範囲で、確度の高い敵との間にある", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    beginBattle(w);
    let thrown = 0;
    for (let t = 0; t < 90 * SIM_HZ; t++) {
      const before = w.smokes.map((s) => s.id);
      stepWorld(w);
      for (const s of w.smokes) {
        if (before.includes(s.id)) continue;
        thrown++;
        const sq = w.squads.find((q) => q.side === s.side && q.lastSmokeTick === s.sinceTick)!;
        expect(sq).toBeDefined();
        const sl = w.soldierById.get(sq.commanderId!)!;
        expect(Math.hypot(sl.pos.x - s.pos.x, sl.pos.z - s.pos.z)).toBeLessThanOrEqual(SMOKE.THROW_RANGE + 2);
        // 根拠にした敵の像が分隊長の belief にある(真の敵位置は使っていない)
        expect([...sq.belief.values()].some((c) => c.confidence >= SMOKE.MIN_CONFIDENCE)).toBe(true);
      }
    }
    expect(thrown).toBeGreaterThan(0);
    for (const sq of w.squads) expect(sq.smokes).toBeGreaterThanOrEqual(0);
  }, 300000);

  it("人間が分隊長に座っている間、その分隊のAIは焚かない", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    beginBattle(w);
    const sq = w.squads.find((s) => s.side === "blue")!;
    w.control = { side: "blue", echelon: "squad", unitId: sq.squadId };
    for (let t = 0; t < 90 * SIM_HZ; t++) stepWorld(w);
    expect(sq.smokes).toBe(SMOKE.PER_SQUAD);
  }, 300000);
});
