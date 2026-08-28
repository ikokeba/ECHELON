/**
 * 遮蔽点の生成と評価。squad-12v12 の COVER_POINTS / coverBonus /
 * nearestCoverTowards / bestCoverPoint / bestFlankPoint からの移植。
 *
 * 候補点は壁のない位置を粗い格子状に並べたもの。評価は、壁に近い位置(=遮蔽が効く)、
 * 交戦距離帯の内側、そして側面攻撃の場合はベース・オブ・ファイア組の軸から外れた
 * 位置を優遇する。敵を2方向から捉えるためである(仕様 §6 Fire and Movement)。
 */

import { collidesWall, hasLineOfSight, nearestWallDist, clamp } from "./geometry.ts";
import type { AABB, Bounds, Vec2 } from "./types.ts";

/** 候補点格子の間隔 m。[mock — squad-12v12 の step 1.4*MAP_SCALE 相当] */
const COVER_STEP = 2.2;
/** 壁からこの距離以遠は遮蔽の加点が飽和する m。[mock] */
const COVER_SATURATE = 2.4;

/**
 * 候補位置を**マップ中心を原点とする格子**上に生成する(最小コーナーから伸ばさない)。
 * 中心基準にすることには意味がある: 点対称なマップでコーナー起点の格子を作ると、
 * 両陣営に異なる候補集合が与えられてしまい、片側を静かに有利にして戦力対称性
 * (仕様 §2/§13)を壊すため。
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

/** 0..COVER_SATURATE の値。大きいほど遮蔽が効いている。 */
export function coverBonus(walls: readonly AABB[], x: number, z: number): number {
  return clamp(COVER_SATURATE - nearestWallDist(walls, x, z), 0, COVER_SATURATE);
}

/**
 * 最良の躍進先: `dir` 方向へ `minAdv`..`maxAdv` 前方にある遮蔽の効いた地点。
 * `support`(オーバーウォッチ側の位置)が渡された場合、そこから視認できない地点は
 * 候補から除外する — 躍進する組は常に警戒組の支援射撃範囲内に留まる(仕様 §6)。
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
 * 支援下の躍進先を探索範囲を段階的に広げながら探す。それでも見つからない場合は、
 * その場で完全停止させるのではなく支援条件だけを外して前進を優先する(モックの挙動)。
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

/** 敵に対する最良の射撃位置: 交戦距離帯の内側・LOSが通る・遮蔽が効く。 */
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
 * 最良の側面攻撃位置: bestCoverPoint と同様だが、敵から見たときのベース・オブ・
 * ファイア組との角度差を加点する — 機動組は別の軸から攻撃すべきであるため。
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
    // ベース組から約90°離れている位置を最も高く評価する
    const sepScore = 1 - Math.abs(sep - Math.PI / 2) / (Math.PI / 2);

    const score = sepScore * 3 + coverBonus(walls, p.x, p.z) * 1.2 - travel * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
