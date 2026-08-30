/**
 * 兵士の武器射程(仕様 §10 の4段階)。`[v6.3]`
 *
 * `[v6.1]` は実装コストを理由に全員を 20m へ切り詰め、選抜射手だけ 300m にしていた。
 * その但し書き「選抜射手の差が実際に出るマップが揃うまで見送る」の条件が満たされたので、
 * 本来の値へ戻す。ここが索敵距離・交戦距離・命中率の距離減衰すべての基準になる。
 *
 * MOSごとの分岐はここ1箇所に閉じる。仕様 §14 の「MOSはステータス修正であって
 * 命令の種類は変えない」という方針どおり、呼び出し側に武器種の分岐を持ち込まない。
 */

import { WEAPON_RANGE } from "./constants.ts";
import type { Soldier } from "./types.ts";

export type WeaponKind = keyof typeof WEAPON_RANGE;

/** この兵士が持つ武器の種別。現在の編成はライフルと選抜射手だけを使う。 */
export function weaponKindOf(s: Soldier): WeaponKind {
  return s.quals.designatedMarksman ? "dm" : "rifle";
}

/** この兵士の `detect`(索敵・射撃の上限)と `effective`(火力が決定的になる帯)。 */
export function weaponRangeOf(s: Soldier): (typeof WEAPON_RANGE)[WeaponKind] {
  return WEAPON_RANGE[weaponKindOf(s)];
}
