/**
 * 確保済み拠点の保持(仕様 §12 / `[v6.1]`)。
 *
 * 従来のC2は接敵すると任務目標を脅威位置へ丸ごと差し替えていた
 * (`const aim = threat ? threat.pos : objective`)。このため一度確保した拠点でも、
 * 別方面で接敵した瞬間に守備隊ごと脅威へ前進し、拠点を放棄していた(初回テストプレイ指摘)。
 *
 * ここで保証するのは最小限:「担当区域の近くに自軍所有(または中立で自軍が確保進行中)の
 * 拠点があるなら、その区域を担う下位ユニットの持ち場を拠点の内側へ引き戻す」。
 * 任務種別(seize / screen / support-by-fire、§3①)はその後 `[v6.1]` で入ったが、保持はそれとは
 * 別の仕組みのまま。保持を任務種別の1つとして扱う統合は未着手(docs/ロードマップ.md C-28)。
 *
 * side分岐は無い — 両陣営が同じ規則で自分の所有拠点を守る(仕様 §2/§13)。
 */

import type { Objective, Side, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/** この地点から近いところにある「守るべき自軍拠点」。無ければ null。 */
export function heldObjectiveNear(
  world: World,
  side: Side,
  at: Vec2,
  /** 拠点の外周からこの距離以内にいるユニットだけが守備に付く m */
  maxDist = 30,
): Objective | null {
  let best: Objective | null = null;
  let bestD = Infinity;
  for (const o of world.objectives) {
    // 相手所有の拠点は「守る」対象ではなく「奪う」対象なので除外する。
    if (o.owner !== null && o.owner !== side) continue;
    // 自軍所有、または中立で自軍が確保を進めている拠点だけを守備対象にする。
    const mine = o.owner === side || (o.owner === null && o.progressBy === side);
    if (!mine) continue;
    const d = Math.hypot(at.x - o.pos.x, at.z - o.pos.z);
    if (d > o.radius + maxDist) continue; // 遠くを行軍中の部隊まで足止めしない
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * 拠点ごとに「守備に付ける下位ユニットは**最寄りの1つだけ**」へ絞る。`[v6.2]`
 *
 * `heldObjectiveNear` は「近い守るべき拠点」を返すだけなので、複数のユニットの重心が
 * 同じ拠点の近くにあると**全員が同じ拠点へクランプされる**。拠点が広くて離れていた
 * うちは1つずつしか掛からず問題にならなかったが、拠点が建物内の1室になった途端、
 * 3個小隊すべてが中央拠点の1点へ吸い寄せられて戦線が消えた。
 *
 * 設計意図はもともと「最寄りの1ユニットが拠点に残り、残りは通常どおり
 * 脅威へ機動する」だったので、その意図どおりに絞る。
 *
 * @param entries 下位ユニットの識別子と重心
 * @returns 守備に付くユニットの識別子 → 守る拠点
 */
export function assignHolders<K>(
  world: World,
  side: Side,
  entries: ReadonlyArray<{ key: K; centroid: Vec2 }>,
): Map<K, Objective> {
  /** 拠点id → いま最寄りの候補 */
  const bestFor = new Map<number, { key: K; d: number; obj: Objective }>();
  for (const e of entries) {
    const o = heldObjectiveNear(world, side, e.centroid);
    if (!o) continue;
    const d = Math.hypot(e.centroid.x - o.pos.x, e.centroid.z - o.pos.z);
    const cur = bestFor.get(o.id);
    // 同距離は先に出た方を採る(entries の順は決定的なので結果も決定的)
    if (!cur || d < cur.d) bestFor.set(o.id, { key: e.key, d, obj: o });
  }
  const out = new Map<K, Objective>();
  for (const { key, obj } of bestFor.values()) out.set(key, obj);
  return out;
}

/**
 * `aim`(脅威方向へ寄った持ち場)を拠点中心から `radius * frac` 以内へ引き戻す。
 * 脅威を睨む向きは保ったまま、持ち場そのものは拠点の外へ出さない。
 *
 * `minLimit` は引き戻す先の下限 m。`[v6.2]` 拠点が建物内の1室(半径3m)まで小さくなり、
 * `radius * frac` だけだと**小隊36名を半径2mの点に集める**指示になってしまった。
 * 守備隊は拠点の上に立つのではなく拠点を囲んで守るので、隊の広がりぶんの床が要る。
 */
export function clampToObjective(aim: Vec2, o: Objective, frac = 0.5, minLimit = 0): Vec2 {
  const dx = aim.x - o.pos.x;
  const dz = aim.z - o.pos.z;
  const d = Math.hypot(dx, dz);
  const limit = Math.max(o.radius * frac, minLimit);
  if (d <= limit || d < 1e-6) return { x: o.pos.x + dx, z: o.pos.z + dz };
  return { x: o.pos.x + (dx / d) * limit, z: o.pos.z + (dz / d) * limit };
}

/**
 * その任務が**占領しに行く**拠点。`[v6.9]` F-9。
 *
 * `heldObjectiveNear` との違いは所有を問わないこと。あちらは「すでに自分のものを守る」
 * ためのもので、`owner === side || progressBy === side` を要求する。中立の拠点は
 * `progressBy` が null なので、**誰も守備に指名されないまま永遠に中立でいる**
 * — 守備に付くには進捗が要り、進捗を出すには守備に付く必要がある、というデッドロック
 * だった(実測: 進捗ゼロの状態では300秒・両陣営で守備割当 0秒)。
 *
 * 占領はその逆で、「まだ自分のものではないから行く」。任務目標が拠点の判定円を
 * 指しているならそれを返す。
 */
export function occupyObjectiveOf(world: World, missionTarget: Vec2): Objective | null {
  for (const o of world.objectives) {
    if (Math.hypot(missionTarget.x - o.pos.x, missionTarget.z - o.pos.z) <= o.radius) return o;
  }
  return null;
}

/** その地点が判定円の中に入っている拠点(距離ではなく**その拠点の半径**で判定する)。 */
export function objectiveCoveringPoint(world: World, p: Vec2): Objective | null {
  return occupyObjectiveOf(world, p);
}

/**
 * 拠点を**占領する**ための持ち場を n 個返す。`[v6.9]` F-9。
 *
 * F-9 の根因への対処。分隊は差し渡し20m前後の物体で、拠点は半径3mの円でしかない。
 * C2は「20mの隊形をどこに置くか」だけを指示し、仕様 §12 は「3mの円の中の人数」を
 * 数えていて、両者が一度も接続されていなかった(実測: 守備に付いた206秒のあいだ、
 * 重心が円内にあった時間 0秒 / 円内の人数 平均0.15名 / 分隊の広がり 平均21.6m)。
 *
 * したがって占領のときだけ**隊形を判定円の大きさへ畳む**。返す点はすべて円の内側で、
 * 間隔は半径に比例するので、拠点の大小によらず「中に立つ」が成立する。
 *
 * **畳むのは1個FTだけ。** 分隊ごと畳む案は実装して計測し、明確に悪化したので捨てた
 * (円内滞在 29→0秒、BLUE戦死 21→38名)。目標へ向かう隊形から戦列が消えると、
 * 伸びたところを各個に撃たれる — AD-53 と同じ結論。突撃組が中に入り、支援組は
 * 外で撃つ、という ATP 3-21.8 の分割はそのまま残すこと。
 */
export function occupySlots(o: Objective, dir: Vec2, n: number): Vec2[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: o.pos.x, z: o.pos.z }];
  // 円の内側 0.55 までに収める。縁ちょうどだと隊形の揺れで出入りしてしまう
  const r = o.radius * 0.55;
  const right = { x: -dir.z, z: dir.x };
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / ((n - 1) / 2);
    out.push({ x: o.pos.x + right.x * r * t, z: o.pos.z + right.z * r * t });
  }
  return out;
}

