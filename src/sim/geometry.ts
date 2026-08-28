/**
 * Shared geometry primitives. These were copy-pasted into every three.js
 * prototype (`rayAABB`, `castRay`, `hasLineOfSight`, `collidesWall`,
 * `edgeIsClear`); this is the single implementation. Behaviour — including the
 * exact epsilons — matches the verified mocks. Walls are passed in rather than
 * closed over.
 */

import type { AABB, Vec2 } from "./types.ts";

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function lengthOf(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

export function normalize(v: Vec2): Vec2 {
  const d = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / d, z: v.z / d };
}

/**
 * Ray vs one AABB. Returns the hit distance along (dx,dz) within [0, maxDist],
 * or null. (dx,dz) is expected to be a unit vector. Slab method, ported verbatim
 * from squad-12v12-3ft-autobattle-mock.jsx.
 */
export function rayAABB(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  wall: AABB,
  maxDist: number,
): number | null {
  const minX = wall.cx - wall.hw;
  const maxX = wall.cx + wall.hw;
  const minZ = wall.cz - wall.hd;
  const maxZ = wall.cz + wall.hd;
  let tmin = -Infinity;
  let tmax = Infinity;

  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return null;
  } else {
    let t1 = (minX - ox) / dx;
    let t2 = (maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }

  if (Math.abs(dz) < 1e-9) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    let t1 = (minZ - oz) / dz;
    let t2 = (maxZ - oz) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }

  if (tmax < tmin || tmax < 0) return null;
  const hit = tmin > 0.001 ? tmin : tmax;
  if (hit < 0 || hit > maxDist) return null;
  return hit;
}

/** Nearest wall hit distance along a unit ray, capped at maxDist. */
export function castRay(
  walls: readonly AABB[],
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
): number {
  let best = maxDist;
  for (const w of walls) {
    const t = rayAABB(ox, oz, dx, dz, w, best);
    if (t !== null && t < best) best = t;
  }
  return best;
}

/** True if nothing blocks the segment (ox,oz)->(ex,ez). Matches the squad mock. */
export function hasLineOfSight(
  walls: readonly AABB[],
  ox: number,
  oz: number,
  ex: number,
  ez: number,
): boolean {
  const dx0 = ex - ox;
  const dz0 = ez - oz;
  const d = Math.hypot(dx0, dz0);
  if (d < 1e-6) return true;
  const dx = dx0 / d;
  const dz = dz0 / d;
  const hit = castRay(walls, ox, oz, dx, dz, d - 0.05);
  return hit >= d - 0.06;
}

/** True if a disc of radius r centred at (x,z) overlaps any wall. */
export function collidesWall(
  walls: readonly AABB[],
  x: number,
  z: number,
  r = 0.35,
): boolean {
  return walls.some(
    (w) =>
      x > w.cx - w.hw - r &&
      x < w.cx + w.hw + r &&
      z > w.cz - w.hd - r &&
      z < w.cz + w.hd + r,
  );
}

/**
 * True if a nav-grid edge (ax,az)->(bx,bz) is clear for a unit — the centre line
 * plus two parallel lines offset by `margin`. Ported from cqb-minimal-prototype.
 */
export function edgeIsClear(
  walls: readonly AABB[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  margin = 0.18,
): boolean {
  if (!hasLineOfSight(walls, ax, az, bx, bz)) return false;
  const dx = bx - ax;
  const dz = bz - az;
  const d = Math.hypot(dx, dz) || 1;
  const px = -dz / d;
  const pz = dx / d;
  if (
    !hasLineOfSight(walls, ax + px * margin, az + pz * margin, bx + px * margin, bz + pz * margin)
  ) {
    return false;
  }
  if (
    !hasLineOfSight(walls, ax - px * margin, az - pz * margin, bx - px * margin, bz - pz * margin)
  ) {
    return false;
  }
  return true;
}

/** Shortest distance from a point to the surface of any wall (0 if inside one). */
export function nearestWallDist(walls: readonly AABB[], x: number, z: number): number {
  let best = Infinity;
  for (const w of walls) {
    const cx = clamp(x, w.cx - w.hw, w.cx + w.hw);
    const cz = clamp(z, w.cz - w.hd, w.cz + w.hd);
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) best = d;
  }
  return best;
}
