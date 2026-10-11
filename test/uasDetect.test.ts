import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { uasDetectionSystem, uasKey } from "../src/sim/systems/uasDetect.ts";
import { radioSystem } from "../src/sim/radio.ts";
import { resolveView } from "../src/sim/viewpoint.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { RADIO_LATENCY_SEC, SIM_HZ, SMOKE, UAS_DETECT } from "../src/sim/constants.ts";
import type { Drone, FireteamState, Scenario, Side, Soldier, Vec2 } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 地上からドローンに気づく(`[v7.5]` ロードマップ S-6、設計メモ §6.3)。
 * 一線: 気づいたことは見た・聞いた者のFTの記憶に入り、無線で遅れて上がる(P1)。
 * 兵士の接触とは混ぜない。
 */

const SPEC = { ...DEFAULT_FORCE, drone: true };
const scenario = (seed = 1): Scenario =>
  companyClashScenario(seed, { blue: SPEC, red: { ...SPEC } });
const other = (s: Side): Side => (s === "blue" ? "red" : "blue");

/** その陣営の、全員が屋外にいる小銃FTを1つ。隊員と一緒に返す */
function outdoorTeam(w: World, side: Side): { ft: FireteamState; men: Soldier[] } {
  for (const ft of w.fireteams) {
    if (ft.side !== side) continue;
    const men = w.soldiers.filter(
      (s) => s.side === side && s.squadId === ft.squadId && s.fireteamId === ft.ftIndex,
    );
    const indoors = men.some((m) =>
      w.buildings.some(
        (b) =>
          m.pos.x >= b.bounds.minX &&
          m.pos.x <= b.bounds.maxX &&
          m.pos.z >= b.bounds.minZ &&
          m.pos.z <= b.bounds.maxZ,
      ),
    );
    if (men.length > 0 && !indoors) return { ft, men };
  }
  throw new Error("屋外のFTが無い");
}

function centroid(men: readonly Soldier[]): Vec2 {
  return {
    x: men.reduce((a, m) => a + m.pos.x, 0) / men.length,
    z: men.reduce((a, m) => a + m.pos.z, 0) / men.length,
  };
}

/** 敵のドローンを、そのFTの重心から dist m 離れた上空に置いて飛ばす */
function hover(w: World, side: Side, at: Vec2, dist: number): Drone {
  const d = w.drones.find((x) => x.side === other(side))!;
  d.state = "flying";
  d.target = null;
  d.pos = { x: at.x + dist, z: at.z };
  return d;
}

const minDist = (men: readonly Soldier[], p: Vec2) =>
  Math.min(...men.map((m) => Math.hypot(m.pos.x - p.x, m.pos.z - p.z)));

