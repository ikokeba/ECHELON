/**
 * 窓に就いている兵士の判定(`[v6.10]` 仕様 §7/§8)。
 *
 * 窓は「視線は通すが人は通さない開口」で、幾何としては `cqb.ts` が壁に空けている。
 * ここが決めるのは**誰がその開口に就いているか**だけで、位置から導かれる状態であって
 * 兵士が取る「構え」ではない(仕様 §3 が姿勢変更を持たないのと同じ考え方)。
 *
 * 就いていると、遮蔽越しに撃つ側の非対称を受ける(仕様 §8):
 * 被命中 −60% / 自身の命中 +30%。どちらも命中判定への係数で、新しい機構ではない。
 *
 * ティック順序は**戦闘の前**。その同じティックの射撃判定が、いまの位置に基づいた
 * 窓の状態を見るようにするため。
 */

import { DEFENSE, WINDOW } from "../constants.ts";
import { insideBounds } from "../cqb.ts";
import { isOffField } from "./litter.ts";
import { hasLineOfSightIndexed } from "../wallIndex.ts";
import { atFightingPosition } from "../c2/defense.ts";
import type { Building, Soldier, Vec2, WindowPort } from "../types.ts";
import type { World } from "../world.ts";

const POST_R2 = WINDOW.POST_RADIUS * WINDOW.POST_RADIUS;

/** その地点を含む建物。屋外なら null。 */
function buildingContaining(buildings: readonly Building[], p: Vec2): Building | null {
  for (const b of buildings) if (insideBounds(b.bounds, p)) return b;
  return null;
}

/**
 * その兵士が就いている窓。就いていなければ null。
 * **建物の中にいることが条件** — 外から窓に張り付いても銃眼の側にはなれない。
 */
export function windowPostOf(world: World, s: Soldier): WindowPort | null {
  if (s.status !== "ok" || isOffField(s)) return null;
  const b = buildingContaining(world.buildings, s.pos);
  if (!b) return null;
  for (const w of b.windows) {
    const dx = s.pos.x - w.pos.x;
    const dz = s.pos.z - w.pos.z;
    if (dx * dx + dz * dz <= POST_R2) return w;
  }
  return null;
}

/** 窓に就く立ち位置(開口のすぐ内側)。 */
export function windowPost(w: WindowPort): Vec2 {
  return {
    x: w.pos.x - w.normal.x * WINDOW.POST_INSET,
    z: w.pos.z - w.normal.z * WINDOW.POST_INSET,
  };
}

/**
 * 全兵士の `atWindow` を更新する。`step.ts` から戦闘の前に呼ばれる。
 *
 * 建物の外にいる兵士のほうが圧倒的に多いので、まず外周の矩形で弾く。
 * 中隊マップ(建物78棟・窓814個・兵士224名)でも実測で描画より軽い。
 */
export function windowsSystem(world: World): void {
  for (const s of world.soldiers) {
    s.atWindow = windowPostOf(world, s) !== null;
    // `[v7.2]` 射撃壕・土嚢(S-1)は屋外の窓。就いていれば同じ補正を受ける(新しい倍率は作らない)
    if (
      !s.atWindow &&
      world.defense.length > 0 &&
      s.status === "ok" &&
      !isOffField(s) &&
      atFightingPosition(world, s.pos, WINDOW.POST_RADIUS)
    ) {
      s.atWindow = true;
    }
  }
}

/**
 * その兵士が就ける窓の持ち場(`[v6.10]` 仕様 §7)。
 *
 * **判定は「その敵へ射線が通るか」ではなく「その窓に射界があるか」。** 最初は前者で
 * 書いたが、建物78棟の市街地では特定の敵へ射線の通る窓が 3.1% しかなく、機能が
 * ほぼ発火しなかった。守兵が窓に就くのは、いま見えている敵がいるからではなく
 * **接近路を扼するため**なので、後者が正しい条件。
 *
 * 条件:
 *   - 脅威の方角が与えられていれば、外向きの法線がその側を向いていること
 *   - 窓の外へ `FIELD_OF_FIRE_PROBE` ぶん射線が抜けること(壁に面した窓は使わない)
 *   - まだ他の隊員が就いていないこと(1つの窓に2人は入らない)
 *
 * 走査は `b.windows` の順で、同点は先に出た方。順序は生成時に決まっていて乱数を
 * 引かないので、鏡像の状況では鏡像の窓が選ばれる(仕様 §2/§13)。
 */
