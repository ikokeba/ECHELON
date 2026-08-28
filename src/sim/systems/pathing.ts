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

import { findPath } from "../navgrid.ts";
import { SIM_HZ } from "../constants.ts";
import type { World } from "../world.ts";

const MOVING_ORDERS = new Set(["move", "maneuver", "retreat", "evade"]);
/** 経路が得られなかった場合の再試行間隔の上限 */
const PATH_RECHECK_TICKS = Math.round(SIM_HZ * 0.5);
/** 目的地に十分近く、経路探索が不要とみなす距離 */
const ARRIVE_EPS = 0.4;

export function pathingSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "kia" || s.status === "wia") continue;
    if (!MOVING_ORDERS.has(s.order.kind)) continue;
    const goal = s.order.target;
    if (!goal) continue;
    if (s.pathIdx < s.path.length) continue; // すでに経路を追従中

    const d = Math.hypot(goal.x - s.pos.x, goal.z - s.pos.z);
    if (d <= ARRIVE_EPS) continue;

    if (world.tick % PATH_RECHECK_TICKS !== 0) continue;

    const path = findPath(world.navOutdoor, s.pos.x, s.pos.z, goal.x, goal.z);
    if (path && path.length > 0) {
      s.path = path;
      s.pathIdx = 0;
    }
  }
}
