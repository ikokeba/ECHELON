/**
 * 盾持ちの幾何(`[v7.0]`)。命中率の倍率と、密集隊形の位置を出す純粋関数だけを置く。
 * 実際に盾をどう使うか(誰の前に立つか、どこへ押し出すか)は c2/fireteam.ts が決める。
 *
 * 対称性(仕様 §2/§13): 陣営は読まない。盾が効くかどうかは位置と向きだけで決まる。
 */

import { SHIELD } from "./constants.ts";
import type { Soldier, Vec2 } from "./types.ts";

const FRONT_COS = Math.cos((SHIELD.FRONT_ARC_DEG * Math.PI) / 180);

/** 盾を構えていられる状態か。負傷・搬送中・潰走中は盾を構えられない。 */
export function shieldUp(s: Soldier): boolean {
  return s.role === "shield" && s.status === "ok" && s.bearing === null && !s.routed;
}

/** 盾の正面が `from` の方を向いているか。 */
function facesToward(bearer: Soldier, from: Vec2): boolean {
  const dx = from.x - bearer.pos.x;
  const dz = from.z - bearer.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return true;
  return (bearer.facing.x * dx + bearer.facing.z * dz) / d >= FRONT_COS;
}

/**
 * `shooter` が `target` を撃つときの、盾による命中率倍率(1 = 盾が効いていない)。
 *
 * `shields` は target と同じ陣営で盾を構えている兵士(呼び出し側で絞り込んでおく)。
 *   - target 自身が盾持ちで、盾が射手の方を向いている → BEARER_ACC_MUL
 *   - 射手と target を結ぶ線の上、target の直前(SHADOW_DEPTH 以内)に盾持ちが立ち、
 *     その盾が射手の方を向いている → BEHIND_ACC_MUL
 * 両方に当たることはない(盾持ちは自分の盾の陰には入らない)。
 */
export function shieldAccMul(
  shooter: Soldier,
  target: Soldier,
  shields: readonly Soldier[],
): number {
  if (target.role === "shield") {
    return shieldUp(target) && facesToward(target, shooter.pos) ? SHIELD.BEARER_ACC_MUL : 1;
  }
  const sx = shooter.pos.x;
  const sz = shooter.pos.z;
  const dx = target.pos.x - sx;
  const dz = target.pos.z - sz;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return 1;
  const ux = dx / len;
  const uz = dz / len;
  for (const b of shields) {
    if (b.id === target.id || !shieldUp(b)) continue;
    const t = (b.pos.x - sx) * ux + (b.pos.z - sz) * uz;
    // 盾持ちが射手と目標の間にいて、目標の直前に立っていること
    if (t <= 0 || t >= len || len - t > SHIELD.SHADOW_DEPTH) continue;
    const perp = Math.abs((b.pos.x - sx) * uz - (b.pos.z - sz) * ux);
    if (perp > SHIELD.SHADOW_HALF_WIDTH) continue;
    if (!facesToward(b, shooter.pos)) continue;
    return SHIELD.BEHIND_ACC_MUL;
  }
  return 1;
}

/**
 * 盾の後ろに並ぶ密集隊形の位置。盾持ちの位置と、盾を向ける方向から決める。
 *
 * 2列目は盾の左右の肩(盾の陰に入りつつ脇から撃てる)、3列目は真後ろ、という順で
 * 埋める。盾の陰(`SHADOW_DEPTH`・`SHADOW_HALF_WIDTH`)に収まるよう間隔を取ってある。
 */
export function shieldStackSlots(bearer: Vec2, face: Vec2, n: number): Vec2[] {
  return shieldStackOffsets(n).map((o) => stackPoint(bearer, face, o.lat, o.back));
}

/** 密集隊形の相対位置(右が正の横ずれ lat、後ろが正の back)。i 番目の隊員の持ち場 */
export function shieldStackOffsets(n: number): Array<{ lat: number; back: number }> {
  const offsets: [number, number][] = [
    [-SHIELD.STACK_COL / 2, SHIELD.STACK_ROW],
    [SHIELD.STACK_COL / 2, SHIELD.STACK_ROW],
    [0, SHIELD.STACK_ROW * 2],
    [-SHIELD.STACK_COL / 2, SHIELD.STACK_ROW * 3],
    [SHIELD.STACK_COL / 2, SHIELD.STACK_ROW * 3],
  ];
  const out: Array<{ lat: number; back: number }> = [];
  for (let i = 0; i < n; i++) {
    const [lat, back] = offsets[Math.min(i, offsets.length - 1)]!;
    out.push({ lat, back });
  }
  return out;
}

/**
 * 盾持ちの位置と盾の向きから、相対位置 (lat, back) の地点を出す。
 * 右 = 向き (fx,fz) に対する (−fz, fx)。
 */
export function stackPoint(bearer: Vec2, face: Vec2, lat: number, back: number): Vec2 {
  const fl = Math.hypot(face.x, face.z) || 1;
  const fx = face.x / fl;
  const fz = face.z / fl;
  return { x: bearer.x - fz * lat - fx * back, z: bearer.z + fx * lat - fz * back };
}

/** 盾持ちの旋回の遅さ(`[v7.1]`)。それ以外の兵は 1 */
export function turnMulOf(s: Soldier): number {
  return s.role === "shield" ? SHIELD.TURN_RATE_MUL : 1;
}
