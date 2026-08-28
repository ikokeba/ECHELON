/**
 * 経路追従。cqb-minimal-prototype.jsx の `stepAlongPath` を純粋関数として移植したもの。
 * 現在位置・ウェイポイント列・現在のウェイポイントindex・このティックの移動量を受け取り、
 * 移動後の状態を返す(引数は破壊しない)。
 */

import type { Vec2 } from "./types.ts";

export interface PathStep {
  pos: Vec2;
  /** 進んだ結果更新されたウェイポイントindex */
  pathIdx: number;
  arrived: boolean;
  /** 実際に移動した場合の進行方向(単位ベクトル) */
  dir?: Vec2;
}

const WAYPOINT_EPS = 0.06;

export function advanceAlongPath(
  pos: Vec2,
  path: readonly Vec2[],
  pathIdx: number,
  maxDist: number,
): PathStep {
  if (path.length === 0 || pathIdx >= path.length) {
    return { pos: { ...pos }, pathIdx, arrived: true };
  }

  let idx = pathIdx;
  let cx = pos.x;
  let cz = pos.z;
  let budget = maxDist;
  let dir: Vec2 | undefined;

  // 1ティックの移動量が複数のウェイポイントをまたぐ場合があるのでループする
  while (idx < path.length && budget > 1e-9) {
    const wp = path[idx]!;
    const dx = wp.x - cx;
    const dz = wp.z - cz;
    const d = Math.hypot(dx, dz);

    if (d < WAYPOINT_EPS) {
      idx += 1;
      continue;
    }

    dir = { x: dx / d, z: dz / d };
    const stepLen = Math.min(d, budget);
    cx += dir.x * stepLen;
    cz += dir.z * stepLen;
    budget -= stepLen;

    if (stepLen >= d - 1e-9) {
      idx += 1;
    }
  }

  return {
    pos: { x: cx, z: cz },
    pathIdx: idx,
    arrived: idx >= path.length,
    ...(dir ? { dir } : {}),
  };
}
