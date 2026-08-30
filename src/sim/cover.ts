/**
 * 遮蔽点の生成と評価。squad-12v12 の COVER_POINTS / coverBonus /
 * nearestCoverTowards / bestCoverPoint / bestFlankPoint からの移植。
 *
 * 候補点は壁のない位置を粗い格子状に並べたもの。評価は、壁に近い位置(=遮蔽が効く)、
 * 交戦距離帯の内側、そして側面攻撃の場合はベース・オブ・ファイア組の軸から外れた
 * 位置を優遇する。敵を2方向から捉えるためである(仕様 §6 Fire and Movement)。
 */

import { collidesWall, hasLineOfSight, nearestWallDist, clamp } from "./geometry.ts";
import { hasLineOfSightIndexed, type WallIndex } from "./wallIndex.ts";
import type { AABB, Bounds, Building, Vec2 } from "./types.ts";

/** 候補点格子の間隔 m。[mock — squad-12v12 の step 1.4*MAP_SCALE 相当] */
const COVER_STEP = 2.2;
/** 壁からこの距離以遠は遮蔽の加点が飽和する m。[mock] */
export const COVER_SATURATE = 2.4;

/**
 * 遮蔽候補点。遮蔽値は静的な壁だけで決まるので**構築時に一度だけ**計算しておく。
 * `[v6.2]` `coverBonus` は全壁走査なので、候補点×兵士で毎回呼ぶと市街地マップ
 * (壁460枚・候補点数千)では実用にならない。
 *
 * `Vec2` として扱えるので、既存の `readonly Vec2[]` を取る関数にもそのまま渡せる。
 */
export interface CoverPoint extends Vec2 {
  /** 0..COVER_SATURATE。大きいほど遮蔽が効いている */
  cover: number;
}

/**
 * 候補位置を**マップ中心を原点とする格子**上に生成する(最小コーナーから伸ばさない)。
 * 中心基準にすることには意味がある: 点対称なマップでコーナー起点の格子を作ると、
 * 両陣営に異なる候補集合が与えられてしまい、片側を静かに有利にして戦力対称性
 * (仕様 §2/§13)を壊すため。
 *
 * `[v6.2]` **建物の内側は候補にしない**。屋内へ入るのは仕様 §7.2 の突入ドリル
 * (孤立化→支援射撃→突撃)の担当で、遮蔽を求めてふらりと入る場所ではない。
 * 候補に含めると、閉じた扉の向こう側を目的地にした兵士が扉に張り付いて止まる。
 */
export function buildCoverPoints(
  walls: readonly AABB[],
  bounds: Bounds,
  buildings: readonly Building[] = [],
): CoverPoint[] {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const nx = Math.floor((bounds.maxX - cx - 1) / COVER_STEP);
  const nz = Math.floor((bounds.maxZ - cz - 1) / COVER_STEP);

  const pts: CoverPoint[] = [];
  for (let i = -nx; i <= nx; i++) {
    for (let j = -nz; j <= nz; j++) {
      const x = cx + i * COVER_STEP;
      const z = cz + j * COVER_STEP;
      if (collidesWall(walls, x, z, 0.4)) continue;
      const indoors = buildings.some(
        (b) => x >= b.bounds.minX && x <= b.bounds.maxX && z >= b.bounds.minZ && z <= b.bounds.maxZ,
      );
      if (indoors) continue;
      pts.push({ x, z, cover: coverBonus(walls, x, z) });
    }
  }
  return pts;
}

/**
 * 壁からの理想的な距離 m。`[v6.3]`
 *
 * 従来は壁との距離0で最大値になっていた = **密着を最も高く評価**していた。
 * これは米軍ドクトリン(TC 3-21.75)がむしろ否定する動きで、壁に密着すると
 * 跳弾が壁面に沿って走るため、腕1本ぶん離れて進む・構えるのが正しい
 * (3回目のテストプレイ指摘への調査で判明)。
 */
const COVER_STANDOFF = 0.8;

/**
 * 0..COVER_SATURATE の値。大きいほど遮蔽が効いている。
 * **`COVER_STANDOFF` で最大**になり、密着してもそこから離れても下がる。
 */
export function coverBonus(walls: readonly AABB[], x: number, z: number): number {
  const off = Math.abs(nearestWallDist(walls, x, z) - COVER_STANDOFF);
  return clamp(COVER_SATURATE - off, 0, COVER_SATURATE);
}

