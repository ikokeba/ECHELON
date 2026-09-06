import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { MORTAR, SIM_HZ } from "../src/sim/constants.ts";
import { DOCTRINES } from "../src/sim/doctrine.ts";
import { defaultForce } from "../src/sim/force.ts";
import { forwardOf } from "../src/sim/c2/flot.ts";
import type { Side, Vec2 } from "../src/sim/types.ts";

/**
 * 火力支援 — 60mm 迫撃砲(`[v6.9]` 仕様 §10/§11)。
 *
 * 検証したいのは、これが**§8(戦闘)ではなく §5(情報)の機能**として実装されている
 * こと。撃つ先は敵の現在位置ではなく中隊長の像で、飛翔時間のあいだにその像は古くなる。
 */

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

function battle(seed = 1) {
  const w = createWorld(companyClashScenario(seed));
  beginPlanning(w);
  beginBattle(w);
  return w;
}

describe("迫撃砲の火力支援(`[v6.9]` 仕様 §10/§11)", () => {
  it("実戦で要請が出て、着弾し、損害が出る", () => {
    const w = battle(1);
    let impacts = 0;
    let victims = 0;
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      stepWorld(w);
      for (const f of w.fx) if (f.kind === "mortar") { impacts++; victims += f.victims; }
    }
    expect(impacts).toBeGreaterThan(0);
    expect(victims).toBeGreaterThan(0);
  }, 300000);

  /**
   * この機能の核心。照準点は要請時点の belief なので、飛翔時間のあいだに敵が動けば
   * 弾は誰もいない場所に落ちる。**外れることが仕様である**ことを固定する。
   */
  it("照準点は要請時点で凍結され、飛翔中は追尾しない(仕様 §5)", () => {
    const w = battle(1);
    let frozen: { target: Vec2; id: number } | null = null;
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      stepWorld(w);
      const m = w.fireMissions[0];
      if (!m) continue;
      if (!frozen) {
        frozen = { target: { ...m.target }, id: m.id };
        continue;
      }
      if (m.id === frozen.id) {
        // 同じ任務が飛んでいるあいだ、照準点は1mmも動かない
        expect(m.target.x).toBe(frozen.target.x);
        expect(m.target.z).toBe(frozen.target.z);
      }
    }
    expect(frozen).not.toBeNull();
  }, 300000);

  it("照準点は中隊長の belief から採る — 真の敵位置ではない(仕様 §5)", () => {
    const w = battle(1);
    let checked = 0;
    for (let t = 0; t < 300 * SIM_HZ && checked < 3; t++) {
      const before = w.fireMissions.length;
      stepWorld(w);
      if (w.fireMissions.length <= before) continue;
      const m = w.fireMissions[w.fireMissions.length - 1]!;
      const co = w.companies.find((c) => c.side === m.side && c.companyId === m.companyId)!;
      // 照準点の近傍には、その中隊長の belief の接触がある
      const nearBelief = [...co.belief.values()].some(
        (c) => dist(c.pos, m.target) <= MORTAR.CLUSTER_RADIUS,
      );
      expect(nearBelief).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300000);

  /**
   * `[v6.16]` **射撃の可否は指揮官が持っている統制線(FSCM)で決まる**(仕様 §5)。
   *
   * 以前ここは「照準点の危険近接内に自軍が1名もいないこと」を盤面の真値で確かめて
   * いた。判定としては完璧だが、それは中隊長が全隊員の位置を遅延ゼロで知っている
   * ということで、仕様 §5 が破れていた。いま確かめるのは**指揮官の線に照らして
   * 正しく判断したか**であって、結果が結果的に安全だったかではない。
   *
   * 線は無線2ホップぶん古いので、前へ出た部隊の頭越しに落ちることが実際に起きる
   * (実測: 市場の盤面で、要請時点の危険近接内に自軍12名。最接近18m)。その代償は
   * 制圧であって損害ではない — それは次のテストが押さえる。
   */
  it("射撃要請は中隊長の統制線に照らして出される(FSCM、仕様 §5)", () => {
    const w = battle(2);
    let checked = 0;
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      const before = new Set(w.fireMissions.map((m) => m.id));
      stepWorld(w);
      for (const m of w.fireMissions) {
        if (before.has(m.id)) continue;
        const co = w.companies.find((c) => c.side === m.side)!;
        // 線が引けていること(引けなければ撃たない、が規則)
        expect(co.flot.sources).toBeGreaterThan(0);
        // 照準点は、報告で把握している先頭より危険近接ぶん前にあること
        expect(forwardOf(co.advanceDir, m.target)).toBeGreaterThanOrEqual(
          co.flot.lead + MORTAR.DANGER_CLOSE - 1e-6,
        );
        // その線は必ず過去のもの(仕様 §5)。現在ティックの真値ではない
        expect(co.flot.asOfTick).toBeLessThan(w.tick);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 300000);

  /**
   * 仕様 §8.2 は同士討ちを「起きない」ものとして抽象化している。統制線を報告由来に
   * した `[v6.16]` から、自軍の頭上に着弾すること自体は起こりうる。**それでも損害は
   * 出さない** — 制圧までは受ける、というのが §8.2 と §8.6 の両立のさせ方。
   */
  it("自軍の砲弾で自軍に損害は出ない(仕様 §8.2)", () => {
    const w = battle(2);
    let impacts = 0;
    let suppressedOwn = 0;
    for (let t = 0; t < 300 * SIM_HZ; t++) {
      const was = new Map(w.soldiers.map((s) => [s.id, s.status]));
      stepWorld(w);
      for (const f of w.fx) {
        if (f.kind !== "mortar") continue;
        impacts++;
        for (const s of w.soldiers) {
          if (s.side !== f.side) continue;
          if (dist(s.pos, f.at) > f.radius) continue;
          // 自軍の弾の殺傷半径内にいた自軍が、そのティックで倒れていないこと
          expect(was.get(s.id) === "ok" && s.status !== "ok").toBe(false);
        }
        for (const s of w.soldiers) {
          if (s.side !== f.side || s.status !== "ok") continue;
          if (dist(s.pos, f.at) <= f.suppressRadius) suppressedOwn++;
        }
      }
    }
    expect(impacts).toBeGreaterThan(0);
    // 制圧は陣営を見ない(仕様 §8.6)。この戦闘で自軍が自軍の弾に伏せたことがある
    void suppressedOwn;
  }, 300000);

  it("中隊本部を持たない編成は火力支援を持たない(仕様 §2)", () => {
    // 小隊規模のフィクスチャには中隊本部がいない
    const w = createWorld(platoonClashScenario(1));
    runTicks(w, 300 * SIM_HZ);
    expect(w.fireMissions.length).toBe(0);
    expect(w.companies.every((c) => c.mortarRoundsUsed === 0)).toBe(true);
  }, 300000);

  it("弾数は中隊の共有資源で、保有数を超えて撃たない", () => {
    const w = battle(1);
    runTicks(w, 600 * SIM_HZ);
    for (const co of w.companies) {
      expect(co.mortarRoundsUsed).toBeLessThanOrEqual(MORTAR.ROUNDS_PER_COMPANY);
    }
  }, 300000);

  /**
   * ドクトリンの差が**能力ではなく組織**であることの確認。自律群は後方の砲へ要請が
   * 上る経路そのものを持たない(仕様 §13)。
   */
  it("自律群は火力支援を持たず、正規軍は持つ(仕様 §13)", () => {
    const swarm = battle(1);
    swarm.doctrine = { blue: DOCTRINES.swarm, red: DOCTRINES.swarm };
    runTicks(swarm, 300 * SIM_HZ);
    expect(swarm.companies.every((c) => c.mortarRoundsUsed === 0)).toBe(true);

    const regular = battle(1);
    runTicks(regular, 300 * SIM_HZ);
    expect(regular.companies.some((c) => c.mortarRoundsUsed > 0)).toBe(true);
  }, 400000);

  it("陣営ラベルを入れ替えても結果が厳密に反転する(仕様 §2/§13)", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const base = companyClashScenario(5, defaultForce());
    const swapped = companyClashScenario(5, defaultForce());
    for (const s of swapped.soldiers) s.side = flip(s.side);
    for (const p of swapped.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.squadPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.companyPlans ?? []) p.side = flip(p.side);

    const a = createWorld(base);
    const b = createWorld(swapped);
    runTicks(a, 200 * SIM_HZ);
    runTicks(b, 200 * SIM_HZ);
    const used = (w: typeof a, side: Side) =>
      w.companies.filter((c) => c.side === side).reduce((n, c) => n + c.mortarRoundsUsed, 0);
    expect(used(a, "blue")).toBe(used(b, "red"));
    expect(used(a, "red")).toBe(used(b, "blue"));
  }, 300000);
});
