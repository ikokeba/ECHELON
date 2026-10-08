/**
 * 個体差パラメータ(仕様 §14 `[v6.2]`)。
 *
 * 仕様は「同一状況でも判断・実行の質にばらつきが出る」ことを要求している。
 * `Soldier.traits`(積極性 / 大胆さ / 慎重さ、各 0..1)は `[v6]` から存在していたが、
 * どのAIも読んでおらず**完全に不活性**だった。`[v6.2]` でここを配線する。
 *
 * **割り当ては乱数ではなく編成上の位置から決める。**
 * 理由は戦力対称性(仕様 §2/§13)。中隊マップは点対称なので、鏡像の位置に立つ兵士どうしは
 * 同じ性格でなければ地形由来ではない有利不利が生まれる。両陣営は同じ順序で同じ編成を
 * 組み立てるので、「自軍の中で何番目に作られた兵士か」を種にすれば、鏡像の2人は必ず
 * 同じ値を引く。乱数ストリームを使うと編成順のわずかな違いで崩れうるため、決め打ちにする。
 *
 * 陣営ラベルは一切見ない。したがって `test/symmetry.test.ts` のラベル入替(位置は不動)は
 * 影響を受けない — 入れ替わった側は、元の側とまったく同じ性格の兵士を引き継ぐ。
 */

import type { Soldier, SoldierTraits } from "./types.ts";

/** 中央値 0.5 からの振れ幅。大きくすると個体差が強くなる。`[v6.2]` */
const SPREAD = 0.28;

/**
 * 4通りの性格プロファイル。各特性で `+SPREAD` と `-SPREAD` が同数になるよう組んであり、
 * 母集団の平均が 0.5 付近に留まる = 定数で決めた既定の挙動から全体としてはずれない。
 * ずれるのは「個体」であって「部隊の平均」ではない、という §14 の意図に合わせる。
 */
const PROFILES: ReadonlyArray<readonly [number, number, number]> = [
  [+1, +1, -1], // 前がかりで大胆、詰めが甘い
  [-1, -1, +1], // 慎重で堅実
  [+1, -1, +1], // 攻めるが無理はしない
  [-1, +1, -1], // 引き気味だが踏み込むときは踏み込む
];

/**
 * 編成上の通し番号から性格を決める。`n` は**自軍の中での通し番号**で、
 * 両陣営で同じ値が同じ位置の兵士に振られること(=鏡像で一致すること)が要件。
 */
export function traitProfile(n: number): SoldierTraits {
  const p = PROFILES[((n % PROFILES.length) + PROFILES.length) % PROFILES.length]!;
  return {
    aggressiveness: 0.5 + p[0] * SPREAD,
    boldness: 0.5 + p[1] * SPREAD,
    caution: 0.5 + p[2] * SPREAD,
  };
}

/**
 * ファイアチーム単位の性格 = 隊員の平均。
 * FT全体で1つ決まる事柄(躍進の歩幅、突撃へ移る間合い)に使う。
 * 空なら既定値 0.5 を返す — 隊が消滅していても呼び出し側が分岐せずに済むように。
 */
export function meanTraits(members: readonly Soldier[]): SoldierTraits {
  if (members.length === 0) return { aggressiveness: 0.5, boldness: 0.5, caution: 0.5 };
  let a = 0;
  let b = 0;
  let c = 0;
  for (const m of members) {
    a += m.traits.aggressiveness;
    b += m.traits.boldness;
    c += m.traits.caution;
  }
  const n = members.length;
  return { aggressiveness: a / n, boldness: b / n, caution: c / n };
}

/**
 * 0..1 の特性値を倍率へ写す。`t = 0.5` で必ず 1.0 を返す —
 * これにより「個体差を入れても既定の部隊は従来どおり」が保証され、
 * 仕様の確定値(constants.ts)の意味が変わらない。
 *
 * @param span 0または1の端で 1 からどれだけ離れるか(0.6 なら 0.7〜1.3 倍)
 */
export function traitMul(t: number, span: number): number {
  return 1 + (t - 0.5) * 2 * span;
}