/**
 * 最良の躍進先: `dir` 方向へ `minAdv`..`maxAdv` 前方にある遮蔽の効いた地点。
 * `support`(オーバーウォッチ側の位置)が渡された場合、そこから視認できない地点は
 * 候補から除外する — 躍進する組は常に警戒組の支援射撃範囲内に留まる(仕様 §6)。
 */
export function nearestCoverTowards(
  walls: readonly AABB[],
  points: readonly CoverPoint[],
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

    const score = along * 0.6 - lateral * 0.5 + p.cover * 1.4;
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
  points: readonly CoverPoint[],
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
  points: readonly CoverPoint[],
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

    const score = p.cover * 2 - travel * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * **いまいる場所より良い、すぐ隣の遮蔽**。`[v6.2]`
 *
 * 2回目のテストプレイ指摘「敵を見つけたらカバー(角など)を即座に探し、そこを起点に
 * 身を隠しながら戦う」への実装。従来のFT AIは、射線が通っていて交戦距離帯に入って
 * さえいれば**開豁地に突っ立ったまま**撃ち続けていた(`inPosition` なら移動しない)。
 *
 * `bestCoverPoint` との違いは目的:あちらは「撃てる位置が無いので探す」、こちらは
 * 「撃ててはいるが露出しているので、射線を保ったまま身を寄せる」。したがって
 *   - 移動距離を短く抑える(射撃姿勢を大きく崩さない)
 *   - いまの遮蔽より `minGain` 以上良くなければ動かない(往復を防ぐ)
 * の2点で条件が厳しい。
 */
export function bestNearbyCover(
  idx: WallIndex,
  points: readonly CoverPoint[],
  from: Vec2,
  enemy: Vec2,
  engageMin: number,
  engageMax: number,
  maxMove: number,
  /** ここを下回る遮蔽値の候補は採らない */
  minCover: number,
  /** 敵から遠ざかってよい上限 m。踏み止まるための移動であって後退ではない */
  maxYield: number,
): Vec2 | null {
  const dNow = Math.hypot(from.x - enemy.x, from.z - enemy.z);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  for (const p of points) {
    // 事前計算済みの遮蔽値と移動距離で先に落とす(候補点は数千あるので順序が効く)
    if (p.cover < minCover) continue;
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const travel2 = dx * dx + dz * dz;
    if (travel2 > maxMove * maxMove) continue;
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < engageMin || dToEnemy > engageMax) continue;
    // **地歩を譲らない**。背後の遮蔽も等しく選べるようにすると、判断周期ごとに
    // 少しずつ下がってスポーン端まで後退してしまう
    if (dToEnemy > dNow + maxYield) continue;
    if (!hasLineOfSightIndexed(idx, p.x, p.z, enemy.x, enemy.z)) continue;

    // 遮蔽を最優先し、近さと「敵へ寄れるぶん」で差をつける
    const score = p.cover * 3 - Math.sqrt(travel2) * 0.25 + (dNow - dToEnemy) * 0.2;
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
  points: readonly CoverPoint[],
  from: Vec2,
  enemy: Vec2,
  base: Vec2,
  engageMin: number,
  engageMax: number,
  /**
   * 任務目標。`[v6.2]` 同じくらい良い側面位置が2つあるなら、目標に近い側を選ぶ。
   * これが無いと、接敵した分隊は敵のまわりを回るだけで**目標へ一歩も近づかない** —
   * 拠点が建物の中にある場合、突入発動距離(22m)まで永久に到達しなかった。
   */
  objective?: Vec2,
): Vec2 | null {
  const baseAngle = Math.atan2(base.x - enemy.x, base.z - enemy.z);
  const dObjNow = objective ? Math.hypot(from.x - objective.x, from.z - objective.z) : 0;
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
    // 目標へ詰められるぶんを加点(遠ざかる位置は減点)。側面確保より弱い重みにして、
    // 「目標へ一直線」ではなく「側面を取りつつ寄る」になるようにする
    const gain = objective
      ? dObjNow - Math.hypot(p.x - objective.x, p.z - objective.z)
      : 0;

    const score = sepScore * 3 + p.cover * 1.2 - travel * 0.3 + gain * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
