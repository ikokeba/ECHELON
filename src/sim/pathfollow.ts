/**
 * Path following. Pure port of `stepAlongPath` from cqb-minimal-prototype.jsx:
 * given a position, a waypoint list, the current waypoint index and a move
 * budget for this tick, return where the mover ends up.
 */

import type { Vec2 } from "./types.ts";

export interface PathStep {
  pos: Vec2;
  /** possibly-advanced waypoint index */
  pathIdx: number;
  arrived: boolean;
  /** unit heading of travel this step, if it moved */
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
