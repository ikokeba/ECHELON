/**
 * stepWorld: シミュレーションをちょうど1固定ティック進める。
 *
 * 各システムは毎ティック**固定された順序**で実行される。この順序こそが仕様であり、
 * 変更すれば結果が変わる。スライスが進むにつれてここへシステムが追加されていく。
 */

import { pathingSystem } from "./systems/pathing.ts";
import { movementSystem } from "./systems/movement.ts";
import { separationSystem } from "./systems/separation.ts";
import { perceptionSystem } from "./systems/perception.ts";
import { combatSystem } from "./systems/combat.ts";
import { casualtiesSystem } from "./systems/casualties.ts";
import { litterSystem } from "./systems/litter.ts";
import { objectivesSystem } from "./systems/objectives.ts";
import { fireteamAI } from "./c2/fireteam.ts";
import { squadAI } from "./c2/squad.ts";
import { platoonAI } from "./c2/platoon.ts";
import { companyAI } from "./c2/company.ts";
import { successionSystem } from "./c2/succession.ts";
import { radioSystem } from "./radio.ts";
import type { World } from "./world.ts";

export function stepWorld(world: World): void {
  // 0. 前ティックの描画用エフェクトを捨てる(`[v6.1]`)。ここに溜まるのはこのティックに
  //    起きた発砲・擲弾着弾だけで、シムの判断には一切使わない。
  world.fx.length = 0;
  // 1. 索敵 — 各兵士がいま自分の目で何を見ているか(仕様 §5)
  perceptionSystem(world);
  // 2. 無線 — 報告の到達、各階層 belief の更新と確度減衰、定時報告の送信(仕様 §5)。
  //    C2より先に走らせることで、各階層は「このティック時点で自分が知り得る情報」で判断する。
  radioSystem(world);
  // 3. 指揮継承 — 無力化された指揮官を次席者へ即時引き継ぐ(仕様 §12)。
  //    C2より先に走らせることで、このティックの判断は継承後の指揮官が行う。
  successionSystem(world);
  // 4. C2 — 上から下へ。中隊長が任務(担当区域)を小隊へ、小隊長が任務目標と移動技術を
  //    分隊へ、分隊長がそれをFTへ翻訳し、FTリーダーが兵士単位の命令まで落とす
  //    (仕様 §2 の5階層)。
  companyAI(world);
  platoonAI(world);
  squadAI(world);
  fireteamAI(world);
  // 5. 経路要求 — 移動系の命令をウェイポイント列へ変換する
  pathingSystem(world);
  // 6. 移動 — 経路と命令の向きを消費する
  movementSystem(world);
  // 7. 分離 — 兵士同士の重なりをほぐす(移動の直後、戦闘の判定前)
  separationSystem(world);
  // 8. 戦闘 — 交戦・命中判定・制圧の適用
  combatSystem(world);
  // 9. 死傷 — 出血タイマーの進行、応急手当(仕様 §9 前半)
  casualtiesSystem(world);
  // 10. 後送 — 担架班の編成と搬送(仕様 §9 後半)。分離のあとに走らせて、
  //     担架班を剛体として最終位置へ貼り直す
  litterSystem(world);
  // 11. 拠点と勝敗 — 確保進捗の更新と決着の判定(仕様 §12)
  objectivesSystem(world);

  world.tick += 1;
}

/** ヘッドレス実行およびテスト用のユーティリティ。 */
export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world);
}
