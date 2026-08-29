/**
 * 兵士同士の分離。
 *
 * 兵士は壁とは衝突するが、これまで互いには衝突しなかったため、同じ隊形位置を
 * 割り当てられた隊員が完全に重なって表示される問題があった(描画で確認)。
 * 重なりは見た目の問題にとどまらず、射線判定・遮蔽・被弾のいずれもが
 * 「実際には1人分の空間に4人いる」前提で走ってしまう。
 *
 * 剛体衝突は導入しない。分隊の隊形は隊形ロジックが決めるべきもので、そこへ
 * 物理的な押し合いを持ち込むと隊形が崩れる。ここでは重なりを解消する程度の
 * ごく弱い押し出しに留める(いわゆるソフト分離)。
 *
 * 対称性(仕様 §2/§13): 押し出しは常に**両者へ等量**を適用し、走査順に依存しない。
 * 片側だけを動かすと、走査順が先の陣営が有利になる。
 */

import { collidesWall } from "../geometry.ts";
import { SOLDIER_RADIUS } from "../constants.ts";
import { clearHash, createSpatialHash, forEachNear, insert } from "../spatial.ts";
import type { Soldier } from "../types.ts";
import type { World } from "../world.ts";

/** この距離まで近づいたら押し合う m。兵士の直径よりわずかに広く取る。 */
const MIN_SEPARATION = SOLDIER_RADIUS * 2;
/**
 * 1ティックあたりに解消する重なりの割合。1.0にすると瞬時に弾き飛んで震えるので、
 * 数ティックかけてほぐす。
 */
const RELAX = 0.25;

const hash = createSpatialHash<Soldier>(MIN_SEPARATION * 2);

/**
 * 分離の対象外にする兵士。
 *
 * 担架班(負傷者本人と担架要員)は litterSystem が**剛体として**位置を決めている。
 * そこへソフト分離を掛けると、担架要員が自分の担いでいる負傷者を押し戻してしまう。
 * 搬送速度(0.5倍 = 0.043m/tick)より押し出し量のほうが大きいため、実際に
 * 扉の開口部で担架班が永久に動けなくなる不具合を起こした。
 */
function isRigidLitter(s: Soldier): boolean {
  return s.bearing !== null || s.bearers.length > 0;
}

export function separationSystem(world: World): void {
  clearHash(hash);
  for (const s of world.soldiers) {
    if (s.status === "kia") continue; // 遺体は押し出しの対象外
    if (isRigidLitter(s)) continue;
    insert(hash, s.pos, s);
  }

  // 押し出し量を一旦集計してから適用する。逐次に位置を書き換えると、走査順が
  // 結果に影響して対称性が崩れるため。
  const pushX = new Map<number, number>();
  const pushZ = new Map<number, number>();

  for (const a of world.soldiers) {
    if (a.status === "kia" || isRigidLitter(a)) continue;
    forEachNear(hash, a.pos, MIN_SEPARATION, (b) => {
      if (b.id <= a.id) return; // 各ペアを1回だけ処理する
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d >= MIN_SEPARATION) return;

      let ux: number;
      let uz: number;
      if (d < 1e-6) {
        // 完全に重なっている場合は、IDから決まる固定方向へ散らす
        // (乱数を使うとリプレイの決定性が崩れる)
        const ang = ((a.id * 2654435761) % 360) * (Math.PI / 180);
        ux = Math.cos(ang);
        uz = Math.sin(ang);
      } else {
        ux = dx / d;
        uz = dz / d;
      }

      const overlap = (MIN_SEPARATION - d) * 0.5 * RELAX;
      pushX.set(a.id, (pushX.get(a.id) ?? 0) - ux * overlap);
      pushZ.set(a.id, (pushZ.get(a.id) ?? 0) - uz * overlap);
      pushX.set(b.id, (pushX.get(b.id) ?? 0) + ux * overlap);
      pushZ.set(b.id, (pushZ.get(b.id) ?? 0) + uz * overlap);
    });
  }

  for (const s of world.soldiers) {
    const dx = pushX.get(s.id);
    const dz = pushZ.get(s.id);
    if (dx === undefined && dz === undefined) continue;
    const nx = s.pos.x + (dx ?? 0);
    const nz = s.pos.z + (dz ?? 0);
    // 押し出しで壁へめり込ませない
    if (!collidesWall(world.walls, nx, nz, SOLDIER_RADIUS)) {
      s.pos = { x: nx, z: nz };
    }
  }
}
