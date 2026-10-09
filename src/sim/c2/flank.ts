/**
 * 側面攻撃の幾何(`[v7.0]` 仕様 §6 Fire and Movement / ATP 3-21.8 Battle Drill 1)。
 *
 * 分隊長(FTを動かす)と小隊長(分隊を動かす)が同じ部品を使う。ここにあるのは
 * 「どちら側へ回るか」「次にどこへ行くか」「どこまで回れたか」の3つだけで、
 * 誰をベースにするか・いつ突撃するかの判断は各階層のAIが持つ。
 *
 * ── 見てよいもの(仕様 §5)──
 * 脅威の位置は**その指揮官の belief から渡されたもの**だけ。`world.soldiers` から
 * 敵を覗かない。地形(遮蔽点・壁・盤の境界)と自軍の位置は自由に見てよい。
 *
 * ── 対称性(仕様 §2/§13)──
 * 陣営は一切読まない。回り込む向きは世界座標の左右ではなく「ベース→敵の軸から
 * 見た左右」(符号 dir)で表すので、盤面を回しても同じ判断になる。
 */

import { FLANK } from "../constants.ts";
import { forEachCoverNear, type CoverIndex } from "../cover.ts";
import { collidesWallIndexed, type WallIndex } from "../wallIndex.ts";
import type { Bounds, Contact, Vec2 } from "../types.ts";

const DEG = Math.PI / 180;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 敵から見た方位角(0 = +Z)。 */
function bearingFrom(center: Vec2, p: Vec2): number {
  return Math.atan2(p.x - center.x, p.z - center.z);
}

/** 角度を (−π, π] へ畳む。 */
function wrap(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

function onArc(center: Vec2, angle: number, radius: number): Vec2 {
  return { x: center.x + Math.sin(angle) * radius, z: center.z + Math.cos(angle) * radius };
}

/**
 * 敵から見た、ベースと機動要素のなす角 °(0〜180)。側面を取れているかの尺度。
 * 90° なら敵は正面と側面の両方から撃たれる(L字の十字砲火)。
 */
export function flankSeparationDeg(threat: Vec2, base: Vec2, maneuver: Vec2): number {
  const d = Math.abs(wrap(bearingFrom(threat, maneuver) - bearingFrom(threat, base)));
  return d / DEG;
}

/** 弧の半径。いまの距離を範囲に収める(近すぎる弧は敵の目の前を回ることになる)。 */
export function flankRadius(threat: Vec2, from: Vec2, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, dist(threat, from)));
}

/**
 * 次の経由点。機動要素がいま弧の上のどこにいるかを測り、`dir` 側へ `STEP_DEG` だけ
 * 先、ただし目標角(ベースから90°)を超えない点を返す。
 *
 * 逆側にいる(=ベースの反対へ回り始めている)場合は進捗0から数え直す。決めた側を
 * 守らせるため — 毎回近い側へ回らせると、軸をまたぐたびに向きが反転する。
 */
export function flankWaypoint(
  threat: Vec2,
  base: Vec2,
  maneuver: Vec2,
  dir: 1 | -1,
  radius: number,
): Vec2 {
  const baseAngle = bearingFrom(threat, base);
  const progress = Math.max(0, wrap(bearingFrom(threat, maneuver) - baseAngle) * dir);
  const nextDeg = Math.min(FLANK.TARGET_DEG, progress / DEG + FLANK.STEP_DEG);
  return onArc(threat, baseAngle + dir * nextDeg * DEG, radius);
}

/** 経由点を、弧の接線と直交する向き(=敵から外向き)を基準に横へずらす。FTを並べるのに使う。 */
export function spreadAlongArc(threat: Vec2, point: Vec2, offset: number): Vec2 {
  const a = bearingFrom(threat, point) + Math.PI / 2;
  return { x: point.x + Math.sin(a) * offset, z: point.z + Math.cos(a) * offset };
}

