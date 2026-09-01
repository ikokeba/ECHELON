import { useSimStore, type PlanTaskView } from "./store.ts";

/**
 * L2 文脈スロット — 作戦立案フェーズ(`[v6.5]`、`[v6.6]` でレビュー反映)。
 *
 * 流れは「配置(G)→ 中隊長が立案 → 内容を確認 → 戦闘開始」。ここに出るのは
 * 作戦命令(OPORD)の第3項「機動の要領」に相当するもので、中隊長が拠点に対して
 * 主攻と助攻を決め、各小隊へ任務と接近経路を割り当てた結果(仕様 §3① / §11)。
 *
 * 中隊長は**敵の位置を一切見ずに**これを立てている(仕様 §5)。立案時点で
 * belief は空であり、地形と拠点と自軍の配置だけが材料になる。
 *
 * `[v6.6]` — UIレビュー 05: **主攻の行だけが枠線と背景を持つ**。役割ラベルは幅36px
 * 固定にして命令文の左端を揃える。3行が同じ重さで並ぶと、どれが主攻かを毎回読む
 * ことになる — 主効の指定は作戦の骨格なので、一目で分かる必要がある。
 *
 * 行にカーソルを乗せると、地図側でその小隊の接近経路だけが濃くなる。地図に文字を
 * 出さずにパネルと盤面を対応づけるための仕掛け。
 */

const ROLE_LABEL: Record<PlanTaskView["role"], string> = {
  main: "主攻",
  supporting: "助攻",
  reserve: "予備",
};

const MISSION_LABEL: Record<PlanTaskView["missionKind"], string> = {
  seize: "確保",
  support_by_fire: "支援射撃",
  screen: "掩護",
};

export function PlanPanel() {
  const phase = useSimStore((s) => s.phase);
  const plans = useSimStore((s) => s.plans);
  const viewSide = useSimStore((s) => s.viewSide);
  const setHovered = useSimStore((s) => s.setHoveredPlan);
  const startBattle = useSimStore((s) => s.startBattle);

  if (phase !== "planning") return null;

  return (
    <div className="panel panel-warn plan-fit">
      <div className="panel-cap">
        <span className="plan-title">作戦立案</span>
        <span>開始まで時間は止まっています</span>
      </div>

      {plans.length === 0 && (
        <div className="dbg-k">この編成には中隊長がいません(分隊・小隊シナリオ)。</div>
      )}

      {plans.map((p) => (
        <div key={p.side} className="plan-force">
          <div className={`plan-force-head force-${p.side}`}>
            <span className="force-label">{p.side.toUpperCase()}</span>
            {p.side !== viewSide && <span className="plan-peek">神視点</span>}
          </div>
          <div className="plan-intent">{p.intent}</div>
          {p.tasks.map((t) => (
            <div
              key={t.key}
              className={t.role === "main" ? "plan-task plan-main" : "plan-task"}
              onMouseEnter={() => setHovered(t.key)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className={`plan-role plan-role-${t.role}`}>{ROLE_LABEL[t.role]}</span>
              <span className="plan-unit">{t.name}</span>
              <span className="plan-unit">{MISSION_LABEL[t.missionKind]}</span>
              <span className="plan-order">{t.order}</span>
            </div>
          ))}
        </div>
      ))}

      <button type="button" className="plan-start" onClick={startBattle}>
        戦闘開始
        <span className="key-cap">Enter</span>
      </button>
      <div className="hint">配置(G)を変えると中隊長が立案し直します</div>
    </div>
  );
}
