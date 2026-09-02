import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { OBJECTIVE, SIM_HZ } from "../src/sim/constants.ts";
import { beginPlanning } from "../src/sim/c2/planning.ts";
import { isDefender } from "../src/sim/c2/planning.ts";
import type { Scenario } from "../src/sim/types.ts";

/**
 * 攻防非対称戦(仕様 §12「モード別の追加条件」)。`[v6.8]`
 *
 * 「攻撃側は制限時間内に拠点確保、防御側はそれまで持ちこたえれば勝利」。
 * 遭遇戦と違って**勝利条件が左右で異なる**唯一の型なので、対称性テスト
 * (`test/symmetry.test.ts`)はこの型を使わない。
 */
function assaultScenario(timeLimitSec: number): Scenario {
  const sc = platoonClashScenario(1);
  sc.mode = "assault";
  sc.attacker = "blue";
  sc.timeLimitSec = timeLimitSec;
  return sc;
}

describe("攻防非対称戦(仕様 §12)`[v6.8]`", () => {
  it("既定は遭遇戦 — 何も指定しなければ従来どおり全拠点が中立で始まる", () => {
    const w = createWorld(platoonClashScenario(1));
    expect(w.mode).toBe("meeting");
    expect(w.timeLimitTicks).toBe(0);
    expect(w.objectives.every((o) => o.owner === null && o.progress === 0)).toBe(true);
  });

  it("防御側が開始時点で全拠点を保有する", () => {
    const w = createWorld(assaultScenario(300));
    expect(w.mode).toBe("assault");
    expect(w.attacker).toBe("blue");
    // 攻撃側が blue なので防御側は red
    expect(w.objectives.every((o) => o.owner === "red" && o.progress === 1)).toBe(true);
    expect(w.timeLimitTicks).toBe(300 * SIM_HZ);
  });

  it("制限時間まで持ちこたえたら防御側の勝ち(時間切れ)", () => {
    // 部隊が接触する前に時間切れになる長さにして、決着理由だけを見る
    const w = createWorld(assaultScenario(3));
    runTicks(w, 3 * SIM_HZ + 2);
    expect(w.victory).not.toBeNull();
    expect(w.victory!.winner).toBe("red");
    expect(w.victory!.reason).toBe("timeout");
  });

  it("防御側は開始直後には勝てない(遭遇戦の規則がそのまま当たらない)", () => {
    const w = createWorld(assaultScenario(600));
    // 遭遇戦の規則なら「過半数を HOLD_TO_WIN_SEC 保持」で防御側が即勝ちしてしまう
    runTicks(w, Math.round((OBJECTIVE.HOLD_TO_WIN_SEC + 5) * SIM_HZ));
    expect(w.victory).toBeNull();
  });

  it("攻撃側が過半数を奪って保持すれば、制限時間内でも勝てる", () => {
    const w = createWorld(assaultScenario(600));
    // 攻撃側(blue)が過半数を確保した状態を作る
    for (const o of w.objectives.slice(0, 2)) {
      o.owner = "blue";
      o.progress = 1;
      o.progressBy = "blue";
    }
    // 拠点を維持するため、赤を拠点から遠ざける
    for (const s of w.soldiers) {
      if (s.side === "red") s.pos = { x: 100, z: 90 };
    }
    runTicks(w, Math.round((OBJECTIVE.HOLD_TO_WIN_SEC + 2) * SIM_HZ));
    expect(w.victory?.winner).toBe("blue");
    expect(w.victory?.reason).toBe("objectives");
  }, 120000);

  it("防御側の任務は「保有している」だけでは完了しない(立案)", () => {
    const w = createWorld(assaultScenario(600));
    beginPlanning(w);
    expect(isDefender(w, "red")).toBe(true);
    expect(isDefender(w, "blue")).toBe(false);
    const def = w.companies.find((c) => c.side === "red");
    // 小隊シナリオにも中隊コントローラは立つ。防御側の命令文は「保持」を含む
    if (def?.plan) {
      const withObj = def.plan.tasks.filter((t) => t.objectiveId !== null);
      expect(withObj.length).toBeGreaterThan(0);
      expect(withObj.some((t) => t.order.includes("保持"))).toBe(true);
    }
    const atk = w.companies.find((c) => c.side === "blue");
    if (atk?.plan) {
      expect(atk.plan.tasks.some((t) => t.order.includes("確保せよ"))).toBe(true);
    }
  });
});