export interface FlankSideInput {
  threat: Vec2;
  base: Vec2;
  maneuver: Vec2;
  /** 任務目標。同じくらい良いなら目標に近い側へ回る(回り込みが前進にもなる) */
  objective: Vec2;
  /** 指揮官が把握している他の接触。そちらへ回り込むと別の敵の正面に出る */
  contacts: Iterable<Contact>;
  radius: number;
  cover: CoverIndex;
  wallIndex: WallIndex;
  bounds: Bounds;
  /**
   * 回り込みの中心を側ごとに差し替える(`[v7.0]` 小隊は敵戦列の端を回る)。
   * 省略時は両側とも `threat`。
   */
  centerOf?: (dir: 1 | -1) => Vec2;
}

/**
 * 回り込む側を決める。左右それぞれの「90°の位置」を評価して良いほうを採る。
 *
 * 評価(すべて地形と自軍・既知の接触だけから決まる):
 *   + そこに遮蔽が多い(回り込んだ先で身を隠せる)
 *   + 目標に近い(回り込みがそのまま前進になる)
 *   − 機動要素から遠い(回り込みに時間がかかるほど露出する)
 *   − 他の既知の接触の近く(別の敵の正面へ出ることになる)
 *   − 盤外・壁の中(行けない)
 */
export function chooseFlankSide(input: FlankSideInput): 1 | -1 {
  const { threat, base, maneuver, objective, radius } = input;
  const baseAngle = bearingFrom(threat, base);
  const all = [...input.contacts];
  const scoreOf = (dir: 1 | -1): number => {
    const center = input.centerOf?.(dir) ?? threat;
    const others = all.filter((c) => c.confidence > 0 && !c.heard && dist(c.pos, center) > 4);
    const p = onArc(center, bearingFrom(center, base) + dir * FLANK.TARGET_DEG * DEG, radius);
    const b = input.bounds;
    if (p.x < b.minX + 2 || p.x > b.maxX - 2 || p.z < b.minZ + 2 || p.z > b.maxZ - 2) {
      return -1e6;
    }
    let s = 0;
    if (collidesWallIndexed(input.wallIndex, p.x, p.z, 0.6)) s -= 4;
    let cover = 0;
    forEachCoverNear(input.cover, p, FLANK.COVER_RADIUS, (c) => {
      if (dist(c, p) <= FLANK.COVER_RADIUS) cover += c.cover;
    });
    s += Math.min(cover, 12) * 0.35;
    s -= dist(maneuver, p) * 0.04;
    s += (dist(objective, threat) - dist(objective, p)) * 0.03;
    for (const c of others) {
      const d = dist(c.pos, p);
      if (d < 30) s -= (30 - d) * 0.15 * c.confidence;
    }
    return s;
  };
  const left = scoreOf(1);
  const right = scoreOf(-1);
  if (Math.abs(left - right) > 1e-9) return left > right ? 1 : -1;
  // 同点なら機動要素がいま居る側(回り始めやすい側)
  return wrap(bearingFrom(threat, maneuver) - baseAngle) >= 0 ? 1 : -1;
}

/**
 * 敵戦列の**端**(`[v7.0]`)。小隊が回り込むべきは主目標の1点ではなく、横に広がった
 * 敵の列の端である — 列の途中へ回ると、隣の敵分隊の正面へ出るだけになる
 * (計測: 小隊の機動分隊が敵の隣接分隊に撃たれて後退を繰り返し、角度差が40°台で頭打ち)。
 *
 * ベース→主脅威の軸に直交する向きへ、`dir` 側に最も張り出している接触を返す。
 * 主脅威から `reach` m 以上離れた接触は別の集団とみなして無視する。
 */
export function enemyFlankAnchor(
  threat: Vec2,
  base: Vec2,
  dir: 1 | -1,
  contacts: Iterable<Contact>,
  reach: number,
): Vec2 {
  const ax = threat.x - base.x;
  const az = threat.z - base.z;
  const len = Math.hypot(ax, az) || 1;
  // 敵から見てベースの方位角が増える向き(=dir +1 の回り込み側)へ張り出すほど大きい
  const sideX = (-az / len) * dir;
  const sideZ = (ax / len) * dir;
  let best = threat;
  let bestOff = 0;
  for (const c of contacts) {
    if (c.confidence <= 0 || c.heard || dist(c.pos, threat) > reach) continue;
    const off = (c.pos.x - threat.x) * sideX + (c.pos.z - threat.z) * sideZ;
    if (off > bestOff + 1e-9) {
      bestOff = off;
      best = c.pos;
    }
  }
  return best;
}