describe("ドローンを見る・聞く(`[v7.5]` S-6)", () => {
  for (const side of ["blue", "red"] as const) {
    it(`${side}: 屋外から ${UAS_DETECT.SIGHT}m 以内なら目で見る。位置は正確で、兵士の接触には入らない`, () => {
      const w = createWorld(scenario());
      const { ft, men } = outdoorTeam(w, side);
      const d = hover(w, side, centroid(men), 50);
      uasDetectionSystem(w);
      const c = ft.uas.get(uasKey(d.id))!;
      expect(c).toBeDefined();
      expect(c.heard).toBeUndefined();
      expect(c.pos).toEqual(d.pos);
      expect(c.posError).toBe(0);
      expect(men.some((m) => m.seesUas?.includes(d.id))).toBe(true);
      // 兵士の接触(FTの記憶)には混ぜない
      expect([...ft.memory.keys()].some((k) => k.startsWith("u"))).toBe(false);
    });
  }

  it(`${UAS_DETECT.SIGHT}m より遠く ${UAS_DETECT.HEAR}m 以内は羽音だけ。方角と刻んだ距離の粗い位置になる`, () => {
    const w = createWorld(scenario());
    const { ft, men } = outdoorTeam(w, "blue");
    const d = hover(w, "blue", centroid(men), 105);
    const r = minDist(men, d.pos);
    expect(r).toBeGreaterThan(UAS_DETECT.SIGHT);
    expect(r).toBeLessThanOrEqual(UAS_DETECT.HEAR);
    uasDetectionSystem(w);
    const c = ft.uas.get(uasKey(d.id))!;
    expect(c.heard).toBe(true);
    expect(c.posError).toBe(UAS_DETECT.HEARD_ERROR);
    expect(c.pos).not.toEqual(d.pos);
    // 方角の区分と距離の刻みのぶんしかずれない
    expect(Math.hypot(c.pos.x - d.pos.x, c.pos.z - d.pos.z)).toBeLessThan(UAS_DETECT.HEARD_ERROR);
    expect(men.every((m) => !m.seesUas?.length)).toBe(true);
  });

  it("聞こえる距離より遠い・地上にあるドローンには気づかない", () => {
    const w = createWorld(scenario());
    const { ft, men } = outdoorTeam(w, "blue");
    const d = hover(w, "blue", centroid(men), UAS_DETECT.HEAR + 20);
    uasDetectionSystem(w);
    expect(ft.uas.size).toBe(0);
    d.pos = { ...centroid(men) };
    d.state = "ready";
    uasDetectionSystem(w);
    expect(ft.uas.size).toBe(0);
  });

  it("煙越しには見えない(羽音は聞こえる)", () => {
    const w = createWorld(scenario());
    const { ft, men } = outdoorTeam(w, "blue");
    const c0 = centroid(men);
    const d = hover(w, "blue", c0, 60);
    // FTを囲む広がりきった煙
    w.smokes.push({ id: 1, side: "blue", pos: { ...c0 }, sinceTick: -1000, untilTick: 1_000_000 });
    expect(SMOKE.RADIUS).toBeGreaterThan(0);
    for (const m of men) m.pos = { x: c0.x, z: c0.z };
    uasDetectionSystem(w);
    expect(ft.uas.get(uasKey(d.id))!.heard).toBe(true);
    expect(men.every((m) => !m.seesUas?.length)).toBe(true);
  });

  it("屋内からは見えず(窓に就いていなければ)、羽音も半分の距離までしか届かない", () => {
    const w = createWorld(scenario());
    const { ft, men } = outdoorTeam(w, "blue");
    const b = w.buildings[0]!.bounds;
    const inside = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
    for (const m of men) {
      m.pos = { ...inside };
      m.atWindow = false;
    }
    const near = UAS_DETECT.HEAR * UAS_DETECT.MUFFLED_MUL - 5;
    const d = hover(w, "blue", inside, near);
    uasDetectionSystem(w);
    expect(ft.uas.get(uasKey(d.id))!.heard).toBe(true);
    expect(men.every((m) => !m.seesUas?.length)).toBe(true);

    const w2 = createWorld(scenario());
    const t2 = outdoorTeam(w2, "blue");
    for (const m of t2.men) {
      m.pos = { ...inside };
      m.atWindow = false;
    }
    hover(w2, "blue", inside, UAS_DETECT.HEAR * UAS_DETECT.MUFFLED_MUL + 10);
    uasDetectionSystem(w2);
    expect(t2.ft.uas.size).toBe(0);
  });
});

