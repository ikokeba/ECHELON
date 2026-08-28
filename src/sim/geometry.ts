/**
 * 共有ジオメトリ・プリミティブ。
 *
 * `rayAABB` / `castRay` / `hasLineOfSight` / `collidesWall` / `edgeIsClear` は
 * three.js を使う各プロトタイプへコピペされていたもの。ここが唯一の実装となる。
 * イプシロン値を含め、検証済みモックと挙動が完全に一致するよう移植した。壁は
 * クロージャで閉じ込めず、引数として渡す形に変更している。
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
 * レイと1つのAABBの交差判定。(dx,dz) 方向に沿った [0, maxDist] 内の交差距離を返す。
 * 交差しなければ null。(dx,dz) は単位ベクトルであることを前提とする。
 * スラブ法。squad-12v12-3ft-autobattle-mock.jsx からそのまま移植。
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

/** 単位レイに沿った最も近い壁までの距離。maxDist で打ち切る。 */
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

/** 線分 (ox,oz)->(ex,ez) が遮蔽されていなければ true。squadモックと同一挙動。 */
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

/** (x,z) を中心とする半径 r の円が、いずれかの壁と重なっていれば true。 */
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
 * ナビグリッドの辺 (ax,az)->(bx,bz) が通行可能なら true。中心線に加え、`margin`
 * だけ左右へオフセットした2本の平行線も判定する(兵士の幅を考慮)。
 * cqb-minimal-prototype から移植。
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

/** 向きベクトルを角度(rad)へ。X/Z平面なので atan2(x, z) を使う。 */
export function angleOf(v: Vec2): number {
  return Math.atan2(v.x, v.z);
}

/** 角度(rad)を向きの単位ベクトルへ。 */
export function dirFromAngle(a: number): Vec2 {
  return { x: Math.sin(a), z: Math.cos(a) };
}

/**
 * `current` から `target` へ、1ステップ最大 `maxDelta` だけ旋回する。
 *
 * **差分の正規化は半開区間 (-π, +π] で行う**。これは対称性のために必須:
 * ちょうど180°の反転(diff が ±π)は数学的に左右どちらの回転でも等価だが、
 * -π と +π を別々に扱うと Math.sign が逆符号を返し、両陣営が逆方向へ回る。
 * 点対称な初期配置ではこれが系統的な優劣を生む(実際に、青軍だけが目標へ速く
 * 正対して一貫して有利になる不具合を起こした)。-π を +π に畳んで、
 * 反転時は必ず同じ回転方向を選ばせる。
 */
export function turnToward(current: number, target: number, maxDelta: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff <= -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** 点から最も近い壁表面までの距離(壁の内部なら0)。 */
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
