import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import {
  companyClashScenario,
  demoCrossingScenario,
  platoonClashScenario,
} from "../src/sim/scenario.ts";
import { beginBattle, beginPlanning } from "../src/sim/c2/planning.ts";
import { OBJECTIVE, SIM_HZ } from "../src/sim/constants.ts";
import { clampToObjective, heldObjectiveNear } from "../src/sim/c2/objectiveHold.ts";
import type { Objective, Side, Soldier } from "../src/sim/types.ts";

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
  });

  it("人数が多いほど早く確保できる(比例加速)", () => {
    const progressAfter = (n: number, sec: number): number => {
      const w = createWorld(demoCrossingScenario(1));
      holdTicks(w, Math.round(sec * SIM_HZ), 0, { blue: n });
      return w.objectives[0]!.progress;
    };
    const one = progressAfter(1, 12);
    const three = progressAfter(3, 12);
    expect(three).toBeGreaterThan(one * 2.5);
  });

  it("加速上限を超えた人数は追加効果を持たない(拠点の容量限界)", () => {
    const progressAfter = (n: number, sec: number): number => {
      const w = createWorld(demoCrossingScenario(1));
      holdTicks(w, Math.round(sec * SIM_HZ), 0, { blue: n });
      return w.objectives[0]!.progress;
    };
    const atCap = progressAfter(OBJECTIVE.MAX_CAPTURERS.small, 10);
    const overCap = progressAfter(OBJECTIVE.MAX_CAPTURERS.small + 4, 10);
    expect(overCap).toBeCloseTo(atCap, 5);
  });

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
  });

  it("確保済みの拠点は敵に奪い返される", () => {
    const w = createWorld(demoCrossingScenario(1));
    const o = w.objectives[0]!;
    holdTicks(w, Math.round((OBJECTIVE.BASE_SEC.small + 2) * SIM_HZ), 0, { blue: 1 });
    expect(o.owner).toBe("blue");

    // 赤が入って剥がしにかかる
    holdTicks(w, Math.round(20 * SIM_HZ), 0, { red: 3 });
    expect(o.progress).toBeLessThan(1);
  });
});

