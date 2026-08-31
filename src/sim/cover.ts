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
 * 遮蔽候補点の空間索引。`[v6.3]`
 *
 * 候補点の探索はどれも「`from` から半径いくら以内」で絞れるのに、実装は全点を走査して
 * いた。盤面を2倍(440×340)にして候補点が約3.1万になった結果、**FTリーダーAIが
 * ティック時間の83%を占める**ところまで悪化した(1兵士1判断ごとに3.1万点の走査)。
 *
 * 一様グリッドに振り分け、半径内のセルだけを見る。返る点の集合は全走査と同一なので、
 * 選ばれる地点も決定性も変わらない。
 */
export interface CoverIndex {
  points: readonly CoverPoint[];
  cell: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** 長さ cols*rows。各要素は `points` へのindex配列 */
  buckets: Int32Array[];
}

/** 索引のセル一辺 m。最小の探索半径(遮蔽への寄り 9m)より小さく取る。 */
const COVER_CELL = 8;
/** 射撃位置を探すときに移動してよい距離 m(従来はリテラル 18) */
const MAX_REPOSITION = 18;
/** 側面位置を探すときに移動してよい距離 m(従来はリテラル 20) */
const MAX_FLANK_TRAVEL = 20;

export function buildCoverIndex(points: readonly CoverPoint[], bounds: Bounds): CoverIndex {
  const minX = bounds.minX - COVER_CELL;
  const minZ = bounds.minZ - COVER_CELL;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + COVER_CELL * 2) / COVER_CELL));
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ + COVER_CELL * 2) / COVER_CELL));
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  points.forEach((p, i) => {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor((p.x - minX) / COVER_CELL)));
    const gz = Math.min(rows - 1, Math.max(0, Math.floor((p.z - minZ) / COVER_CELL)));
    lists[gz * cols + gx]!.push(i);
  });
  return { points, cell: COVER_CELL, minX, minZ, cols, rows, buckets: lists.map((l) => Int32Array.from(l)) };
}

/**
 * `from` から半径 `radius` 以内の候補点を列挙する。
 * セル単位の粗い絞り込みなので、半径をわずかに超える点も渡る — 呼び出し側は
 * 従来どおり自分の条件で弾くこと(全走査と同じ結果になるのはそのため)。
 */
export function forEachCoverNear(
  idx: CoverIndex,
  from: Vec2,
  radius: number,
  cb: (p: CoverPoint) => void,
): void {
  const r = Math.max(0, radius);
  const gx0 = Math.max(0, Math.floor((from.x - r - idx.minX) / idx.cell));
  const gx1 = Math.min(idx.cols - 1, Math.floor((from.x + r - idx.minX) / idx.cell));
  const gz0 = Math.max(0, Math.floor((from.z - r - idx.minZ) / idx.cell));
  const gz1 = Math.min(idx.rows - 1, Math.floor((from.z + r - idx.minZ) / idx.cell));
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const b = idx.buckets[gz * idx.cols + gx]!;
      for (let k = 0; k < b.length; k++) cb(idx.points[b[k]!]!);
    }
  }
}

/**
 * 最良の躍進先: `dir` 方向へ `minAdv`..`maxAdv` 前方にある遮蔽の効いた地点。
 * `support`(オーバーウォッチ側の位置)が渡された場合、そこから視認できない地点は
 * 候補から除外する — 躍進する組は常に警戒組の支援射撃範囲内に留まる(仕様 §6)。
 */