export function bestWindowPost(
  world: World,
  u: Soldier,
  /** 脅威の方角。null なら向きを問わず、射界のある窓ならどれでもよい */
  threat: Vec2 | null,
  /** すでに他の隊員が就いた持ち場。同じ窓へ2人を送らないために渡す */
  taken: readonly Vec2[] = [],
): Vec2 | null {
  const b = buildingContaining(world.buildings, u.pos);
  if (!b) return bestFightingPost(world, u, threat, taken);
  if (b.windows.length === 0) return null;

  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const w of b.windows) {
    if (threat) {
      // 脅威が窓の外側にあるか(法線と同じ側か)。背中側の窓は扼せない
      const ex = threat.x - w.pos.x;
      const ez = threat.z - w.pos.z;
      if (ex * w.normal.x + ez * w.normal.z <= 0) continue;
    }
    const post = windowPost(w);
    if (taken.some((t) => Math.hypot(t.x - post.x, t.z - post.z) < WINDOW.POST_RADIUS)) continue;

    const d = Math.hypot(post.x - u.pos.x, post.z - u.pos.z);
    if (d >= bestD) continue;
    // 射界があるか。開口の中心から外へ伸ばして、途中で遮られないこと
    const outX = w.pos.x + w.normal.x * WINDOW.FIELD_OF_FIRE_PROBE;
    const outZ = w.pos.z + w.normal.z * WINDOW.FIELD_OF_FIRE_PROBE;
    if (!hasLineOfSightIndexed(world.wallIndex, w.pos.x, w.pos.z, outX, outZ)) continue;
    bestD = d;
    best = post;
  }
  return best;
}

/**
 * 屋外にいる兵が就ける射撃壕(`[v7.2]` S-1)。自陣営の壕だけ — 自分で掘った陣地の位置しか
 * 知らない(攻撃側は敵の壕の場所を知らない、ロードマップ P1)。条件は窓と同じ:
 * 脅威が壕の正面側にあること・まだ誰も就いていないこと。近い順。
 */
function bestFightingPost(
  world: World,
  u: Soldier,
  threat: Vec2 | null,
  taken: readonly Vec2[],
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const p of world.defense) {
    if (p.kind !== "fighting" || p.side !== u.side) continue;
    const d = Math.hypot(p.pos.x - u.pos.x, p.pos.z - u.pos.z);
    if (d > DEFENSE.FIGHTING_SEEK || d >= bestD) continue;
    if (threat) {
      const ex = threat.x - p.pos.x;
      const ez = threat.z - p.pos.z;
      if (ex * p.facing.x + ez * p.facing.z <= 0) continue;
    }
    if (taken.some((t) => Math.hypot(t.x - p.pos.x, t.z - p.pos.z) < WINDOW.POST_RADIUS)) continue;
    bestD = d;
    best = { ...p.pos };
  }
  return best;
}

/**
 * 建物を窓から守る配置(`[v6.10]` 仕様 §7)。
 *
 * 各隊員へ、**別々の窓**の持ち場を割り当てて返す。割り当てられなかった隊員は
 * 結果に含まれない(呼び出し側が従来の隊形へ落とす)。
 * これが「防衛時に窓を積極的に使う」の実体で、新しいFTモードは増やさない —
 * 建物の中で持ち場を配るときの配り方が変わるだけ。
 */
export function manWindows(
  world: World,
  members: readonly Soldier[],
  threat: Vec2 | null,
): Map<number, Vec2> {
  const out = new Map<number, Vec2>();
  const taken: Vec2[] = [];
  for (const u of members) {
    const p = bestWindowPost(world, u, threat, taken);
    if (!p) continue;
    taken.push(p);
    out.set(u.id, p);
  }
  return out;
}
