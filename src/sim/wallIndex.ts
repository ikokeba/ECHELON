/**
 * 壁の空間索引(ブロードフェーズ)。`[v6.2]`
 *
 * `geometry.ts` の `castRay` / `hasLineOfSight` は壁を**全数走査**する。分隊規模の
 * マップ(壁30枚)では問題にならなかったが、市街地マップで建物の内壁まで持つように
 * なり壁が460枚を超えたところで、索敵(毎ティック 兵士×近傍×壁)が支配的になった。
 *
 * ここでは壁を一様グリッドへ振り分け、線分が通過するセルの壁だけを見る。
 * **答えは全数走査と1ビットも変わらない** — `castRay` は全壁のうちの最小 t を返す
 * 順序非依存の計算で、線分と交わる壁は必ず線分が通過するセルに登録されているため。
 * 決定性(design AD-2)を壊さずに定数倍だけを落とす。
 */

import { rayAABB } from "./geometry.ts";
import type { AABB, Bounds } from "./types.ts";

/** セルの一辺 m。索敵距離(既定20m)の数分の1になるあたり。 */
const CELL = 8;
/**
 * 壁を登録する際に外形へ足す余裕 m。`collidesWall` 相当の点問い合わせを
 * 1セルの参照だけで正しく行うため、想定される最大の判定半径より大きく取る。
 */
const PAD = 1.0;

export interface WallIndex {
  /** 索引が張られている元の壁配列(順序も含めて保持) */
  all: readonly AABB[];
  cell: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** 長さ cols*rows。各要素は `all` へのインデックス配列 */
  buckets: Int32Array[];
  /** 同一の壁を複数セルで二度判定しないための世代スタンプ */
  stamp: Int32Array;
  gen: number;
}

export function buildWallIndex(walls: readonly AABB[], bounds: Bounds): WallIndex {
  const minX = bounds.minX - PAD;
  const minZ = bounds.minZ - PAD;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + PAD * 2) / CELL));
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ + PAD * 2) / CELL));

  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  walls.forEach((w, i) => {
    const gx0 = clampInt(Math.floor((w.cx - w.hw - PAD - minX) / CELL), 0, cols - 1);
    const gx1 = clampInt(Math.floor((w.cx + w.hw + PAD - minX) / CELL), 0, cols - 1);
    const gz0 = clampInt(Math.floor((w.cz - w.hd - PAD - minZ) / CELL), 0, rows - 1);
    const gz1 = clampInt(Math.floor((w.cz + w.hd + PAD - minZ) / CELL), 0, rows - 1);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) lists[gz * cols + gx]!.push(i);
    }
  });

  return {
    all: walls,
    cell: CELL,
    minX,
    minZ,
    cols,
    rows,
    buckets: lists.map((l) => Int32Array.from(l)),
    stamp: new Int32Array(walls.length),
    gen: 0,
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `castRay` と同じ値を返す。原点から向き (dx,dz) へ `maxDist` まで進んだときの
 * 最初の交点距離。何にも当たらなければ `maxDist`。
 *
 * セルは Amanatides & Woo の DDA でたどる。線分と交わる壁は必ずどこかの通過セルに
 * 入っているので、走査する壁は全数走査の**部分集合ではなく**、必要十分な集合になる。
 */
export function castRayIndexed(
  idx: WallIndex,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
): number {
  if (maxDist <= 0) return maxDist;
  const { cell, minX, minZ, cols, rows, buckets, all } = idx;

  let best = maxDist;
  const gen = ++idx.gen;
  const stamp = idx.stamp;

  let gx = Math.floor((ox - minX) / cell);
  let gz = Math.floor((oz - minZ) / cell);
  const endX = Math.floor((ox + dx * maxDist - minX) / cell);
  const endZ = Math.floor((oz + dz * maxDist - minZ) / cell);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  // 次のセル境界までの距離と、セル1つぶん進むのに要する距離
  const tDeltaX = stepX === 0 ? Infinity : cell / Math.abs(dx);
  const tDeltaZ = stepZ === 0 ? Infinity : cell / Math.abs(dz);
  let tMaxX =
    stepX === 0
      ? Infinity
      : (minX + (gx + (stepX > 0 ? 1 : 0)) * cell - ox) / dx;
  let tMaxZ =
    stepZ === 0
      ? Infinity
      : (minZ + (gz + (stepZ > 0 ? 1 : 0)) * cell - oz) / dz;

  // 盤外から始まる線分もありうる(視線原点が境界ぎりぎりの場合)。安全側に倒して
  // 全数走査へ落とす — 正しさを索引の都合で妥協しない。
  if (gx < 0 || gx >= cols || gz < 0 || gz >= rows) {
    for (const w of all) {
      const t = rayAABB(ox, oz, dx, dz, w, best);
      if (t !== null && t < best) best = t;
    }
    return best;
  }

  for (;;) {
    const bucket = buckets[gz * cols + gx]!;
    for (let k = 0; k < bucket.length; k++) {
      const i = bucket[k]!;
      if (stamp[i] === gen) continue;
      stamp[i] = gen;
      const t = rayAABB(ox, oz, dx, dz, all[i]!, best);
      if (t !== null && t < best) best = t;
    }
    if (gx === endX && gz === endZ) break;
    // 交点が既に確定していて、次のセルへ入る距離がそれより遠いなら打ち切れる
    const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
    if (tNext > best) break;
    if (tMaxX < tMaxZ) {
      gx += stepX;
      tMaxX += tDeltaX;
    } else {
      gz += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (gx < 0 || gx >= cols || gz < 0 || gz >= rows) break;
  }
  return best;
}

/** `hasLineOfSight` と同じ判定を索引経由で行う。 */
export function hasLineOfSightIndexed(
  idx: WallIndex,
  ox: number,
  oz: number,
  ex: number,
  ez: number,
): boolean {
  const dx0 = ex - ox;
  const dz0 = ez - oz;
  const d = Math.hypot(dx0, dz0);
  if (d < 1e-6) return true;
  const hit = castRayIndexed(idx, ox, oz, dx0 / d, dz0 / d, d - 0.05);
  return hit >= d - 0.06;
}

/** `collidesWall` と同じ判定を索引経由で行う。`r` は PAD 以下であること。 */
export function collidesWallIndexed(idx: WallIndex, x: number, z: number, r = 0.35): boolean {
  const gx = Math.floor((x - idx.minX) / idx.cell);
  const gz = Math.floor((z - idx.minZ) / idx.cell);
  if (gx < 0 || gx >= idx.cols || gz < 0 || gz >= idx.rows) {
    // 盤外は索引の外。安全側に倒して全数走査する
    return idx.all.some(
      (w) =>
        x > w.cx - w.hw - r && x < w.cx + w.hw + r && z > w.cz - w.hd - r && z < w.cz + w.hd + r,
    );
  }
  const bucket = idx.buckets[gz * idx.cols + gx]!;
  for (let k = 0; k < bucket.length; k++) {
    const w = idx.all[bucket[k]!]!;
    if (x > w.cx - w.hw - r && x < w.cx + w.hw + r && z > w.cz - w.hd - r && z < w.cz + w.hd + r) {
      return true;
    }
  }
  return false;
}