describe("気づいたことの流れ(`[v7.5]` S-6、§5 / P1)", () => {
  it("FTに属さない分隊長・本部要員も気づく。分隊長なら分隊長の像、中隊本部なら中隊長の像へ直接", () => {
    const w = createWorld(scenario());
    const sl = w.soldiers.find((s) => s.side === "blue" && s.isSquadLeader && s.fireteamId < 0)!;
    const sq = w.squads.find((q) => q.side === "blue" && q.squadId === sl.squadId)!;
    const d = hover(w, "blue", sl.pos, 30);
    // 分隊の他の者は聞こえない遠くへ
    for (const m of w.soldiers) {
      if (m.side === "blue" && m.id !== sl.id) m.pos = { x: m.pos.x + 1000, z: m.pos.z };
    }
    sl.atWindow = false;
    uasDetectionSystem(w);
    expect(sl.seesUas).toContain(d.id);
    expect(sq.uas.get(uasKey(d.id))!.heard).toBeUndefined();

    const w2 = createWorld(scenario());
    const hq = w2.soldiers.find((s) => s.side === "blue" && s.hqRole === "co")!;
    const co = w2.companies.find((c) => c.side === "blue")!;
    const d2 = hover(w2, "blue", hq.pos, 30);
    uasDetectionSystem(w2);
    expect(co.uas.has(uasKey(d2.id))).toBe(true);
  });

  it("分隊長はすぐ、小隊長・中隊長は無線の遅延を経て知る。兵士の像には入らない", () => {
    const w = createWorld(scenario());
    const { ft, men } = outdoorTeam(w, "blue");
    const d = hover(w, "blue", centroid(men), 40);
    const key = uasKey(d.id);
    // 無線の経路だけを見るため、このFT以外(小隊長・中隊本部など、自分の耳で聞ける者)は遠ざける
    for (const m of w.soldiers) {
      if (m.side === "blue" && !men.includes(m)) m.pos = { x: m.pos.x + 1000, z: m.pos.z };
    }
    const sq = w.squads.find((s) => s.side === "blue" && s.squadId === ft.squadId)!;
    const pl = w.platoons.find((p) => p.side === "blue" && p.platoonId === sq.platoonId)!;
    const co = w.companies.find((c) => c.side === "blue" && c.companyId === pl.companyId)!;
    let plTick = -1;
    let coTick = -1;
    const t0 = w.tick;
    for (let i = 0; i < 4 * RADIO_LATENCY_SEC * SIM_HZ && coTick < 0; i++) {
      uasDetectionSystem(w);
      radioSystem(w);
      if (i === 0) {
        expect(sq.uas.has(key)).toBe(true);
        expect(pl.uas.has(key)).toBe(false);
      }
      if (plTick < 0 && pl.uas.has(key)) plTick = w.tick;
      if (coTick < 0 && co.uas.has(key)) coTick = w.tick;
      w.tick++;
    }
    const lat = Math.round(RADIO_LATENCY_SEC * SIM_HZ);
    expect(plTick - t0).toBeGreaterThanOrEqual(lat);
    expect(coTick - plTick).toBeGreaterThanOrEqual(lat);
    // 1ホップごとに粗くなる
    expect(co.uas.get(key)!.hopError).toBeGreaterThan(pl.uas.get(key)!.hopError);
    // 兵士の接触の像には入らない(迫撃砲・擲弾・機動の向きに効かない)
    for (const m of [sq.belief, pl.belief, co.belief]) {
      expect([...m.keys()].some((k) => k.startsWith("u"))).toBe(false);
    }
    // 臨時報告のきっかけとして記録に残る
    expect(w.flashLog.some((f) => f.reasons.includes("uas"))).toBe(true);
  });

  it("画面の像と LLM の観測に、兵士の接触とは別の欄で出る", () => {
    const w = createWorld(scenario());
    const { ft, men } = outdoorTeam(w, "blue");
    hover(w, "blue", centroid(men), 40);
    uasDetectionSystem(w);
    radioSystem(w);
    const view = resolveView(w, { side: "blue", echelon: "squad", squadId: ft.squadId });
    expect(view.uas).toHaveLength(1);
    const seat = { side: "blue" as const, echelon: "squad" as const, unitId: ft.squadId };
    const obs = buildObservation(w, seat)!;
    expect(obs.uas).toHaveLength(1);
    expect(obs.contacts.length).toBe(view.known);
    // 神視点では像ではなく実体を描くので空
    expect(resolveView(w, { side: "blue", echelon: "truth" }).uas).toEqual([]);
  });

  it("戦闘の中でも気づく(AIの中隊長が飛ばしたドローンに、相手の分隊が気づく)", () => {
    const w = createWorld(scenario());
    let noticed = false;
    for (let t = 0; t < 60 * SIM_HZ && !noticed; t += SIM_HZ) {
      runTicks(w, SIM_HZ);
      noticed = w.squads.some((s) => s.uas.size > 0);
    }
    expect(noticed).toBe(true);
  }, 120000);
});
