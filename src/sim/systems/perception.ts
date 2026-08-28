/**
 * 索敵システム: 生存している各兵士の `sees` に、このティックに本人が直接視認できる
 * 敵兵士のIDを詰める。条件は前方視界扇形の内側(仕様 §5: 角度+距離)・DETECT_RANGE
 * 以内・遮蔽物で遮られていないこと。KIA の遺体は索敵対象にならない
 * (仕様 §9: 記憶からも即座に消去される)。
 *
 * FT/分隊単位の視界の合算(仕様 §5)は、この兵士単位の集合から C2 層が必要に応じて
 * 導出する。ここには保持しない。
 */

import { hasLineOfSight } from "../geometry.ts";
import { DETECT_RANGE, FOV_HALF_RAD } from "../constants.ts";
import type { World } from "../world.ts";
import type { Soldier } from "../types.ts";

const COS_FOV = Math.cos(FOV_HALF_RAD);
const DETECT_RANGE_SQ = DETECT_RANGE * DETECT_RANGE;

export function canSee(walls: World["walls"], viewer: Soldier, target: Soldier): boolean {
  const dx = target.pos.x - viewer.pos.x;
  const dz = target.pos.z - viewer.pos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > DETECT_RANGE_SQ || d2 < 1e-6) return false;
  const inv = 1 / Math.sqrt(d2);
  // 視線方向と目標方向の内積を cos(半角) と比較する
  if (viewer.facing.x * dx * inv + viewer.facing.z * dz * inv < COS_FOV) return false;
  return hasLineOfSight(walls, viewer.pos.x, viewer.pos.z, target.pos.x, target.pos.z);
}

export function perceptionSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "kia") {
      if (s.sees.length) s.sees = [];
      continue;
    }
    const seen: number[] = [];
    for (const other of world.soldiers) {
      if (other.side === s.side || other.status === "kia") continue;
      if (canSee(world.walls, s, other)) seen.push(other.id);
    }
    s.sees = seen;
  }
}
