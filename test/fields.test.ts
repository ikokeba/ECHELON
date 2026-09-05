import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { SCENARIOS, type ScenarioKey } from "../src/sim/scenario.ts";
import { hasLineOfSightIndexed } from "../src/sim/wallIndex.ts";
import { DM_DETECT_RANGE, SIM_HZ } from "../src/sim/constants.ts";
import type { Bounds, Side } from "../src/sim/types.ts";

/**
 * 盤面の健全性(`[v6.11]` 仕様 §7/§10)。
 *
 * 盤面を足すたびに人力で確かめ直すのをやめるためのもの。ここに並ぶ4項目は
 * **すべて実際に踏んだ失敗**で、どれも症状が地形から遠いところに出る:
 *
 *   - 建物が重なる → 互いの部屋の中に壁ができ、経路探索が到達できずグリッド全体を
 *     探索し直す。中隊マップで **491 → 5 t/s**
 *   - 建物が盤外へ出る → ナビグリッドの外に壁ができて同じことが起きる
 *   - 展開地から敵展開地へ射線が抜ける → 選抜射手が開幕から撃ち始め、仕様 §10 の
 *     「市街地の見通し距離が交戦距離を制限する」が成り立たない(`[v6.2]`)
 *   - 実効速度が落ちる → 壁とナビの費用は密度に対して二次で効く(AD-35)
 */

const KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    a.minX < b.maxX - 0.01 &&
    b.minX < a.maxX - 0.01 &&
    a.minZ < b.maxZ - 0.01 &&
    b.minZ < a.maxZ - 0.01
  );
}

