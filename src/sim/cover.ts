/**
 * Cover point generation + scoring. Ported from squad-12v12's COVER_POINTS /
 * coverBonus / nearestCoverTowards / bestCoverPoint / bestFlankPoint.
 *
 * The point set is a coarse lattice of wall-free positions; scoring prefers
 * positions close to a wall (cover), inside the engagement band, and — for a
 * flank — off the base-of-fire element's axis so the enemy is caught from two
 * directions (spec §6 fire and movement).
 */

import { collidesWall, hasLineOfSight, nearestWallDist, clamp } from "./geometry.ts";
import type { AABB, Bounds, Vec2 } from "./types.ts";

/** Spacing of the candidate lattice, m. [mock — squad-12v12 step 1.4*MAP_SCALE] */
const COVER_STEP = 2.2;
/** Cover credit saturates at this distance from a wall, m. [mock] */
const COVER_SATURATE = 2.4;

/**
 * Candidate positions on a lattice **centred on the map**, not grown from the
 * min corner. Centring matters: on a point-symmetric map a corner-grown lattice
 * gives the two forces different candidate sets, which quietly favours one side
 * and violates force symmetry (spec §2/§13).
 */
export function buildCoverPoints(walls: readonly AABB[], bounds: Bounds): Vec2[] {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const nx = Math.floor((bounds.maxX - cx - 1) / COVER_STEP);
  const nz = Math.floor((bounds.maxZ - cz - 1) / COVER_STEP);

  const pts: Vec2[] = [];
  for (let i = -nx; i <= nx; i++) {
    for (let j = -nz; j <= nz; j++) {
      const x = cx + i * COVER_STEP;
      const z = cz + j * COVER_STEP;
      if (!collidesWall(walls, x, z, 0.4)) pts.push({ x, z });
    }
  }
  return pts;
}

/** 0..COVER_SATURATE — higher means better covered. */
export function coverBonus(walls: readonly AABB[], x: number, z: number): number {
  return clamp(COVER_SATURATE - nearestWallDist(walls, x, z), 0, COVER_SATURATE);
}

/**
 * Best bound destination: a covered point `minAdv`..`maxAdv` ahead along `dir`.
 * When `support` is given, the point must be visible from it — bounding elements
 * stay inside the overwatch element's supporting fire (spec §6).
 */
export function nearestCoverTowards(
  walls: readonly AABB[],
  points: readonly Vec2[],
  from: Vec2,
  dir: Vec2,
  minAdv: number,
  maxAdv: number,
  support?: Vec2,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  for (const p of points) {
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const along = dx * dir.x + dz * dir.z;
    if (along < minAdv || along > maxAdv) continue;
    const lateral = Math.abs(dx * -dir.z + dz * dir.x);
    if (lateral > maxAdv) continue;
    if (support && !hasLineOfSight(walls, support.x, support.z, p.x, p.z)) continue;

    const score = along * 0.6 - lateral * 0.5 + coverBonus(walls, p.x, p.z) * 1.4;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * Widening search for a supported bound target, then a relaxed pass that drops
 * the support requirement rather than freezing in place (mock behaviour).
 */
export function pickSupportedBoundTarget(
  walls: readonly AABB[],
  points: readonly Vec2[],
  from: Vec2,
  dir: Vec2,
  minAdv: number,
  maxAdv: number,
  support?: Vec2,
): Vec2 | null {
  const ranges: [number, number][] = [
    [minAdv, maxAdv],
    [minAdv, maxAdv * 1.6],
    [minAdv * 0.5, maxAdv * 2.4],
  ];
  for (const [mn, mx] of ranges) {
    const p = nearestCoverTowards(walls, points, from, dir, mn, mx, support);
    if (p) return p;
  }
  return nearestCoverTowards(walls, points, from, dir, minAdv, maxAdv * 2.4);
}

/** Best firing position on the enemy: in the engagement band, in LOS, in cover. */
export function bestCoverPoint(
  walls: readonly AABB[],
  points: readonly Vec2[],
  from: Vec2,
  enemy: Vec2,
  engageMin: number,
  engageMax: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  for (const p of points) {
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < engageMin || dToEnemy > engageMax) continue;
    if (!hasLineOfSight(walls, p.x, p.z, enemy.x, enemy.z)) continue;
    const travel = Math.hypot(p.x - from.x, p.z - from.z);
    if (travel > 18) continue;

    const score = coverBonus(walls, p.x, p.z) * 2 - travel * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * Best flanking position: like bestCoverPoint, but rewards angular separation
 * from the base-of-fire element as seen from the enemy — the maneuver element
 * should attack from a different axis.
 */
export function bestFlankPoint(
  walls: readonly AABB[],
  points: readonly Vec2[],
  from: Vec2,
  enemy: Vec2,
  base: Vec2,
  engageMin: number,
  engageMax: number,
): Vec2 | null {
  const baseAngle = Math.atan2(base.x - enemy.x, base.z - enemy.z);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  for (const p of points) {
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < engageMin || dToEnemy > engageMax) continue;
    const travel = Math.hypot(p.x - from.x, p.z - from.z);
    if (travel > 20) continue;

    const a = Math.atan2(p.x - enemy.x, p.z - enemy.z);
    let sep = Math.abs(a - baseAngle);
    while (sep > Math.PI) sep = Math.PI * 2 - sep;
    // reward ~90° of separation from the base element
    const sepScore = 1 - Math.abs(sep - Math.PI / 2) / (Math.PI / 2);

    const score = sepScore * 3 + coverBonus(walls, p.x, p.z) * 1.2 - travel * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
