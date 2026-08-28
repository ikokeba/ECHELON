import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { RADIO_LATENCY_SEC, REPORT_INTERVAL_SEC, SIM_HZ } from "../src/sim/constants.ts";

describe("情報の階層化(仕様 §5)", () => {
  it("編成が5階層のうち小隊まで組み上がっている", () => {
    const w = createWorld(platoonClashScenario(1));
    expect(w.platoons.length).toBe(2); // 両陣営に1個小隊
    expect(w.squads.length).toBe(6); // 各小隊3個分隊
    expect(w.fireteams.length).toBe(12); // 各分隊2個FT
    expect(w.soldiers.length).toBe(54); // 各分隊9名
  });

  it("小隊長のbeliefは無線報告が届くまで空のまま", () => {
    const w = createWorld(platoonClashScenario(1));
    // 索敵が始まっても、報告間隔+遅延を経るまで小隊長は何も知らない
    for (const pl of w.platoons) expect(pl.belief.size).toBe(0);
  });

  it("報告には遅延がある — 送信から到達までティックが進む", () => {
    const w = createWorld(platoonClashScenario(1));
    const latencyTicks = Math.round(RADIO_LATENCY_SEC * SIM_HZ);
    runTicks(w, Math.round(REPORT_INTERVAL_SEC * SIM_HZ) + 1);
    // 報告が生成されたら、deliverTick は必ず sentTick より後
    for (const r of w.reports) {
      expect(r.deliverTick).toBe(r.sentTick + latencyTicks);
      expect(r.deliverTick).toBeGreaterThan(w.tick - 1);
    }
  });

  it("小隊長は生の視界を持たない — beliefは分隊長のそれより遅れる", () => {
    const w = createWorld(platoonClashScenario(3));
    runTicks(w, 2400);

    for (const pl of w.platoons) {
      const squads = w.squads.filter((s) => s.side === pl.side && s.platoonId === pl.platoonId);
      const squadNewest = Math.max(
        ...squads.flatMap((sq) => [...sq.belief.values()].map((c) => c.lastSeenTick)),
        -1,
      );
      const platoonNewest = Math.max(
        ...[...pl.belief.values()].map((c) => c.lastSeenTick),
        -1,
      );
      if (platoonNewest >= 0 && squadNewest >= 0) {
        // 小隊長の最新情報が分隊長のそれを上回ることは構造上ありえない
        expect(platoonNewest).toBeLessThanOrEqual(squadNewest);
      }
    }
  });

  it("無線を1ホップ経た情報は位置の粒度が粗くなる(仕様 §5)", () => {
    const w = createWorld(platoonClashScenario(3));
    runTicks(w, 2400);

    for (const pl of w.platoons) {
      for (const c of pl.belief.values()) {
        // 報告経由の接触は必ずホップ由来の誤差を持つ。直接視認(hopError 0)はありえない
        expect(c.hopError).toBeGreaterThan(0);
      }
    }
    // 分隊長は直接視認なのでホップ誤差ゼロ
    for (const sq of w.squads) {
      for (const c of sq.belief.values()) {
        expect(c.hopError).toBe(0);
      }
    }
  });

  it("敵側の接触が自軍のbeliefに混入しない", () => {
    const w = createWorld(platoonClashScenario(4));
    runTicks(w, 1800);
    for (const pl of w.platoons) {
      for (const c of pl.belief.values()) expect(c.side).not.toBe(pl.side);
    }
    for (const sq of w.squads) {
      for (const c of sq.belief.values()) expect(c.side).not.toBe(sq.side);
    }
  });
});

describe("小隊長の指揮(仕様 §3 ②, §6)", () => {
  it("接敵前は前進(traveling)、接敵情報が入れば警戒を上げる", () => {
    const w = createWorld(platoonClashScenario(1));
    runTicks(w, 60);
    // 開始直後、小隊長はまだ何も知らないので速度優先
    for (const ft of w.fireteams) expect(ft.technique).toBe("traveling");

    runTicks(w, 3000);
    // 交戦が始まれば、少なくとも一部は警戒前進か躍進前進へ上がっている
    const raised = w.fireteams.filter((f) => f.technique !== "traveling");
    expect(raised.length).toBeGreaterThan(0);
  });

  it("小隊長が麾下分隊へ担当区域を割り当てる", () => {
    const w = createWorld(platoonClashScenario(1));
    runTicks(w, 300);
    for (const pl of w.platoons) {
      expect(pl.squadObjectives.size).toBeGreaterThan(0);
      // 各分隊に別々の担当区域が割り当てられている(全部同じ点ではない)
      const pts = [...pl.squadObjectives.values()];
      const unique = new Set(pts.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`));
      expect(unique.size).toBe(pts.length);
    }
  });

  it("分隊長が接敵時に麾下FTへ火力/機動の役割を割り当てる(仕様 §6)", () => {
    const w = createWorld(platoonClashScenario(1));
    runTicks(w, 2400);
    const roles = w.fireteams.map((f) => f.assignedRole).filter((r) => r !== null);
    expect(roles).toContain("base");
    expect(roles).toContain("maneuver");
  });
});

describe("小隊規模の戦闘", () => {
  it("決着がつく — 睨み合いのまま膠着しない", () => {
    const w = createWorld(platoonClashScenario(7));
    runTicks(w, 9000);
    const casualties = w.soldiers.filter((s) => s.status !== "ok").length;
    expect(casualties).toBeGreaterThan(5);
  }, 30000);

  it("陣営バイアスがない(仕様 §2/§13)", () => {
    let blueWins = 0;
    let redWins = 0;
    const N = 12;
    for (let seed = 1; seed <= N; seed++) {
      const w = createWorld(platoonClashScenario(seed));
      runTicks(w, 9000);
      const b = w.soldiers.filter((s) => s.side === "blue" && s.status === "ok").length;
      const r = w.soldiers.filter((s) => s.side === "red" && s.status === "ok").length;
      if (b > r) blueWins++;
      else if (r > b) redWins++;
    }
    const decided = blueWins + redWins;
    expect(decided).toBeGreaterThan(N * 0.5);
    expect(Math.abs(blueWins - redWins)).toBeLessThanOrEqual(decided * 0.5);
  }, 120000);
});