describe("盤面の健全性(`[v6.11]`)", () => {
  it.each(KEYS)("'%s' の建物が互いに重ならない", (key) => {
    const w = createWorld(SCENARIOS[key].make());
    expect(w.buildings.length).toBeGreaterThan(20);
    for (let i = 0; i < w.buildings.length; i++) {
      for (let j = i + 1; j < w.buildings.length; j++) {
        const a = w.buildings[i]!;
        const b = w.buildings[j]!;
        expect
          .soft(overlaps(a.bounds, b.bounds), `建物 ${a.id} と ${b.id} が重なっている`)
          .toBe(false);
      }
    }
  });

  it.each(KEYS)("'%s' の建物が盤内に収まっている", (key) => {
    const w = createWorld(SCENARIOS[key].make());
    for (const b of w.buildings) {
      expect.soft(b.bounds.minX, `建物 ${b.id}`).toBeGreaterThanOrEqual(w.bounds.minX);
      expect.soft(b.bounds.maxX, `建物 ${b.id}`).toBeLessThanOrEqual(w.bounds.maxX);
      expect.soft(b.bounds.minZ, `建物 ${b.id}`).toBeGreaterThanOrEqual(w.bounds.minZ);
      expect.soft(b.bounds.maxZ, `建物 ${b.id}`).toBeLessThanOrEqual(w.bounds.maxZ);
    }
  });

  /**
   * `[v6.2]` の要件。基準は同条件の格子盤面(2本 / 282m)なので、上限は 20 本に置く。
   */
  it.each(KEYS)("'%s' に展開地から敵展開地へ抜ける射線がほとんど無い(仕様 §10)", (key) => {
    const w = createWorld(SCENARIOS[key].make());
    let open = 0;
    for (const a of w.soldiers.filter((s) => s.side === "blue")) {
      for (const d of w.soldiers.filter((s) => s.side === "red")) {
        if (Math.hypot(a.pos.x - d.pos.x, a.pos.z - d.pos.z) > DM_DETECT_RANGE) continue;
        if (hasLineOfSightIndexed(w.wallIndex, a.eye.x, a.eye.z, d.eye.x, d.eye.z)) open++;
      }
    }
    expect(open).toBeLessThanOrEqual(20);
  });

  /**
   * **短いウォームアップでは測れない。** 経路探索の費用は戦況が進むほど上がる
   * (部隊が建物へ入り、到達できない目標が増える)。序盤1200ティックで測ると
   * 400 t/s に見えた盤面が、実戦300秒を通すと 30 t/s だった。実戦相当で測る。
   *
   * 実測は 146〜356 t/s。下限はその半分あたりに置き、**設計の問題として気付ける**
   * ところで止める(壁とナビの費用は密度に対して二次で効く。AD-35)。
   */
  it.each(KEYS)("'%s' が実戦の長さを通して実用的な速度で回る", (key) => {
    const w = createWorld(SCENARIOS[key].make());
    beginPlanning(w);
    beginBattle(w);
    const t0 = Date.now();
    runTicks(w, 150 * SIM_HZ);
    const tps = (150 * SIM_HZ) / ((Date.now() - t0) / 1000);
    expect(tps, `${key} は ${tps.toFixed(0)} t/s`).toBeGreaterThan(70);
  }, 300000);

  /**
   * 盤面が点対称であること = 地形由来の有利不利が無いこと(仕様 §2/§13)。
   * 幾何そのものではなく、**この engine が保証している不変条件**で測る —
   * 陣営ラベルを入れ替えたら結果がそのまま反転する(`symmetry.test.ts` と同じ規則)。
   */
  it.each(KEYS)("'%s' で陣営ラベルの入替に対し結果が反転する(仕様 §2/§13)", (key) => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const base = SCENARIOS[key].make(7);
    const swapped = SCENARIOS[key].make(7);
    for (const s of swapped.soldiers) s.side = flip(s.side);
    for (const p of swapped.fireteamPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.squadPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.platoonPlans ?? []) p.side = flip(p.side);
    for (const p of swapped.companyPlans ?? []) p.side = flip(p.side);
    // **陣営に紐づくものは漏れなく入れ替える**(`symmetry.test.ts` と同じ注意)。
    // CCP を取り残すと「青軍が赤軍の負傷者集合点へ運ぶ」歪んだ盤面になり、
    // コードの対称性ではなくシナリオの不整合を測ってしまう
    if (swapped.ccp) swapped.ccp = { blue: swapped.ccp.red, red: swapped.ccp.blue };

    const a = createWorld(base);
    const b = createWorld(swapped);
    runTicks(a, 45 * SIM_HZ);
    runTicks(b, 45 * SIM_HZ);
    const kia = (w: typeof a, side: Side) =>
      w.soldiers.filter((s) => s.side === side && s.status === "kia").length;
    expect(kia(a, "blue")).toBe(kia(b, "red"));
    expect(kia(a, "red")).toBe(kia(b, "blue"));
  });

  /**
   * `[v6.11]` 市街地の盤面の拠点はすべて**屋外**(広場・塀で囲った敷地)。
   * 室内の一室を拠点にすると確保が最良22%で止まる(`[v6.10]` F-9 の残件)ので、
   * 盤面を足すときはここを守る。
   *
   * 除外が2枚ある。格子盤面は室内拠点のまま(比較の基準として残す)。
   * **塹壕戦は意図的に室内**(堡塁の中)— そこが拠点であることが、守る側を塹壕へ
   * 入れて銃眼に就かせ、攻める側に塹壕の掃討を強いる仕掛けそのものだから。
   * しかも堡塁は単純な形の1棟なので、市街地の奥の一室のようには迷わない
   * (実測でも両軍とも自分の堡塁を確保できている)。
   */
  it.each(KEYS.filter((k) => k !== "company" && k !== "trench"))(
    "'%s' の拠点は建物の中に無い",
    (key) => {
      const w = createWorld(SCENARIOS[key].make());
      expect(w.objectives.length).toBeGreaterThan(0);
      for (const o of w.objectives) {
        const inside = w.buildings.some(
          (b) =>
            o.pos.x >= b.bounds.minX &&
            o.pos.x <= b.bounds.maxX &&
            o.pos.z >= b.bounds.minZ &&
            o.pos.z <= b.bounds.maxZ,
        );
        expect.soft(inside, `${o.label} が建物の中にある`).toBe(false);
      }
    },
  );

  /**
   * `[v6.12]` 塹壕は「細長い建物」として作ってあり、**最初から屋内ナビが張られて
   * いなければただの障害物になる**(誰も「突入」しないまま守る側が入って戦う場所
   * なので、通常の遅延構築では張られない)。張り忘れると部隊は塹壕を迂回する。
   */
  it("塹壕はすべて最初から屋内ナビが張られている", () => {
    const w = createWorld(SCENARIOS.trench.make());
    // 堡塁・交通壕・前線壕・支援壕 — 掩蔽壕2棟を除く全部
    expect(w.navBuildings.size).toBeGreaterThanOrEqual(w.buildings.length - 2);
    expect(w.buildings.reduce((a, b) => a + b.windows.length, 0)).toBeGreaterThan(100);
  });
});
