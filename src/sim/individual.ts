/**
 * 兵士個人の戦闘動作(`[v7.1]` constants `INDIVIDUAL`)。
 *
 * FTリーダーの命令(どこへ行くか)はそのままに、**歩きながら何を見るか**と
 * **どこまで敵に寄ってよいか**を兵士自身が決める。米陸軍の個人技能の3点:
 *
 *   1. 銃口は目と一緒に動く — 見えている敵がいれば、歩きながらでもそちらを向いて撃つ
 *      (TC 3-22.9 の移動射撃。命中の減点は従来どおり §14 の移動時ペナルティ)
 *   2. 撃たれたら撃ってきた方を向く(BD2 React to Contact の最初の動作)
 *   3. 担当の警戒方向を見ながら歩く(ATP 3-21.8 の全周警戒・sectors of observation)
 *
 * そして、**突撃以外では敵に `STANDOFF` より寄らない**。敵の脇を素通りしたり、
 * 目の前まで歩いていったりしないため。
 *
 * 見るのは自分の視界(`sees`)と自分が撃たれた事実だけ(仕様 §5)。
 */

import { INDIVIDUAL } from "./constants.ts";
import { buildingAt } from "./cqb.ts";
import type { Soldier, Vec2 } from "./types.ts";
import type { World } from "./world.ts";

/** 見えている敵のうち、狙うべき1人(FTリーダーの指定 → 最寄り)。いなければ null */
export function visibleThreat(world: World, s: Soldier): Soldier | null {
  if (s.sees.length === 0) return null;
  if (s.assignedTarget !== null && s.sees.includes(s.assignedTarget)) {
    const a = world.soldierById.get(s.assignedTarget);
    if (a && a.status === "ok") return a;
  }
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of s.sees) {
    const t = world.soldierById.get(id);
    if (!t || t.status !== "ok") continue;
    const d = (t.pos.x - s.pos.x) ** 2 + (t.pos.z - s.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function dirTo(from: Vec2, to: Vec2): Vec2 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? { x: dx / d, z: dz / d } : null;
}

/**
 * 移動中に向くべき方向。null なら従来どおり(進行方向)。
 * 優先: 見えている敵 > 撃ってきた方向 > 命令の警戒方向。
 * 担架を担いでいる・潰走している兵は前を見て走る(対象外)。
 */
export function combatLook(world: World, s: Soldier): Vec2 | null {
  if (s.bearing !== null || s.routed) return null;
  const t = visibleThreat(world, s);
  if (t) return dirTo(s.pos, t.pos);
  if (s.alertFrom && s.alertUntilTick > world.tick) return dirTo(s.pos, s.alertFrom);
  return s.order.facing ?? null;
}

/**
 * この1歩(from → to)が、突撃でもないのに見えている敵へ `STANDOFF` より寄る動きか。
 * true なら移動系はその歩を踏まない(その場で撃ち合う)。
 *
 * 対象外: 突撃中(寄るのが仕事)、後退・回避・潰走(離れる動き)、担架・手当て、
 * **屋内**(室内戦は距離を選べない。突入ドリル §7.3 が扱う)。
 */
export function standoffBlocks(world: World, s: Soldier, from: Vec2, to: Vec2): boolean {
  if (s.sees.length === 0) return false;
  if (s.assaultingUntilTick > world.tick) return false;
  const k = s.order.kind;
  if (k === "retreat" || k === "evade") return false;
  if (s.routed || s.bearing !== null || s.treating !== null) return false;
  const t = visibleThreat(world, s);
  if (!t) return false;
  const d0 = Math.hypot(t.pos.x - from.x, t.pos.z - from.z);
  if (d0 >= INDIVIDUAL.STANDOFF) return false;
  const d1 = Math.hypot(t.pos.x - to.x, t.pos.z - to.z);
  if (d1 >= d0) return false;
  if (buildingAt(world.buildings, from) || buildingAt(world.buildings, t.pos)) return false;
  return true;
}
