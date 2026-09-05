import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { exposedFraction } from "../src/sim/c2/assembly.ts";
import { SCENARIOS, type ScenarioKey } from "../src/sim/scenario.ts";
import { collidesWall } from "../src/sim/geometry.ts";
import { insideBounds } from "../src/sim/cqb.ts";
import { SIM_HZ } from "../src/sim/constants.ts";
import type { Side } from "../src/sim/types.ts";

/**
 * 初期展開 — 集結地の占領(`[v6.13]` 仕様 §3① / §11)。
 *
 * 指摘:「開始時になんで開けた土地から始まるんでしょうか」。展開線が直値(z=±140)で
 * 置かれていて、そこが盤面の市街地より手前の何も無い場所だったのが原因。
 * 立案フェーズで地形から配置を決め直す。
 *
 * ここで固定するのは4つ:
 *   1. 開豁地に立つ割合が実際に下がること(効いていること)
 *   2. 壁の中・入れない建物の中に置かないこと(動けなくなる)
 *   3. **陣営ラベルの入替に対して結果が反転すること**(仕様 §2/§13)
 *   4. 敵情を見ないこと(仕様 §5)— 敵を動かしても自軍の配置が変わらない
 */

const KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

describe("集結地の占領(`[v6.13]`)", () => {
  it.each(KEYS)("'%s' で開豁地に立つ兵士が大きく減る", (key) => {
    const raw = createWorld(SCENARIOS[key].make());
    const before = exposedFraction(raw, "blue");

    const w = createWorld(SCENARIOS[key].make());
    beginPlanning(w);
    beginBattle(w);
    const after = exposedFraction(w, "blue");

    // 実測は 8〜31%。半分未満まで下がっていること、かつ元より必ず良いこと
    expect.soft(after, `${key}: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%`)
      .toBeLessThan(0.5);
    expect(after).toBeLessThanOrEqual(before);
  });

  it.each(KEYS)("'%s' で壁の中や入れない建物の中に置かない", (key) => {
    const w = createWorld(SCENARIOS[key].make());
    beginPlanning(w);
    beginBattle(w);
    for (const s of w.soldiers) {
      expect.soft(collidesWall(w.walls, s.pos.x, s.pos.z, 0.3), `兵士 ${s.id} が壁の中`).toBe(
        false,
      );
      const host = w.buildings.find((b) => insideBounds(b.bounds, s.pos));
      // 屋内に置いてよいのは、最初から屋内ナビが張られている建物(塹壕)だけ。
      // それ以外の建物へ置くと、突入が決まるまでナビが無いので一歩も動けない
      if (host) {
        expect.soft(w.navBuildings.has(host.id), `兵士 ${s.id} が入れない建物の中`).toBe(true);
      }
    }
  });

  /**
   * 配置は指揮の結果なので、コードに陣営を見た分岐があってはならない。
   * `symmetry.test.ts` と同じラベル入替で見る。
   */
  it.each(KEYS)("'%s' で陣営ラベルの入替に対し配置が反転する(仕様 §2/§13)", (key) => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const base = SCENARIOS[key].make(3);
    const swapped = SCENARIOS[key].make(3);
    for (const s of swapped.soldiers) s.side = flip(s.side);
    for (const p of swapped.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.squadPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.companyPlans ?? []) p.side = flip(p.side);
    if (swapped.ccp) swapped.ccp = { blue: swapped.ccp.red, red: swapped.ccp.blue };

    const a = createWorld(base);
    const b = createWorld(swapped);
    beginPlanning(a);
    beginPlanning(b);

    // a の blue が就いた位置の集合と、b の red が就いた位置の集合が一致する
    const key2 = (p: { x: number; z: number }) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    const set = (w: typeof a, side: Side) =>
      new Set(w.soldiers.filter((s) => s.side === side).map((s) => key2(s.pos)));
    const ab = set(a, "blue");
    const br = set(b, "red");
    expect(ab.size).toBe(br.size);
    for (const k of ab) expect.soft(br.has(k), `${k} が入替側に無い`).toBe(true);
  });

  /**
   * 仕様 §5。立案は敵情を見ないので、**敵をどこへ動かしても自軍の配置は変わらない**。
   * これが崩れると、配置が敵の位置を覗いていることになる。
   */
  it("敵を動かしても自軍の集結地は変わらない(仕様 §5)", () => {
    const a = createWorld(SCENARIOS.oldQuarter.make(4));
    beginPlanning(a);

    const b = createWorld(SCENARIOS.oldQuarter.make(4));
    // 赤を横へ大きくずらしてから立案する
    for (const s of b.soldiers) if (s.side === "red") s.pos = { x: s.pos.x - 120, z: s.pos.z };
    beginPlanning(b);

    const blueOf = (w: typeof a) =>
      w.soldiers
        .filter((s) => s.side === "blue")
        .map((s) => `${s.pos.x.toFixed(2)},${s.pos.z.toFixed(2)}`)
        .join("|");
    expect(blueOf(a)).toBe(blueOf(b));
  });

  it("集結地から前進でき、部隊が動き出す", () => {
    const w = createWorld(SCENARIOS.oldQuarter.make(1));
    beginPlanning(w);
    beginBattle(w);
    const start = w.soldiers.filter((s) => s.side === "blue").map((s) => ({ ...s.pos }));
    runTicks(w, 40 * SIM_HZ);
    const moved = w.soldiers
      .filter((s) => s.side === "blue" && s.status === "ok")
      .filter((s, i) => Math.hypot(s.pos.x - start[i]!.x, s.pos.z - start[i]!.z) > 8).length;
    // 集結地に置いたまま動けない(壁や到達不能な場所へ置いた)のが最悪の失敗
    expect(moved).toBeGreaterThan(40);
  }, 120000);
});
