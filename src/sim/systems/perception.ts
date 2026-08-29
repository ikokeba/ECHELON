/**
 * 索敵システム: 生存している各兵士の `sees` に、このティックに本人が直接視認できる
 * 敵兵士のIDを詰める。条件は前方視界扇形の内側(仕様 §5: 角度+距離)・DETECT_RANGE
 * 以内・遮蔽物で遮られていないこと。KIA の遺体は索敵対象にならない
 * (仕様 §9: 記憶からも即座に消去される)。
 *
 * FT/分隊単位の視界の合算(仕様 §5)は、この兵士単位の集合から C2 層が必要に応じて
 * 導出する。ここには保持しない。
 *
 * 候補の絞り込みには空間ハッシュを使う。総当たりだと中隊規模(両軍約260名)で
 * 毎秒200万回の判定になり破綻するため。
 */

import { hasLineOfSight } from "../geometry.ts";
import { DETECT_RANGE, FOV_HALF_RAD } from "../constants.ts";
import { clearHash, createSpatialHash, forEachNear, insert } from "../spatial.ts";
import { isOffField } from "./litter.ts";
import type { World } from "../world.ts";
import type { Soldier } from "../types.ts";

const COS_FOV = Math.cos(FOV_HALF_RAD);
const DETECT_RANGE_SQ = DETECT_RANGE * DETECT_RANGE;

/** セルサイズは索敵距離の半分。1回の問い合わせで走査するセル数を小さく保つ。 */
const hash = createSpatialHash<Soldier>(DETECT_RANGE / 2);

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
  clearHash(hash);
  for (const s of world.soldiers) {
    if (s.status === "kia") continue; // 遺体は視認対象にならない(仕様 §9)
    if (isOffField(s)) continue; // 後送済みは戦場を離脱している(仕様 §9)
    insert(hash, s.pos, s);
  }

  for (const s of world.soldiers) {
    if (s.status === "kia" || isOffField(s)) {
      if (s.sees.length) s.sees = [];
      continue;
    }
    const seen: number[] = [];
    forEachNear(hash, s.pos, DETECT_RANGE, (other) => {
      if (other.side === s.side) return;
      if (canSee(world.walls, s, other)) seen.push(other.id);
    });
    // 走査順が空間ハッシュのセル順に依存するので、IDで整列して決定性を保つ。
    // ここを揺らすと同一シードのリプレイが再現しなくなる。
    seen.sort((a, b) => a - b);
    s.sees = seen;
  }
}
