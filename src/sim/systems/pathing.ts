/**
 * 経路要求システム: 目的地を持つ移動系命令を、屋外ナビグリッド経由で具体的な
 * ウェイポイント列へ変換する。毎ティック、移動システムの前に実行される。
 *
 * 新しい命令は `path: []` の状態で届く(発行側がクリアする)ため、新しい目的地は
 * 自動的に拾われる。到達不能な目標に対して毎ティック再探索しないよう、探索の試行は
 * 共通のリズムで間引く(design §4.2: 経路要求は予算制でティック毎ではない)。
 *
 * このリズムを**意図的に兵士IDに紐づけていない**点が重要 — 戦力対称性(仕様 §2/§13)
 * のため、両陣営の対応するユニットは同じタイミングで計算しなければならない。
 * 規模が大きくなったらスロット単位の予算制に置き換える。
 */

import { findPathSet } from "../navgrid.ts";
import { SIM_HZ } from "../constants.ts";
import type { World } from "../world.ts";

/** 経路が得られなかった場合の再試行間隔の上限 */
const PATH_RECHECK_TICKS = Math.round(SIM_HZ * 0.5);
/** 目的地に十分近く、経路探索が不要とみなす距離 */
const ARRIVE_EPS = 0.4;
/** 追従(隊形位置)に迂回路を与えるまでの、詰まり連続ティック数(1秒)。`[v6.4]` */
const FOLLOW_DETOUR_TICKS = SIM_HZ;

export function pathingSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "kia" || s.status === "wia") continue;
    // 移動の要否は命令の種類ではなく目的地の有無で決まる(movement.ts と同じ規則)。
    // `suppress` も「この射撃位置へ移動して制圧しろ」という意味を持ちうる。
    // 集合・追従(仕様 §6.5)は経路探索を通さない。目標が毎ティック動くため、
    // 経路を張っても即座に陳腐化する。移動システムが直接近づける。
    // `[v6.4]` ただし追従者が壁を押し続けている場合だけは例外で、迂回路を1本渡す。
    // 隊形位置が内壁の向こう側に来ると直進では永久に届かないため(移動システム側を参照)。
    if (s.order.kind === "follow" && s.stuckTicks < FOLLOW_DETOUR_TICKS) continue;
    const goal = s.order.target;
    if (!goal) continue;
    if (s.pathIdx < s.path.length) continue; // すでに経路を追従中

    const d = Math.hypot(goal.x - s.pos.x, goal.z - s.pos.z);
    if (d <= ARRIVE_EPS) continue;

    // `[v6.3]` 要求を全員同時に走らせない。従来は `tick % 15` で**全員が同じティックに
    // 集中**しており、平均が足りていても 0.5秒ごとに大きな山ができる(盤面2倍で
    // 1回の山が100ms超)。位相を `ordinal`(鏡像で一致する編成上の通し番号)でずらす。
    // 兵士IDでずらすと両陣営で位相が食い違い、戦力対称性(仕様 §2/§13)が壊れる。
    if ((world.tick + s.ordinal) % PATH_RECHECK_TICKS !== 0) continue;


    const path = findPathSet(world.nav, s.pos.x, s.pos.z, goal.x, goal.z);
    if (path && path.length > 0) {
      s.path = path;
      s.pathIdx = 0;
    }
  }
}
