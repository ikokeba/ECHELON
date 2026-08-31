/**
 * 担当区域内の建物掃討(clear in zone、米軍 ATP 3-06.11)。`[v6.3]`
 *
 * 3回目のテストプレイ指摘「中隊長または小隊長の指揮のもと建物をクリアリングしながら
 * 前線を進めるべき。建物をクリアリングせずどんどん進んでいます」への実装。
 *
 * ドクトリン: 市街地の攻勢では、小隊長が担当区域内の建物を各分隊へ割り当て、掃討を
 * 終えてから前進線を進める。未掃討の建物を側背に残さないのが原則(明示的に bypass する
 * 場合は警戒を残す)。従来の実装は「分隊の任務目標か既知の脅威が建物の中にあり、かつ
 * 22m以内」でしか突入が発動せず、**前進軸上の建物を割り当てる仕組みが無かった**ため、
 * 建物を素通りしていた。
 *
 * 陣営を見る分岐は無い(仕様 §2/§13)。
 */

import { deepestRoomCenter } from "../cqb.ts";
import type { Building, Side, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/**
 * この建物は当該陣営にとって掃討済みか。
 *
 * 「全ての扉がいずれかの自軍分隊の掃討済みリストに入っている」ことを掃討完了とする。
 * 状態を別に持たず毎回導出するのは、掃討済みフラグと `clearedDoorIds` が食い違う余地を
 * 作らないため(中断・全滅で分隊が消えても、記録は残った分隊のぶんだけが正しく効く)。
 */
export function buildingCleared(world: World, side: Side, b: Building): boolean {
  return buildingClearedIn(clearedDoorSet(world, side), b);
}

/**
 * 当該陣営が掃討済みの扉id。`[v6.3]` 建物ごとに分隊を舐め直すと
 * 建物×分隊×扉 の三重走査になり、78棟・24個分隊では判断周期ごとに20万回を超える。
 * 呼び出し側で一度作って使い回す。
 */
export function clearedDoorSet(world: World, side: Side): Set<number> {
  const out = new Set<number>();
  for (const sq of world.squads) {
    if (sq.side !== side) continue;
    for (const id of sq.clearedDoorIds) out.add(id);
  }
  return out;
}

/** `clearedDoorSet` を渡す版。 */
export function buildingClearedIn(cleared: ReadonlySet<number>, b: Building): boolean {
  if (b.doors.length === 0) return true;
  for (const d of b.doors) if (!cleared.has(d.id)) return false;
  return true;
}

/**
 * **取り付いたが終わっていない**建物か(扉を1つ以上掃討済み、かつ未完)。`[v6.4]`
 *
 * ATP 3-06.11 では、建物は全室を掃討して初めて cleared になる。途中で離れるのは
 * 「bypass」であって、bypass は指揮官の明示的な判断と、監視を残すこと・報告することを
 * 伴う。破孔だけ開けて未確認の部屋を側背に残して進むのは、どちらでもない最悪の形。
 */
export function buildingStarted(cleared: ReadonlySet<number>, b: Building): boolean {
  if (b.doors.length === 0) return false;
  let done = 0;
  for (const d of b.doors) if (cleared.has(d.id)) done++;
  return done > 0 && done < b.doors.length;
}

/**
 * この分隊が自分で取り付いて、まだ終わっていない建物。`[v6.4]`
 *
 * 状態は持たず `sq.clearedDoorIds` から毎回導出する(このモジュールの他の判定と同じ)。
 * 「自分が破った建物は自分で終わらせる」ためのもので、接敵で前進軸がずれた瞬間に
 * 掃討途中の建物が担当区域の外へ落ちて二度と戻らない、という取りこぼしを塞ぐ。
 */
export function unfinishedBuildingOf(
  world: World,
  cleared: ReadonlySet<number>,
  ownDoorIds: readonly number[],
): Building | null {
  if (ownDoorIds.length === 0) return null;
  const own = new Set(ownDoorIds);
  for (const b of world.buildings) {
    if (!buildingStarted(cleared, b)) continue;
    if (b.doors.some((d) => own.has(d.id))) return b;
  }
  return null;
}

/**
 * 担当区域内で、まだ掃討していない建物のうち**前進軸に沿って最も手前**のもの。
 *
 * 「手前」= 分隊の現在地から見て、目標へ向かう軸上で前方にあり、かつ近い建物。
 * 後方や真横の建物まで拾うと、前進が止まって掃討行脚になってしまう。
 *
 * @param from   分隊の重心
 * @param aim    分隊の任務目標(前進軸の先)
 * @param radius 軸から左右にこれだけ離れた建物までを担当区域とみなす m
 * @param taken  同じ小隊の他分隊が既に割り当てられた建物id(重複して群がらせない)
 */
export function nextBuildingToClear(
  world: World,
  _side: Side,
  from: Vec2,
  aim: Vec2,
  radius: number,
  taken: ReadonlySet<number>,
  /** `clearedDoorSet` の結果。小隊の判断1回につき1度だけ作って使い回す */
  cleared: ReadonlySet<number>,
): Building | null {
  const dx = aim.x - from.x;
  const dz = aim.z - from.z;
  const axisLen = Math.hypot(dx, dz);
  if (axisLen < 1e-6) return null;
  const fx = dx / axisLen;
  const fz = dz / axisLen;

  let best: Building | null = null;
  let bestAlong = Infinity;
  /** 取り付き済みの建物を優先する(0 = 途中、1 = 手つかず)。`[v6.4]` */
  let bestRank = 2;
  for (const b of world.buildings) {
    if (taken.has(b.id)) continue;
    const cx = (b.bounds.minX + b.bounds.maxX) / 2;
    const cz = (b.bounds.minZ + b.bounds.maxZ) / 2;
    const ax = cx - from.x;
    const az = cz - from.z;
    // 前進軸に沿った距離と、軸からの横ずれに分解する
    const along = ax * fx + az * fz;
    if (along < 0 || along > axisLen) continue; // 後方・目標の先は担当外
    const lateral = Math.abs(ax * -fz + az * fx);
    if (lateral > radius) continue;
    if (buildingClearedIn(cleared, b)) continue;
    // `[v6.4]` 誰かが破孔を開けて未完のまま残した建物を最優先で拾う。手つかずの
    // 建物より危険度が高い(中に敵が残っていることが分かっていて、扉も開いている)。
    const rank = buildingStarted(cleared, b) ? 0 : 1;
    // 最も手前のものから順に潰す(飛ばして奥へ行かない)
    if (rank < bestRank || (rank === bestRank && along < bestAlong)) {
      bestRank = rank;
      bestAlong = along;
      best = b;
    }
  }
  return best;
}

/** 掃討対象の建物に対する分隊の任務目標。最奥の部屋を取れば建物を掃討したことになる。 */
export function clearingObjective(b: Building): Vec2 {
  return deepestRoomCenter(b);
}
