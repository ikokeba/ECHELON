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
import { platoonAI } from "./c2/platoon.ts";
import { radioSystem } from "./radio.ts";
import type { World } from "./world.ts";

export function stepWorld(world: World): void {
  // 1. 索敵 — 各兵士がいま自分の目で何を見ているか(仕様 §5)
  perceptionSystem(world);
  // 2. 無線 — 報告の到達、各階層 belief の更新と確度減衰、定時報告の送信(仕様 §5)。
  //    C2より先に走らせることで、各階層は「このティック時点で自分が知り得る情報」で判断する。
  radioSystem(world);
  // 3. C2 — 上から下へ。小隊長が任務目標と移動技術を分隊へ、分隊長がそれをFTへ翻訳し、
  //    FTリーダーが兵士単位の命令まで落とす(仕様 §2 の5階層。中隊層は次スライス)。
  platoonAI(world);
  squadAI(world);
  fireteamAI(world);
  // 4. 経路要求 — 移動系の命令をウェイポイント列へ変換する
  pathingSystem(world);
  // 5. 移動 — 経路と命令の向きを消費する
  movementSystem(world);
  // 6. 戦闘 — 交戦・命中判定・制圧の適用
  combatSystem(world);
  // 7. 死傷 — 出血タイマーの進行
  casualtiesSystem(world);

  world.tick += 1;
}

/** ヘッドレス実行およびテスト用のユーティリティ。 */
export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world);
}
