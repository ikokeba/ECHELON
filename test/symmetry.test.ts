import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import {
  demoCrossingScenario,
  platoonClashScenario,
  companyClashScenario,
} from "../src/sim/scenario.ts";
import type { Scenario, Side } from "../src/sim/types.ts";

const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");

/**
 * 配置は一切変えずに陣営ラベルだけを入れ替える。
 *
 * **陣営に紐づくものは漏れなく入れ替える必要がある**。1つでも取り残すと、
 * 「青軍が赤軍の指揮所と負傷者集合点を使う」ような歪んだ盤面になり、
 * コードの対称性ではなくシナリオの不整合を測ってしまう。
 */
function swapSides(sc: Scenario): Scenario {
  for (const s of sc.soldiers) s.side = flip(s.side);
  for (const p of sc.fireteamPlans ?? []) p.side = flip(p.side);
  for (const p of sc.squadPlans ?? []) p.side = flip(p.side);
  for (const p of sc.platoonPlans ?? []) p.side = flip(p.side);
  for (const p of sc.companyPlans ?? []) p.side = flip(p.side);
  if (sc.ccp) sc.ccp = { blue: sc.ccp.red, red: sc.ccp.blue };
  return sc;
}

function kiaBySide(sc: Scenario, ticks: number): Record<Side, number> {
  const w = createWorld(sc);
  runTicks(w, ticks);
  return {
    blue: w.soldiers.filter((s) => s.side === "blue" && s.status === "kia").length,
    red: w.soldiers.filter((s) => s.side === "red" && s.status === "kia").length,
  };
}

/**
 * 戦力対称性(仕様 §2/§13)の検証。
 *
 * 仕様が要求しているのは「敵軍を反転した自軍として扱い、特別扱いをしない」こと、
 * すなわち**コードに陣営を優遇する分岐が存在しない**ことである。
 *
 * これを勝率の統計で測ると検出力が弱く、地形由来の偏りと区別もつかない。
 * そこで**配置を固定したまま陣営ラベルだけを入れ替え、結果が厳密に反転するか**を
 * 見る。反転すれば、シミュレーションは陣営ラベルを一切参照していないことの証明になる
 * (地形や開始位置に由来する有利不利があっても、それは陣営とは無関係だと分かる)。
 */
describe("戦力対称性(仕様 §2/§13)", () => {
  const cases = [
    ["分隊規模", demoCrossingScenario, 9000],
    ["小隊規模", platoonClashScenario, 9000],
    ["中隊規模", companyClashScenario, 1500],
  ] as const;

  for (const [name, mk, ticks] of cases) {
    it(`${name}: 陣営ラベルを入れ替えると結果が厳密に反転する`, () => {
      // 統計ではなく厳密な不変条件なので、少数のシードで十分に証明できる
      for (let seed = 1; seed <= 3; seed++) {
        const normal = kiaBySide(mk(seed), ticks);
        const swapped = kiaBySide(swapSides(mk(seed)), ticks);

        // ラベルを入れ替えた世界の blue は、元の世界の red と同じ運命をたどる。
        // ここがずれるなら、どこかに陣営を見て挙動を変える分岐がある。
        expect(swapped.blue).toBe(normal.red);
        expect(swapped.red).toBe(normal.blue);
      }
    }, 120000);
  }

  it("兵士のMOS構成も陣営間で完全に同一", () => {
    const w = createWorld(platoonClashScenario(1));
    const profile = (side: Side) =>
      w.soldiers
        .filter((s) => s.side === side)
        .map((s) => `${s.role}:${s.quals.medicalCrossTrained}:${s.quals.designatedMarksman}`)
        .sort()
        .join("|");
    expect(profile("blue")).toBe(profile("red"));
  });
});

/**
 * 開始位置に由来する偏り。**陣営バイアスとは別物**である点に注意。
 *
 * 上の入れ替え検証が示すとおりコードは陣営ラベルを参照していないが、それでも
 * 「-z側から進む」ことと「+z側から進む」ことは対称な地形上でも完全に等価にならない。
 * 経路探索の等コスト決着・最近傍ノードの探索順・兵士分離の押し出し順など、
 * 決定論を保つための tie-break がいずれも厳密な点対称性を持たないため。
 *
 * ハッシュによる等コスト決着の導入で偏りは約半減した(計測: 戦死者差 45 → 21、
 * 全戦死者約220名に対して約10%)。ゲーム上の公平性としては、シナリオ設計で
 * 開始位置を入れ替えた対戦を用意することで打ち消せる範囲。
 * 完全な点対称性の達成はコスト対効果が悪いため、既知の制約として記録する。
 */
describe("開始位置由来の偏り(既知の制約)", () => {
  it("極端な偏りはない — 一方が他方の2倍を超えて損害を受けたりはしない", () => {
    let minusZ = 0;
    let plusZ = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const k = kiaBySide(platoonClashScenario(seed), 9000);
      minusZ += k.blue; // blue は -z 側から進む
      plusZ += k.red;
    }
    const ratio = Math.max(minusZ, plusZ) / Math.max(1, Math.min(minusZ, plusZ));
    expect(ratio).toBeLessThan(2);
  }, 120000);
});
