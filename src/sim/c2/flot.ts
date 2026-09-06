/**
 * 前線 — FLOT(`[v6.16]` 仕様 §5/§6/§11)。
 *
 * 米陸軍の **FLOT**(Forward Line of Own Troops、ADP 1-02 / FM 3-90):
 * 「ある時点における友軍の最前方位置を示す線」。指揮官はこれを刻々と引き直し、
 * 火力の統制と麾下部隊の指向をその線を基準に行う。関連する統制手段
 * (phase line、limit of advance、boundaries)は別の graphic であり、ここでは扱わない。
 *
 * ── なぜ報告からしか引かないのか ──
 *
 * **前線は指揮官が「知っている」ものであって、盤面の事実ではない。** 小隊長は麾下
 * 分隊からの無線報告で、中隊長はさらにその上の報告で部下の位置を知る(仕様 §5)。
 * したがって FLOT は無線1〜2ホップぶん古く、上位ほど遅れる。これは欠陥ではなく
 * 実際の指揮でまさに起きること — 中隊長の頭の中の前線は、いつも少し過去のもの。
 * `world.soldiers` から直に引くと §5 が最初の1手で崩れる。
 *
 * ── なぜ直線ではなく折れ線なのか(`[v6.17]` で作り直した)──
 *
 * 最初の実装は前線を**スカラー1個**(前進フレームでの前方距離)で持っていた。
 * これは2つの意味で間違っていた:
 *
 *   1. **前進フレームが立案時に固定される。** `advanceDir` は `beginPlanning` で
 *      一度決まったきり更新されないので、線は戦況がどう動いても盤面に対して同じ
 *      向きの直線のままだった(指摘:「初期配置を前提とした x軸方向のみの設定」)
 *   2. **そもそも前線は直線ではない。** 実際の作戦図の FLOT は、部隊から部隊へ
 *      たどった不揃いな折れ線で、突出した部隊のところで前へ膨らみ、遅れている
 *      ところで後ろへ引っ込む。その凹凸こそが指揮官の読む情報
 *
 * いまは**部下の報告位置を結んだ折れ線**として持つ。形は報告そのものから決まるので、
 * 前進フレームは「どの順で結ぶか」(自陣営から見た左から右)にしか使わない。
 * 部隊が展開すれば線は広がり、1個が突出すれば salient ができる。
 *
 * FM 3-90 の「FLOT は掩護部隊を含まない」は**スカラー要約に対する規則**であって、
 * 折れ線には持ち込まない — 3個小隊のうち最前の1個を線から落とすと線が消える。
 * 突出は smoothing せずそのまま salient として見せるほうが、図として正しい。
 *
 * ── 座標系 ──
 *
 * 折れ線の頂点は世界座標。並び順だけをその陣営の**前進フレーム**で決めるので、
 * 点対称の盤面では鏡像の部隊が鏡像の順に並ぶ(仕様 §2/§13)。
 */

import { SIM_HZ } from "../constants.ts";
import type { Flot, FlotNode, SubordinateReport, Vec2 } from "../types.ts";

/** この秒数より古い報告は前線の根拠にしない。持ち場を失った部隊の位置を引きずらないため */
const REPORT_STALE_SEC = 45;

/** 前線が未知であることを表す値。 */
export const NO_FLOT: Flot = { trace: [], asOfTick: 0, sources: 0 };

/** 前進フレームでの前方成分。 */
export function forwardOf(advanceDir: Vec2, p: Vec2): number {
  const d = Math.hypot(advanceDir.x, advanceDir.z) || 1;
  return (p.x * advanceDir.x + p.z * advanceDir.z) / d;
}

/** 前進フレームでの横位置(自陣営から見て左が負)。折れ線を結ぶ順を決めるのに使う。 */
function lateralOf(advanceDir: Vec2, p: Vec2): number {
  const d = Math.hypot(advanceDir.x, advanceDir.z) || 1;
  // 前進方向を +z 側とみなしたときの右手方向 = (-fz, fx)
  return (p.x * -advanceDir.z + p.z * advanceDir.x) / d;
}

/**
 * 部下の報告から前線を引く。報告が無ければ `sources: 0` を返す(前線は未知)。
 *
 * 頂点は各部下の**先頭位置**。重心ではなく先頭を採るのは、前線とは「最も前に出て
 * いる位置を結んだ線」だから(ADP 1-02)。並び順は自陣営フレームの横位置で、
 * 同値なら編成上の通し番号 — どちらも鏡像で一致するので、点対称の状況では
 * 鏡像の折れ線ができる(仕様 §2/§13)。
 */
export function flotFrom(
  reports: Iterable<SubordinateReport>,
  advanceDir: Vec2,
  nowTick: number,
): Flot {
  const nodes: FlotNode[] = [];
  for (const r of reports) {
    if (r.effective === 0) continue; // 全滅した部隊は線を作らない
    if ((nowTick - r.sentTick) / SIM_HZ > REPORT_STALE_SEC) continue;
    nodes.push({
      unitId: r.unitId,
      pos: { ...r.posLead },
      body: { ...r.pos },
      sentTick: r.sentTick,
    });
  }
  if (nodes.length === 0) return { trace: [], asOfTick: nowTick, sources: 0 };

  nodes.sort((a, b) => {
    const d = lateralOf(advanceDir, a.pos) - lateralOf(advanceDir, b.pos);
    return Math.abs(d) > 1e-9 ? d : a.unitId - b.unitId;
  });
  return {
    trace: nodes,
    asOfTick: Math.min(...nodes.map((n) => n.sentTick)),
    sources: nodes.length,
  };
}

/** 線分 ab に対する点 p の距離。 */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len2 = vx * vx + vz * vz;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

/**
 * 部隊のいる範囲からの距離(`[v6.17]`)。前線が未知なら `Infinity`。
 *
 * 2つの要点がある。
 *
 * **① 半平面ではなく折れ線からの距離で測る。** 前進フレームの前方成分だけで見る
 * 判定にすると、側面へ張り出した部隊の頭上が抜ける — 「前線より前」でありさえ
 * すれば、真横に自軍がいても撃ててしまう。
 *
 * **② 先頭の線だけでは足りない。部隊は縦深を持つ。** 中隊の前線は3個小隊ぶん、
 * つまり頂点3つの折れ線でしかない。先頭を結んだ線だけで測ると、その後ろに広がって
 * いる本隊が判定から抜ける(実測: 塹壕の盤面で、要請時点の危険近接内に自軍39名・
 * 最接近8m)。**先頭の線と重心の線の両方**から測る。
 */
export function distToFlot(flot: Flot, p: Vec2): number {
  const t = flot.trace;
  if (t.length === 0) return Infinity;
  let best = Infinity;
  for (const n of t) {
    best = Math.min(
      best,
      Math.hypot(p.x - n.pos.x, p.z - n.pos.z),
      Math.hypot(p.x - n.body.x, p.z - n.body.z),
      // 部隊そのものの縦深(先頭から重心まで)
      distToSegment(p, n.pos, n.body),
    );
  }
  for (let i = 0; i + 1 < t.length; i++) {
    best = Math.min(
      best,
      distToSegment(p, t[i]!.pos, t[i + 1]!.pos),
      distToSegment(p, t[i]!.body, t[i + 1]!.body),
    );
  }
  return best;
}