export function nearestCoverTowards(
  walls: readonly AABB[],
  cover: CoverIndex,
  from: Vec2,
  dir: Vec2,
  minAdv: number,
  maxAdv: number,
  support?: Vec2,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  // along も lateral も maxAdv 以内なので、半径 maxAdv*1.5 の外は見なくてよい
  forEachCoverNear(cover, from, maxAdv * 1.5, (p) => {
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const along = dx * dir.x + dz * dir.z;
    if (along < minAdv || along > maxAdv) return;
    const lateral = Math.abs(dx * -dir.z + dz * dir.x);
    if (lateral > maxAdv) return;
    if (support && !hasLineOfSight(walls, support.x, support.z, p.x, p.z)) return;

    const score = along * 0.6 - lateral * 0.5 + p.cover * 1.4;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return best;
}

/**
 * 支援下の躍進先を探索範囲を段階的に広げながら探す。それでも見つからない場合は、
 * その場で完全停止させるのではなく支援条件だけを外して前進を優先する(モックの挙動)。
 */
export function pickSupportedBoundTarget(
  walls: readonly AABB[],
  cover: CoverIndex,
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
    const p = nearestCoverTowards(walls, cover, from, dir, mn, mx, support);
    if (p) return p;
  }
  return nearestCoverTowards(walls, cover, from, dir, minAdv, maxAdv * 2.4);
}

/** 敵に対する最良の射撃位置: 交戦距離帯の内側・LOSが通る・遮蔽が効く。 */
export function bestCoverPoint(
  walls: readonly AABB[],
  cover: CoverIndex,
  from: Vec2,
  enemy: Vec2,
  engageMin: number,
  engageMax: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  forEachCoverNear(cover, from, MAX_REPOSITION, (p) => {
    const travel = Math.hypot(p.x - from.x, p.z - from.z);
    if (travel > MAX_REPOSITION) return;
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < engageMin || dToEnemy > engageMax) return;
    if (!hasLineOfSight(walls, p.x, p.z, enemy.x, enemy.z)) return;

    const score = p.cover * 2 - travel * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
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
  cover: CoverIndex,
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

  forEachCoverNear(cover, from, maxMove, (p) => {
    // 事前計算済みの遮蔽値と移動距離で先に落とす
    if (p.cover < minCover) return;
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const travel2 = dx * dx + dz * dz;
    if (travel2 > maxMove * maxMove) return;
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < engageMin || dToEnemy > engageMax) return;
    // **地歩を譲らない**。背後の遮蔽も等しく選べるようにすると、判断周期ごとに
    // 少しずつ下がってスポーン端まで後退してしまう
    if (dToEnemy > dNow + maxYield) return;
    if (!hasLineOfSightIndexed(idx, p.x, p.z, enemy.x, enemy.z)) return;

    // 遮蔽を最優先し、近さと「敵へ寄れるぶん」で差をつける
    const score = p.cover * 3 - Math.sqrt(travel2) * 0.25 + (dNow - dToEnemy) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return best;
}

/**
 * **接敵直後にとりあえず身を隠すための遮蔽**(`[v6.4]`)。
 *
 * ATP 3-21.8 Battle Drill 2「React to Contact」の即応行動は
 * 「応射しつつ遮蔽へ入る」であって、交戦距離帯へ詰めることではない。
 * したがって `bestNearbyCover` と違い、**交戦距離帯を条件にしない**し、射線も
 * 必須にしない(射線が通る遮蔽のほうが望ましいので加点はする)。
 *
 * 「地歩を譲らない」制約だけは残す。これが無いと、接敵のたびに後方の遮蔽へ
 * 下がって前線が後ろへずり続ける(`bestNearbyCover` で実際に踏んだ)。
 */
export function nearestCoverNow(
  idx: WallIndex,
  cover: CoverIndex,
  from: Vec2,
  enemy: Vec2,
  maxMove: number,
  minCover: number,
  maxYield: number,
): Vec2 | null {
  const dNow = Math.hypot(from.x - enemy.x, from.z - enemy.z);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  forEachCoverNear(cover, from, maxMove, (p) => {
    if (p.cover < minCover) return;
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const travel2 = dx * dx + dz * dz;
    if (travel2 > maxMove * maxMove) return;
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy > dNow + maxYield) return;
    const los = hasLineOfSightIndexed(idx, p.x, p.z, enemy.x, enemy.z);
    // 近さを最優先(即応なので遠くまで走らない)。射線が通るなら加点
    const score = p.cover * 2 - Math.sqrt(travel2) * 0.6 + (los ? 1.2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return best;
}

/**
 * 選抜射手の**射撃位置(overwatch)**(`[v6.4]`)。
 *
 * ATP 3-21.8 / TC 3-22.9: SDM は分隊長が運用する分隊の資産で、観測と長射程の
 * 射界が取れる位置に就いて支援する。突撃線に混ざって前へ出る要員ではない。
 *
 * `bestNearbyCover` との違いは距離の扱い。あちらは交戦距離帯(≒60m)に収めようと
 * するが、こちらは**遠いほうが良い**として、射線の通る限り離れた遮蔽を選ぶ。
 * 4回目のテストプレイ指摘「マークスマンはちゃんと射界のとおる有利な場所に
 * 陣取ってる?」への答えで、計測では選抜射手が分隊の重心より前に出ている時間が
 * 4割あった(=長射程の利を捨てて突撃線にいた)。
 */
export function bestOverwatchPoint(
  idx: WallIndex,
  cover: CoverIndex,
  from: Vec2,
  enemy: Vec2,
  /** この距離より近い位置は選ばない m(近づきすぎない) */
  minRange: number,
  /** 有効射程 m。これを超える位置からは撃てない */
  maxRange: number,
  maxMove: number,
  minCover: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;

  forEachCoverNear(cover, from, maxMove, (p) => {
    if (p.cover < minCover) return;
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const travel2 = dx * dx + dz * dz;
    if (travel2 > maxMove * maxMove) return;
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < minRange || dToEnemy > maxRange) return;
    // 射線は必須。射界の通らない「良い遮蔽」は選抜射手には無価値
    if (!hasLineOfSightIndexed(idx, p.x, p.z, enemy.x, enemy.z)) return;

    // 遮蔽と「遠さ」を評価する。移動距離は軽い減点に留め、良い射点なら動く
    const score = p.cover * 2 + dToEnemy * 0.03 - Math.sqrt(travel2) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return best;
}

/**
 * 最良の側面攻撃位置: bestCoverPoint と同様だが、敵から見たときのベース・オブ・
 * ファイア組との角度差を加点する — 機動組は別の軸から攻撃すべきであるため。
 */
export function bestFlankPoint(
  cover: CoverIndex,
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

  forEachCoverNear(cover, from, MAX_FLANK_TRAVEL, (p) => {
    const travel = Math.hypot(p.x - from.x, p.z - from.z);
    if (travel > MAX_FLANK_TRAVEL) return;
    const dToEnemy = Math.hypot(p.x - enemy.x, p.z - enemy.z);
    if (dToEnemy < engageMin || dToEnemy > engageMax) return;

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
  });
  return best;
}
