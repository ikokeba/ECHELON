import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { OBJECTIVE, SIM_HZ } from "../src/sim/constants.ts";
import type { Side, Soldier } from "../src/sim/types.ts";

/** 兵士 n 名を拠点の中心へ置き、それ以外は遠くへ退ける。 */
function stage(
  w: ReturnType<typeof createWorld>,
  objIndex: number,
  counts: Partial<Record<Side, number>>,
): void {
  const o = w.objectives[objIndex]!;
  const placed: Record<Side, number> = { blue: 0, red: 0 };
  for (const s of w.soldiers) {
    const want = counts[s.side] ?? 0;
    if (placed[s.side] < want && s.status === "ok") {
      s.pos = { x: o.pos.x, z: o.pos.z };
      placed[s.side]++;
    } else {
      // 拠点から十分離す(判定半径の外)
      s.pos = { x: o.pos.x + 400, z: o.pos.z + 400 };
    }
    s.path = [];
    s.pathIdx = 0;
  }
}

/** C2に動かされないよう、毎ティック配置を固定したまま進める。 */
function holdTicks(
  w: ReturnType<typeof createWorld>,
  ticks: number,
  objIndex: number,
  counts: Partial<Record<Side, number>>,
): void {
  for (let i = 0; i < ticks; i++) {
    stage(w, objIndex, counts);
    runTicks(w, 1);
  }
}

describe("拠点確保(仕様 §12 メイン条件)", () => {
  it("シナリオに拠点が定義され、初期状態は中立", () => {
    const w = createWorld(platoonClashScenario(1));
    expect(w.objectives.length).toBe(3);
    for (const o of w.objectives) {
      expect(o.owner).toBeNull();
      expect(o.progress).toBe(0);
    }
  });

  it("小拠点は1名で60秒、大拠点は1名で180秒が基準(仕様 §12 確定値)", () => {
    expect(OBJECTIVE.BASE_SEC.small).toBe(60);
    expect(OBJECTIVE.BASE_SEC.large).toBe(180);
  });

  it("1名で基準時間をかけて確保できる", () => {
    const w = createWorld(demoCrossingScenario(1));
    const o = w.objectives[0]!;
    expect(o.size).toBe("small");

    holdTicks(w, Math.round((OBJECTIVE.BASE_SEC.small - 2) * SIM_HZ), 0, { blue: 1 });
    expect(o.owner).toBeNull(); // まだ確保しきっていない
    holdTicks(w, Math.round(4 * SIM_HZ), 0, { blue: 1 });
    expect(o.owner).toBe("blue");
  }, 60000);

  it("人数が多いほど早く確保できる(比例加速)", () => {
    const progressAfter = (n: number, sec: number): number => {
      const w = createWorld(demoCrossingScenario(1));
      holdTicks(w, Math.round(sec * SIM_HZ), 0, { blue: n });
      return w.objectives[0]!.progress;
    };
    const one = progressAfter(1, 12);
    const three = progressAfter(3, 12);
    expect(three).toBeGreaterThan(one * 2.5);
  }, 60000);

  it("加速上限を超えた人数は追加効果を持たない(拠点の容量限界)", () => {
    const progressAfter = (n: number, sec: number): number => {
      const w = createWorld(demoCrossingScenario(1));
      holdTicks(w, Math.round(sec * SIM_HZ), 0, { blue: n });
      return w.objectives[0]!.progress;
    };
    const atCap = progressAfter(OBJECTIVE.MAX_CAPTURERS.small, 10);
    const overCap = progressAfter(OBJECTIVE.MAX_CAPTURERS.small + 4, 10);
    expect(overCap).toBeCloseTo(atCap, 5);
  }, 60000);

  it("拠点内に敵がいる間は確保カウントが完全に停止する(コンテスト状態)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const o = w.objectives[0]!;

    holdTicks(w, Math.round(10 * SIM_HZ), 0, { blue: 2 });
    const before = o.progress;
    expect(before).toBeGreaterThan(0);

    // 敵が1名入っただけで止まる
    holdTicks(w, Math.round(10 * SIM_HZ), 0, { blue: 2, red: 1 });
    expect(o.contested).toBe(true);
    expect(o.progress).toBeCloseTo(before, 5);
  }, 60000);

  it("確保済みの拠点は敵に奪い返される", () => {
    const w = createWorld(demoCrossingScenario(1));
    const o = w.objectives[0]!;
    holdTicks(w, Math.round((OBJECTIVE.BASE_SEC.small + 2) * SIM_HZ), 0, { blue: 1 });
    expect(o.owner).toBe("blue");

    // 赤が入って剥がしにかかる
    holdTicks(w, Math.round(20 * SIM_HZ), 0, { red: 3 });
    expect(o.progress).toBeLessThan(1);
  }, 60000);
});

describe("決着(仕様 §12)", () => {
  it("戦闘可能な兵士が尽きた側は負ける(戦力の枯渇)", () => {
    const w = createWorld(demoCrossingScenario(1));
    for (const s of w.soldiers) {
      if (s.side === "red") s.status = "kia";
    }
    runTicks(w, 2);
    expect(w.victory).not.toBeNull();
    expect(w.victory!.winner).toBe("blue");
    expect(w.victory!.reason).toBe("annihilation");
  });

  it("過半数の拠点を一定時間維持すれば勝利(拠点確保)", () => {
    const w = createWorld(platoonClashScenario(1));
    // 3拠点のうち2つを青が確保済みにする
    for (const o of w.objectives.slice(0, 2)) {
      o.owner = "blue";
      o.progress = 1;
      o.progressBy = "blue";
    }
    // 兵士は拠点から離しておく(奪い返しやコンテストを起こさない)
    for (const s of w.soldiers) s.pos = { x: 0, z: s.side === "blue" ? -38 : 38 };

    runTicks(w, Math.round((OBJECTIVE.HOLD_TO_WIN_SEC + 2) * SIM_HZ));
    expect(w.victory).not.toBeNull();
    expect(w.victory!.winner).toBe("blue");
    expect(w.victory!.reason).toBe("objectives");
  }, 60000);

  it("過半数を維持できなくなれば保持時間はリセットされる", () => {
    const w = createWorld(platoonClashScenario(1));
    for (const o of w.objectives.slice(0, 2)) {
      o.owner = "blue";
      o.progress = 1;
      o.progressBy = "blue";
    }
    for (const s of w.soldiers) s.pos = { x: 0, z: s.side === "blue" ? -38 : 38 };

    runTicks(w, Math.round((OBJECTIVE.HOLD_TO_WIN_SEC / 2) * SIM_HZ));
    expect(w.victory).toBeNull();
    // 1つ失う
    w.objectives[0]!.owner = null;
    w.objectives[0]!.progress = 0;
    runTicks(w, 2);
    expect(w.majoritySince.blue).toBeNull();
  }, 60000);

  it("倒れている兵士は拠点の確保に数えない", () => {
    const w = createWorld(demoCrossingScenario(1));
    const o = w.objectives[0]!;
    const men: Soldier[] = [];
    for (const s of w.soldiers) {
      if (s.side === "blue" && men.length < 2) {
        men.push(s);
        s.pos = { x: o.pos.x, z: o.pos.z };
        s.status = "wia"; // 全員行動不能
      } else {
        s.pos = { x: o.pos.x + 400, z: o.pos.z + 400 };
      }
    }
    runTicks(w, Math.round(5 * SIM_HZ));
    expect(o.progress).toBe(0);
  });
});