describe("確保済み拠点の保持(仕様 §12 / [v6.1])", () => {
  it("heldObjectiveNear: 近い自軍拠点を返し、遠い/敵所有は返さない", () => {
    const w = createWorld(platoonClashScenario(1));
    const [alpha, bravo, charlie] = w.objectives;
    alpha!.owner = "blue";
    charlie!.owner = "red";

    expect(heldObjectiveNear(w, "blue", { x: alpha!.pos.x + 3, z: alpha!.pos.z })?.id).toBe(
      alpha!.id,
    );
    // 外周から 30m 超は守備範囲外(遠くを行軍中の部隊を足止めしない)
    expect(heldObjectiveNear(w, "blue", { x: alpha!.pos.x + 80, z: alpha!.pos.z })).toBeNull();
    // 敵所有は「守る」対象ではない
    expect(heldObjectiveNear(w, "blue", { x: charlie!.pos.x + 2, z: charlie!.pos.z })).toBeNull();
    // 中立でも自軍が確保を進めていれば守る
    bravo!.progressBy = "blue";
    expect(heldObjectiveNear(w, "blue", { x: bravo!.pos.x, z: bravo!.pos.z })?.id).toBe(bravo!.id);
  });

  it("clampToObjective: 拠点外の狙い点を半径内へ引き戻す", () => {
    const o: Objective = {
      id: 1,
      label: "X",
      pos: { x: 0, z: 0 },
      radius: 10,
      size: "large",
      owner: null,
      progress: 0,
      progressBy: null,
      contested: false,
    };
    const clamped = clampToObjective({ x: 100, z: 0 }, o, 0.5);
    expect(Math.hypot(clamped.x, clamped.z)).toBeCloseTo(5, 5);
    // 既に内側ならそのまま
    expect(clampToObjective({ x: 2, z: 0 }, o, 0.5)).toEqual({ x: 2, z: 0 });
  });

  it("確保した分隊は別方面で接敵しても拠点付近に留まる", () => {
    const w = createWorld(platoonClashScenario(1));
    const alpha = w.objectives[0]!; // x = -26
    alpha.owner = "blue";
    alpha.progress = 1;
    alpha.progressBy = "blue";

    // 青分隊0を ALPHA 上へ。赤は青分隊2(x≈30)の正面へ固めて「別方面の脅威」を作る。
    const putSquad = (side: Side, squadId: number, at: { x: number; z: number }): void => {
      for (const s of w.soldiers) {
        if (s.side === side && s.squadId === squadId) {
          s.pos = { ...at };
          s.path = [];
          s.pathIdx = 0;
        }
      }
    };
    putSquad("blue", 0, { x: alpha.pos.x, z: alpha.pos.z });

    for (let i = 0; i < Math.round(30 * SIM_HZ); i++) {
      // 赤小隊を毎ティック青分隊2の正面へ貼り直す(脅威源を固定)
      for (const s of w.soldiers) {
        if (s.side === "red") {
          s.pos = { x: 28, z: -20 };
          s.path = [];
          s.pathIdx = 0;
        }
      }
      runTicks(w, 1);
    }

    const sq0 = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0 && s.status === "ok");
    const cx = sq0.reduce((a, s) => a + s.pos.x, 0) / sq0.length;
    const cz = sq0.reduce((a, s) => a + s.pos.z, 0) / sq0.length;
    // 脅威(x≈28)へ行進せず、ALPHA(x=-26)の周辺に居続けている
    expect(Math.hypot(cx - alpha.pos.x, cz - alpha.pos.z)).toBeLessThan(alpha.radius + 14);
  });
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
  });

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
  });

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

describe("実戦で拠点の確保が成立する(`[v6.7]` F-9)", () => {
  /**
   * **拠点の判定円に誰も入らない**という状態を踏まないための回帰テスト。
   *
   * 仕様 §12 のメイン条件は拠点確保だが、`[v6.6]` 時点では中隊戦を300秒回しても
   * 3拠点すべてが「半径内に誰かがいた時間 0%」「確保 0%」だった。原因は2つとも
   * 「拠点に立つ」を妨げる幾何の問題で、AIの判断の質ではなかった:
   *
   *   1. 機動組の躍進の停止条件が `engageMax`(ライフル有効射程60m)だった。
   *      目標の60m手前で躍進をやめるので、判定半径3mには永久に届かない
   *   2. 拠点を守る分隊の持ち場の下限が8mで、**判定半径3mより外**だった。
   *      守備に付いても誰も円を踏まない
   *
   * ここが 0 に戻ったら、勝利条件そのものが成立しなくなっている。
   * **確保の完了までは保証しない** — 遭遇戦の最中に60秒の占有を続けられるかは
   * 拠点配置と戦力のバランスの問題で、`docs/design/01-validation-backlog.md` の
   * K-1 に計測付きで残してある。
   */
  it("拠点の判定円に兵士が入り、確保が積み上がる", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    beginBattle(w);
    let insideSeconds = 0;
    for (let t = 0; t < 300; t++) {
      runTicks(w, SIM_HZ);
      const anyInside = w.objectives.some((o) =>
        w.soldiers.some(
          (s) =>
            s.status === "ok" &&
            Math.hypot(s.pos.x - o.pos.x, s.pos.z - o.pos.z) <= o.radius,
        ),
      );
      if (anyInside) insideSeconds++;
    }
    // 計測値は 28秒 / 進捗30%(seed 1)。0 に戻っていないことだけを見る
    expect(insideSeconds).toBeGreaterThan(5);
    expect(Math.max(...w.objectives.map((o) => o.progress))).toBeGreaterThan(0.1);
  }, 420000);
});
