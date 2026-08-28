/**
 * stepWorld: シミュレーションをちょうど1固定ティック進める。
 *
 * 各システムは毎ティック**固定された順序**で実行される。この順序こそが仕様であり、
 * 変更すれば結果が変わる。スライスが進むにつれてここへシステムが追加されていく。
 */

import { pathingSystem } from "./systems/pathing.ts";
import { movementSystem } from "./systems/movement.ts";
import { perceptionSystem } from "./systems/perception.ts";
import { combatSystem } from "./systems/combat.ts";
import { casualtiesSystem } from "./systems/casualties.ts";
import { fireteamAI } from "./c2/fireteam.ts";
import { squadAI } from "./c2/squad.ts";
import type { World } from "./world.ts";

export function stepWorld(world: World): void {
  // 1. 索敵 — 各兵士がいま自分の目で何を見ているか(仕様 §5)
  perceptionSystem(world);
  // 2. C2 — FTリーダーが world picture を更新して兵士単位の命令を発行し、
  //    続いて分隊長がその状況判断に基づいて自身の位置を決める。
  //    (小隊・中隊のコントローラはこの上に入る。階層間の無線伝達は次のスライス)
  fireteamAI(world);
  squadAI(world);
  // 3. 経路要求 — 移動系の命令をウェイポイント列へ変換する
  pathingSystem(world);
  // 4. 移動 — 経路と命令の向きを消費する
  movementSystem(world);
  // 5. 戦闘 — 交戦・命中判定・制圧の適用
  combatSystem(world);
  // 6. 死傷 — 出血タイマーの進行
  casualtiesSystem(world);

  world.tick += 1;
}

/** ヘッドレス実行およびテスト用のユーティリティ。 */
export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world);
}
