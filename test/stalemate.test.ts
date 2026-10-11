import { describe, it, expect } from "vitest";
import { createWorld, setBlockers } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { perceptionSystem } from "../src/sim/systems/perception.ts";
import { OBJECTIVE, SIM_HZ } from "../src/sim/constants.ts";
import type { Scenario } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 決着まで進む(`[v7.6]` プレイでの指摘「無限でも決着するまでシミュレートするように」)。
 *
 *   1. 倒れて動けない敵は索敵に載らない(撃てない相手を「接敵中」と見続けて動かなくなっていた)
 *   2. 拠点も戦力も長く動かなければ裁定する。時間無制限の攻防戦は攻勢の限界で防御側の勝ち、
 *      遭遇戦は拠点の多い側(同じなら戦える兵の多い側)の勝ち。制限時間のある攻防戦は対象外
 */

/** 両軍を盤の両端へ離して、撃ち合いも確保も起きない状態にする */
function apart(sc: Scenario): World {
  const w = createWorld(sc);
  for (const s of w.soldiers) {
    s.pos = s.side === "blue" ? { x: -100, z: -90 } : { x: 100, z: 90 };
    s.eye = { ...s.pos };
  }
  return w;
}

/** AI が動かないよう、毎回位置を戻しながら回す(命令の更新で歩き出さないように) */
function idle(w: World, sec: number): void {
  const at = new Map(w.soldiers.map((s) => [s.id, { ...s.pos }]));
  for (let t = 0; t < sec * SIM_HZ && !w.victory; t++) {
    runTicks(w, 1);
    for (const s of w.soldiers) {
      const p = at.get(s.id)!;
      s.pos = { ...p };
      s.eye = { ...p };
    }
  }
}

describe("決着まで進む(`[v7.6]`)", () => {
  it("倒れて動けない敵は索敵に載らない", () => {
    const w = createWorld(platoonClashScenario(1));
    setBlockers(w, []); // 壁を外して視線だけを見る
    const a = w.soldiers.find((s) => s.side === "blue")!;
    const b = w.soldiers.find((s) => s.side === "red")!;
    a.pos = { x: 0, z: 0 };
    a.eye = { ...a.pos };
    a.facing = { x: 1, z: 0 };
    b.pos = { x: 10, z: 0 };
    b.eye = { ...b.pos };
    perceptionSystem(w);
    expect(a.sees).toContain(b.id);
    b.status = "wia";
    b.stabilized = true;
    perceptionSystem(w);
    expect(a.sees).not.toContain(b.id);
  });

  it("時間無制限の攻防戦: 何も動かないまま攻撃側が過半数に届かなければ、攻勢の限界で防御側の勝ち", () => {
    const sc = platoonClashScenario(1);
    sc.mode = "assault";
    sc.attacker = "blue";
    sc.timeLimitSec = 0;
    const w = apart(sc);
    idle(w, OBJECTIVE.STALEMATE_SEC - 5);
    expect(w.victory).toBeNull();
    idle(w, 10);
    expect(w.victory).toMatchObject({ winner: "red", reason: "culmination" });
  }, 300000);

  it("制限時間のある攻防戦は裁定しない(時間切れが決める)", () => {
    const sc = platoonClashScenario(1);
    sc.mode = "assault";
    sc.attacker = "blue";
    sc.timeLimitSec = 3600;
    const w = apart(sc);
    idle(w, OBJECTIVE.STALEMATE_SEC + 10);
    expect(w.victory).toBeNull();
  }, 300000);

  it("遭遇戦: 何も動かなければ拠点の多い側、同じなら戦える兵の多い側の勝ち", () => {
    const w = apart(platoonClashScenario(1));
    w.objectives[0]!.owner = "red";
    w.objectives[0]!.progress = 1;
    w.objectives[0]!.progressBy = "red";
    idle(w, OBJECTIVE.STALEMATE_SEC + 5);
    expect(w.victory).toMatchObject({ winner: "red", reason: "adjudication" });

    const w2 = apart(platoonClashScenario(1));
    w2.soldiers.find((s) => s.side === "red")!.status = "kia";
    idle(w2, OBJECTIVE.STALEMATE_SEC + 5);
    expect(w2.victory).toMatchObject({ winner: "blue", reason: "adjudication" });
  }, 300000);
});
