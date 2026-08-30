/**
 * 確保済み拠点の保持(仕様 §12 / `[v6.1]`)。
 *
 * 従来のC2は接敵すると任務目標を脅威位置へ丸ごと差し替えていた
 * (`const aim = threat ? threat.pos : objective`)。このため一度確保した拠点でも、
 * 別方面で接敵した瞬間に守備隊ごと脅威へ前進し、拠点を放棄していた(初回テストプレイ指摘)。
 *
 * ここで保証するのは最小限:「担当区域の近くに自軍所有(または中立で自軍が確保進行中)の
 * 拠点があるなら、その区域を担う下位ユニットの持ち場を拠点の内側へ引き戻す」。
 * mission型(seize / screen / support-by-fire)の一般化は OQ-3 のまま先送り。
 *
 * side分岐は無い — 両陣営が同じ規則で自分の所有拠点を守る(仕様 §2/§13)。
 */

import type { Objective, Side, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/** この地点から近いところにある「守るべき自軍拠点」。無ければ null。 */
export function heldObjectiveNear(
  world: World,
  side: Side,
  at: Vec2,
  /** 拠点の外周からこの距離以内にいるユニットだけが守備に付く m */
  maxDist = 30,
): Objective | null {
  let best: Objective | null = null;
  let bestD = Infinity;
  for (const o of world.objectives) {
    // 相手所有の拠点は「守る」対象ではなく「奪う」対象なので除外する。
    if (o.owner !== null && o.owner !== side) continue;
    // 自軍所有、または中立で自軍が確保を進めている拠点だけを守備対象にする。
    const mine = o.owner === side || (o.owner === null && o.progressBy === side);
    if (!mine) continue;
    const d = Math.hypot(at.x - o.pos.x, at.z - o.pos.z);
    if (d > o.radius + maxDist) continue; // 遠くを行軍中の部隊まで足止めしない
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * 拠点ごとに「守備に付ける下位ユニットは**最寄りの1つだけ**」へ絞る。`[v6.2]`
 *
 * `heldObjectiveNear` は「近い守るべき拠点」を返すだけなので、複数のユニットの重心が
 * 同じ拠点の近くにあると**全員が同じ拠点へクランプされる**。拠点が広くて離れていた
 * うちは1つずつしか掛からず問題にならなかったが、拠点が建物内の1室になった途端、
 * 3個小隊すべてが中央拠点の1点へ吸い寄せられて戦線が消えた。
 *
 * 設計意図(design AD-26)はもともと「最寄りの1ユニットが拠点に残り、残りは通常どおり
 * 脅威へ機動する」だったので、その意図どおりに絞る。
 *
 * @param entries 下位ユニットの識別子と重心
 * @returns 守備に付くユニットの識別子 → 守る拠点
 */
export function assignHolders<K>(
  world: World,
  side: Side,
  entries: ReadonlyArray<{ key: K; centroid: Vec2 }>,
): Map<K, Objective> {
  /** 拠点id → いま最寄りの候補 */
  const bestFor = new Map<number, { key: K; d: number; obj: Objective }>();
  for (const e of entries) {
    const o = heldObjectiveNear(world, side, e.centroid);
    if (!o) continue;
    const d = Math.hypot(e.centroid.x - o.pos.x, e.centroid.z - o.pos.z);
    const cur = bestFor.get(o.id);
    // 同距離は先に出た方を採る(entries の順は決定的なので結果も決定的)
    if (!cur || d < cur.d) bestFor.set(o.id, { key: e.key, d, obj: o });
  }
  const out = new Map<K, Objective>();
  for (const { key, obj } of bestFor.values()) out.set(key, obj);
  return out;
}

/**
 * `aim`(脅威方向へ寄った持ち場)を拠点中心から `radius * frac` 以内へ引き戻す。
 * 脅威を睨む向きは保ったまま、持ち場そのものは拠点の外へ出さない。
 *
 * `minLimit` は引き戻す先の下限 m。`[v6.2]` 拠点が建物内の1室(半径3m)まで小さくなり、
 * `radius * frac` だけだと**小隊36名を半径2mの点に集める**指示になってしまった。
 * 守備隊は拠点の上に立つのではなく拠点を囲んで守るので、隊の広がりぶんの床が要る。
 */
export function clampToObjective(aim: Vec2, o: Objective, frac = 0.5, minLimit = 0): Vec2 {
  const dx = aim.x - o.pos.x;
  const dz = aim.z - o.pos.z;
  const d = Math.hypot(dx, dz);
  const limit = Math.max(o.radius * frac, minLimit);
  if (d <= limit || d < 1e-6) return { x: o.pos.x + dx, z: o.pos.z + dz };
  return { x: o.pos.x + (dx / d) * limit, z: o.pos.z + (dz / d) * limit };
}
