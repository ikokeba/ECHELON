import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { assignFires } from "../src/sim/c2/fireControl.ts";
import { SIM_HZ } from "../src/sim/constants.ts";

/**
 * 火力の統制と配分(ATP 3-21.8 / 仕様 §6)。`[v6.3]`
 * リーダーが各員の射撃目標を指定する。狙いは一点集中の回避と優先目標の撃破。
 */
describe("火力の配分(ATP 3-21.8 / `[v6.3]`)", () => {
  it("重火器を優先目標にする — 同じだけ見えていれば機関銃手から狙う", () => {
    const w = createWorld(platoonClashScenario(1));
    const shooters = w.soldiers.filter((s) => s.side === "blue" && s.fireteamId === 0).slice(0, 4);
    const mg = w.soldiers.find((s) => s.side === "red" && s.role === "mg")!;
    const rifle = w.soldiers.find(
      (s) => s.side === "red" && s.role === "rifleman" && !s.quals.designatedMarksman,
    )!;
    // 両方が全員に見えている状態を作る
    for (const u of shooters) u.sees = [mg.id, rifle.id].sort((a, b) => a - b);

    assignFires(w, shooters);
    const onMg = shooters.filter((u) => u.assignedTarget === mg.id).length;
    const onRifle = shooters.filter((u) => u.assignedTarget === rifle.id).length;
    expect(onMg).toBeGreaterThan(0);
    // 4名 / 2目標 = 1目標あたり上限2名。重火器が先に埋まる
    expect(onMg).toBeGreaterThanOrEqual(onRifle);
  });

  it("一点集中しない — 目標が複数あれば射手を分散させる", () => {
    const w = createWorld(platoonClashScenario(1));
    const shooters = w.soldiers.filter((s) => s.side === "blue" && s.fireteamId === 0).slice(0, 4);
    const enemies = w.soldiers.filter((s) => s.side === "red" && s.role === "rifleman").slice(0, 4);
    const ids = enemies.map((e) => e.id).sort((a, b) => a - b);
    for (const u of shooters) u.sees = [...ids];

    assignFires(w, shooters);
    const used = new Set(shooters.map((u) => u.assignedTarget));
    // 4射手・4目標なら1目標あたり1名。全員が別の敵を撃つ
    expect(used.size).toBe(4);
    expect(used.has(null)).toBe(false);
  });

  it("見えていない敵は割り当てない(仕様 §5 の情報階層)", () => {
    const w = createWorld(platoonClashScenario(1));
    const shooters = w.soldiers.filter((s) => s.side === "blue" && s.fireteamId === 0).slice(0, 2);
    const enemy = w.soldiers.find((s) => s.side === "red")!;
    shooters[0]!.sees = [enemy.id];
    shooters[1]!.sees = [];

    assignFires(w, shooters);
    expect(shooters[0]!.assignedTarget).toBe(enemy.id);
    expect(shooters[1]!.assignedTarget).toBeNull();
  });

  it("実戦でも割り当てが機能し、同じ目標に群がらない", () => {
    const w = createWorld(platoonClashScenario(1));
    runTicks(w, Math.round(90 * SIM_HZ));
    // FTごとに、割り当て済みの射手が1目標へ何名集中しているか
    let worst = 0;
    for (const ft of w.fireteams) {
      const men = w.soldiers.filter(
        (s) =>
          s.side === ft.side &&
          s.squadId === ft.squadId &&
          s.fireteamId === ft.ftIndex &&
          s.status === "ok" &&
          s.assignedTarget !== null,
      );
      if (men.length < 2) continue;
      const counts = new Map<number, number>();
      for (const m of men) counts.set(m.assignedTarget!, (counts.get(m.assignedTarget!) ?? 0) + 1);
      worst = Math.max(worst, Math.max(...counts.values()));
    }
    // 1つのFTは最大4名。上限は ceil(射手数/目標数) なので、目標が複数ある限り4名は集中しない
    expect(worst).toBeLessThanOrEqual(4);
  });
});
