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
import { DETECT_RANGE, DM_DETECT_RANGE, FOV_HALF_RAD, PEEK } from "../constants.ts";
import { clearHash, createSpatialHash, forEachNear, insert } from "../spatial.ts";
import {
  castRayIndexed,
  collidesWallIndexed,
  hasLineOfSightIndexed,
  type WallIndex,
} from "../wallIndex.ts";
import { isOffField } from "./litter.ts";
import type { World } from "../world.ts";
import type { Soldier, Vec2 } from "../types.ts";

/** セルサイズは索敵距離の半分。1回の問い合わせで走査するセル数を小さく保つ(性能係数のみ)。 */
const hash = createSpatialHash<Soldier>(DETECT_RANGE / 2);

/**
 * `range` / `fovHalfRad` は省略時に仕様定数へフォールバックする(既存テストの3引数呼び出しを
 * 壊さないため)。`perceptionSystem` は `world.tuning` の実行時値を渡す(`[v6.1]`)。
 */
export function canSee(
  walls: World["walls"],
  viewer: Soldier,
  target: Soldier,
  range: number = DETECT_RANGE,
  fovHalfRad: number = FOV_HALF_RAD,
): boolean {
  const dx = target.eye.x - viewer.eye.x;
  const dz = target.eye.z - viewer.eye.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > range * range || d2 < 1e-6) return false;
  const inv = 1 / Math.sqrt(d2);
  // 視線方向と目標方向の内積を cos(半角) と比較する
  if (viewer.facing.x * dx * inv + viewer.facing.z * dz * inv < Math.cos(fovHalfRad)) return false;
  return hasLineOfSight(walls, viewer.eye.x, viewer.eye.z, target.eye.x, target.eye.z);
}

/**
 * `canSee` の空間索引版。`[v6.2]` 索敵は毎ティック全兵士ぶん回る唯一の重い経路なので、
 * ここだけ壁の全数走査をやめる。**判定結果は `canSee` と厳密に同一**。
 */
function canSeeIndexed(
  idx: WallIndex,
  viewer: Soldier,
  target: Soldier,
  range: number,
  fovHalfRad: number,
): boolean {
  const dx = target.eye.x - viewer.eye.x;
  const dz = target.eye.z - viewer.eye.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > range * range || d2 < 1e-6) return false;
  const inv = 1 / Math.sqrt(d2);
  if (viewer.facing.x * dx * inv + viewer.facing.z * dz * inv < Math.cos(fovHalfRad)) return false;
  return hasLineOfSightIndexed(idx, viewer.eye.x, viewer.eye.z, target.eye.x, target.eye.z);
}

/**
 * ビハインドカメラ(コーナー視認、仕様 §7.5)。
 *
 * 壁角の近くで静止している隊員は、体を残したまま視線だけを横へ出して覗ける
 * (スライス・ザ・パイ)。仕様の原則をそのまま実装する:
 *
 *   - **プレイヤー/AI平等**: 操作の有無を一切見ない。同じ関数を全員が通る
 *   - **相互リスク**: ずらした原点は「見る側の目」であると同時に
 *     「見られる側の露出点」でもある(canSee が両端に eye を使う)。
 *     覗けば見えるが、同時に覗かれる
 *   - **アクション分離**: 覗くのは索敵であって交戦ではない。移動中は覗かない
 */
function updateEyes(world: World): void {
  const right = (v: Vec2): Vec2 => ({ x: -v.z, z: v.x });

  for (const s of world.soldiers) {
    // `s.pos` を参照で持たせないこと。移動システムは pos を新しいオブジェクトへ
    // 差し替えるので、参照を持つと eye が前ティックの位置を指したまま取り残される。
    s.eye = { x: s.pos.x, z: s.pos.z };
    s.peeking = false;
    if (s.status !== "ok") continue;
    // 移動中は覗かない(仕様 §7.5「覗く(索敵)」と「出て撃つ(交戦)」の分離)
    if (s.pathIdx < s.path.length) continue;

    // 正面が壁で塞がれているときだけ意味がある
    const ahead = castRayIndexed(
      world.wallIndex,
      s.pos.x,
      s.pos.z,
      s.facing.x,
      s.facing.z,
      DETECT_RANGE,
    );
    if (ahead > PEEK.WALL_DIST) continue;

    const r = right(s.facing);
    let bestGain = 0;
    let bestEye: Vec2 | null = null;
    for (const sign of [1, -1]) {
      const e = { x: s.pos.x + r.x * sign * PEEK.OFFSET, z: s.pos.z + r.z * sign * PEEK.OFFSET };
      // 体はその場にあるので、覗く先が壁の中では意味がない
      if (collidesWallIndexed(world.wallIndex, e.x, e.z, 0.2)) continue;
      const reach = castRayIndexed(
        world.wallIndex,
        e.x,
        e.z,
        s.facing.x,
        s.facing.z,
        DETECT_RANGE,
      );
      const gain = reach - ahead;
      if (gain > bestGain) {
        bestGain = gain;
        bestEye = e;
      }
    }
    // わずかな改善で毎ティック覗いたり戻ったりしないよう、意味のある差だけ採る
    if (bestEye && bestGain > 1.0) {
      s.eye = bestEye;
      s.peeking = true;
    }
  }
}

export function perceptionSystem(world: World): void {
  // 視線原点(覗き)を先に確定させる。索敵はこの原点だけを見る
  updateEyes(world);

  clearHash(hash);
  for (const s of world.soldiers) {
    if (s.status === "kia") continue; // 遺体は視認対象にならない(仕様 §9)
    if (isOffField(s)) continue; // 後送済みは戦場を離脱している(仕様 §9)
    insert(hash, s.pos, s);
  }

  // 索敵距離・視界角は実行時チューニング可(`[v6.1]`)。既定は仕様定数と一致。
  const detectRange = world.tuning.detectRange;
  const fovHalfRad = world.tuning.fovHalfRad;
  for (const s of world.soldiers) {
    if (s.status === "kia" || isOffField(s)) {
      if (s.sees.length) s.sees = [];
      continue;
    }
    // 選抜射手(SDMR)だけ索敵距離が伸びる(仕様 §10)。壁とLOSが自然に頭打ちにする。
    const range = s.quals.designatedMarksman ? DM_DETECT_RANGE : detectRange;
    const seen: number[] = [];
    forEachNear(hash, s.pos, range, (other) => {
      if (other.side === s.side) return;
      if (canSeeIndexed(world.wallIndex, s, other, range, fovHalfRad)) seen.push(other.id);
    });
    // 走査順が空間ハッシュのセル順に依存するので、IDで整列して決定性を保つ。
    // ここを揺らすと同一シードのリプレイが再現しなくなる。
    seen.sort((a, b) => a - b);
    s.sees = seen;
  }

  // `敵.sees` の逆引き = 「自分は敵の視界扇形の中にいるか」(仕様 §5 `[v6.1]`)。
  // FTの接敵反応の分岐(仕様 §6)に使う。`sees` は敵しか含まないので、
  // これで「いずれかの敵に視認されている」が過不足なく求まる。
  for (const s of world.soldiers) s.observedByEnemy = false;
  for (const viewer of world.soldiers) {
    for (const id of viewer.sees) {
      const seen = world.soldierById.get(id);
      if (seen) seen.observedByEnemy = true;
    }
  }
}
