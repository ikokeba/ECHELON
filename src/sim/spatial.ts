/**
 * 一様空間ハッシュ。近傍問い合わせを O(n²) から実質 O(n) へ落とす。
 *
 * 索敵(視界内の敵探索)と兵士同士の分離は、どちらも「半径R以内の他の兵士」を
 * 毎ティック問い合わせる。分隊規模(18名)では総当たりでも問題にならないが、
 * 仕様 §2 が想定する中隊規模(両軍で約260名)では 260² = 67,600 回/ティック、
 * 30Hzで毎秒200万回に達して破綻する。
 *
 * セルサイズは想定する問い合わせ半径と同程度にするのが定石。索敵距離(20m)と
 * 分離半径(1m弱)ではスケールが違いすぎるので、用途ごとにインスタンスを分ける。
 */

import type { Vec2 } from "./types.ts";

export interface SpatialHash<T> {
  cellSize: number;
  /** セルキー -> そのセルに属する要素 */
  cells: Map<number, T[]>;
}

/**
 * セルキーを1つの数値へ詰める。座標は ±16384 セルの範囲に収まる前提
 * (セル1mでもマップ32km四方まで表現できるので実用上十分)。
 */
function cellKey(gx: number, gz: number): number {
  return (gx + 16384) * 32768 + (gz + 16384);
}

export function createSpatialHash<T>(cellSize: number): SpatialHash<T> {
  return { cellSize, cells: new Map() };
}

export function clearHash<T>(hash: SpatialHash<T>): void {
  hash.cells.clear();
}

export function insert<T>(hash: SpatialHash<T>, pos: Vec2, item: T): void {
  const gx = Math.floor(pos.x / hash.cellSize);
  const gz = Math.floor(pos.z / hash.cellSize);
  const key = cellKey(gx, gz);
  const bucket = hash.cells.get(key);
  if (bucket) bucket.push(item);
  else hash.cells.set(key, [item]);
}

/**
 * `pos` を中心とする半径 `radius` の円と交差しうるセルの要素すべてに `fn` を適用する。
 * セル境界の都合で半径外の要素も渡されるため、呼び出し側で距離を確認すること。
 */
export function forEachNear<T>(
  hash: SpatialHash<T>,
  pos: Vec2,
  radius: number,
  fn: (item: T) => void,
): void {
  const r = Math.ceil(radius / hash.cellSize);
  const cgx = Math.floor(pos.x / hash.cellSize);
  const cgz = Math.floor(pos.z / hash.cellSize);
  for (let gx = cgx - r; gx <= cgx + r; gx++) {
    for (let gz = cgz - r; gz <= cgz + r; gz++) {
      const bucket = hash.cells.get(cellKey(gx, gz));
      if (!bucket) continue;
      for (const item of bucket) fn(item);
    }
  }
}
