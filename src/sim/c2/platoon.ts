/**
 * 小隊長AI(仕様 §3 ②)。
 *
 * **この階層は生の視界を一切持たない。** 判断材料は麾下分隊長からの無線報告だけで、
 * それは遅延しており確度も減衰している(仕様 §5)。したがって小隊長は
 * 「やや古い地図」を見ながら数十名を捌くことになる — これが階層構造の遊びの核心。
 *
 * やること(仕様 §3 ②):
 *   - 3個分隊の配置決定(担当区域の割り当て)
 *   - 移動技術の指示(前進 / 警戒前進 / 躍進前進、仕様 §6)
 *   - 分隊間の相互支援の調整
 *
 * 戦力対称性(仕様 §2/§13): 両陣営で完全に同一のロジックが動く。
 */

import { SIM_HZ } from "../constants.ts";
import { aiSuppressed } from "../control.ts";
import type { Contact, MovementTechnique, PlatoonState, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/** 小隊長の意思決定周期。分隊長(0.3秒)より遅く、階層が上がるほど判断は粗く遅くなる。 */
const DECIDE_EVERY_TICKS = Math.round(2.0 * SIM_HZ);

/**
 * 移動技術の選択しきい値(仕様 §6)。
 * 小隊長が把握している「最も確度の高い接敵情報」までの距離で決める。
 * 仕様の脅威評価スコアをそのまま選択ロジックに使う、という §6 の方針に沿った実装。
 */
const TECHNIQUE_THRESHOLDS = {
  /** この距離より近い接敵情報があれば躍進前進(接敵が予想される) */
  boundingWithin: 45,
  /** この距離より近ければ警戒前進(接敵の可能性あり) */
  travelingOverwatchWithin: 90,
} as const;

/**
 * 分隊を横に展開させる間隔(m)。小隊長が3個分隊に担当区域を割り当てる際の幅。
 * 相互支援が届く範囲に収める必要があるため、視界距離(20m)の2倍程度に留める。
 */
const SQUAD_FRONTAGE = 26;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** belief の中で最も確度の高い接触。確度0のゴーストは判断に使わない。 */
function primaryThreat(belief: Map<string, Contact>): Contact | null {
  let best: Contact | null = null;
  for (const c of belief.values()) {
    if (c.confidence <= 0) continue; // ゴーストは索敵対象外(仕様 §5 `[v6]`)
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
}

function selectTechnique(pl: PlatoonState, from: Vec2): MovementTechnique {
  const threat = primaryThreat(pl.belief);
  if (!threat) return "traveling";
  const d = dist(from, threat.pos);
  if (d <= TECHNIQUE_THRESHOLDS.boundingWithin) return "bounding_overwatch";
  if (d <= TECHNIQUE_THRESHOLDS.travelingOverwatchWithin) return "traveling_overwatch";
  return "traveling";
}

export function platoonAI(world: World): void {
  for (const pl of world.platoons) {
    // 人間がこの小隊長を操作しているなら、AIの意思決定は行わない(仕様 §4)。
    // 配管(belief の更新・報告の送受信)はそのまま動き続ける — 人間は
    // 意思決定者を置き換えるだけで、情報の流れ方は変わらない。
    if (aiSuppressed(world, "platoon", pl.side, pl.platoonId)) continue;
    if (world.tick - pl.lastDecisionTick < DECIDE_EVERY_TICKS) continue;
    pl.lastDecisionTick = world.tick;

    const squads = world.squads.filter((s) => s.side === pl.side && s.platoonId === pl.platoonId);
    if (squads.length === 0) continue;

    // 小隊の現在位置は「報告された分隊重心の平均」で近似する。
    // 小隊長は麾下の正確な位置すら報告経由でしか知らない点に注意。
    const livingSquads = squads.filter((sq) =>
      world.soldiers.some(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
      ),
    );
    if (livingSquads.length === 0) continue;

    // 各分隊の重心を出し、その平均を小隊の位置とする(分隊ごとの人数差で重み付けしない
    // ことで、損耗した分隊に引きずられない)
    const anchor = { x: 0, z: 0 };
    for (const sq of livingSquads) {
      const members = world.soldiers.filter(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
      );
      let sx = 0;
      let sz = 0;
      for (const m of members) {
        sx += m.pos.x;
        sz += m.pos.z;
      }
      anchor.x += sx / members.length;
      anchor.z += sz / members.length;
    }
    anchor.x /= livingSquads.length;
    anchor.z /= livingSquads.length;

    const technique = selectTechnique(pl, anchor);
    const threat = primaryThreat(pl.belief);

    // 目標軸に対して直交する方向へ分隊を並べ、担当区域を割り当てる。
    // 接敵情報があればそちらへ、なければ小隊の任務目標へ向かう。
    const aim = threat ? threat.pos : pl.objective;
    const dx = aim.x - anchor.x;
    const dz = aim.z - anchor.z;
    const d = Math.hypot(dx, dz) || 1;
    const forward = { x: dx / d, z: dz / d };
    const right = { x: -forward.z, z: forward.x };

    livingSquads.forEach((sq, i) => {
      const lateral = (i - (livingSquads.length - 1) / 2) * SQUAD_FRONTAGE;
      const objective: Vec2 = {
        x: aim.x + right.x * lateral,
        z: aim.z + right.z * lateral,
      };
      pl.squadObjectives.set(sq.squadId, objective);
      pl.squadTechniques.set(sq.squadId, technique);

      // 人間が操作している分隊には再割り当てを行わない(仕様 §4)。
      //
      // この分隊の意思決定者は既に人間へ置き換わっている。AIの小隊長が2秒ごとに
      // 目標を上書きすると、プレイヤーの出した命令が握り潰され「操作できない操作」に
      // なってしまう。現実の分隊長も上級部隊の意図から逸脱しうる(仕様 §3⑤の
      // アンカー+リーシュが個人レベルで認めているのと同じ性質)。
      //
      // 将来の精緻化: 小隊長は「任務(WHAT)」を与え、人間の分隊長はその範囲内で
      // 自由に実行する、という二段構えにするのが本来の姿。現状は任務と目標地点が
      // 未分化なため、単純に再割り当てを止めている。
      if (aiSuppressed(world, "squad", sq.side, sq.squadId)) return;

      // 小隊長の命令を分隊長へ渡す。これが階層間の下向きの情報流。
      sq.objective = objective;
      sq.technique = technique;
    });
  }
}
