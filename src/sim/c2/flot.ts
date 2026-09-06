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
 * ── 2本の値を持つ理由 ──
 *
 * 用途によって「前線」の定義が違う。同じ報告から両方を導いて1つの型に載せる。
 *
 *   `forward` 部隊の指向に使う線。FM 3-90 の FLOT は掩護部隊(covering force)を
 *             含まないので、**前から2番目**の部下重心を採る。1個分隊が突出した
 *             だけで線が前へ飛ぶと、残り全部が「下がっている」ことになる。
 *   `lead`    火力の統制(FSCM)に使う線。こちらは**最も前に出ている先頭**で測る。
 *             味方を撃たないための線を平均で引いてはいけない。
 *
 * ── 座標系 ──
 *
 * 値はその陣営の**前進フレームでの前方距離**。世界座標のzで持つと、点対称の盤面で
 * 両陣営の「前」が逆になり、比較がそのまま反転しない(仕様 §2/§13)。
 */

import { SIM_HZ } from "../constants.ts";
import type { Flot, SubordinateReport, Vec2 } from "../types.ts";

/** この秒数より古い報告は前線の根拠にしない。持ち場を失った部隊の位置を引きずらないため */
const REPORT_STALE_SEC = 45;

/** 前線が未知であることを表す値。 */
export const NO_FLOT: Flot = { forward: -Infinity, lead: -Infinity, asOfTick: 0, sources: 0 };

/** 前進フレームでの前方成分。 */
export function forwardOf(advanceDir: Vec2, p: Vec2): number {
  const d = Math.hypot(advanceDir.x, advanceDir.z) || 1;
  return (p.x * advanceDir.x + p.z * advanceDir.z) / d;
}

/**
 * 部下の報告から前線を引く。報告が無ければ `sources: 0` を返す(前線は未知)。
 *
 * 走査順に依存しない(最大・2番目を取るだけ)ので、鏡像の部隊は鏡像の値を得る。
 */
export function flotFrom(
  reports: Iterable<SubordinateReport>,
  advanceDir: Vec2,
  nowTick: number,
): Flot {
  const fresh: SubordinateReport[] = [];
  for (const r of reports) {
    if (r.effective === 0) continue; // 全滅した部隊は線を作らない
    if ((nowTick - r.sentTick) / SIM_HZ > REPORT_STALE_SEC) continue;
    fresh.push(r);
  }
  if (fresh.length === 0) return { ...NO_FLOT, asOfTick: nowTick };

  const body = fresh.map((r) => forwardOf(advanceDir, r.pos)).sort((a, b) => b - a);
  // 掩護部隊を線から外す = 突出した1つを飛ばす(部下が2つ以上あるとき)
  const forward = body.length >= 2 ? body[1]! : body[0]!;
  const lead = Math.max(...fresh.map((r) => forwardOf(advanceDir, r.posLead)));
  const asOfTick = Math.min(...fresh.map((r) => r.sentTick));
  return { forward, lead, asOfTick, sources: fresh.length };
}