/**
 * 占領に付ける下位ユニットを、拠点ごとに**最寄りの1つだけ**へ絞る。`assignHolders` と
 * 同じ形で、対象が「守るべき拠点」ではなく「取りに行く拠点」である点だけが違う。
 *
 * 1つに絞るのが要点。全員を拠点へ吸い寄せると戦線が消える(`assignHolders` の
 * `[v6.2]` と同じ失敗)。占領は1個分隊、残りは戦列。
 */
export function assignOccupiers<K>(
  world: World,
  entries: ReadonlyArray<{ key: K; centroid: Vec2; target: Vec2 }>,
): Map<K, Objective> {
  const bestFor = new Map<number, { key: K; d: number; obj: Objective }>();
  for (const e of entries) {
    const o = occupyObjectiveOf(world, e.target);
    if (!o) continue;
    // **毎ティック最寄りで選び直す。** 一度預けた担当を持続させる案は実装して計測し、
    // 確保保持が 178→0秒 に落ちたので捨てた — 遠ざかった分隊が担当を離さないので、
    // 近くにいる分隊が入れず、拠点への注意が分散する。
    const d = Math.hypot(e.centroid.x - o.pos.x, e.centroid.z - o.pos.z);
    const cur = bestFor.get(o.id);
    // 同距離は先に出た方を採る(entries の順は決定的なので結果も決定的)
    if (!cur || d < cur.d) bestFor.set(o.id, { key: e.key, d, obj: o });
  }
  const out = new Map<K, Objective>();
  for (const { key, obj } of bestFor.values()) out.set(key, obj);
  return out;
}
