import { useSimStore, type PlanTaskView } from "./store.ts";

/**
 * 作戦立案フェーズのパネル(`[v6.5]`)。
 *
 * 流れは「配置(G)→ 中隊長が立案 → 内容を確認 → 戦闘開始」。ここに出るのは
 * 作戦命令(OPORD)の第3項「機動の要領」に相当するもので、中隊長が拠点に対して
 * 主攻と助攻を決め、各小隊へ任務と接近経路を割り当てた結果(仕様 §3① / §11)。
 *
 * 中隊長は**敵の位置を一切見ずに**これを立てている(仕様 §5)。立案時点で
 * belief は空であり、地形と拠点と自軍の配置だけが材料になる。
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
  const toggleDeploy = useSimStore((s) => s.toggleDeploy);

  if (phase !== "planning") return null;

  return (
    <div className="plan-panel">
      <div className="plan-head">
        <span className="plan-title">作戦立案</span>
        <span className="plan-sub">
          中隊長が拠点に対する計画を立てました。開始するまで時間は止まっています。
        </span>
      </div>

      {plans.length === 0 && (
        <div className="dbg-k">この編成には中隊長がいません(分隊・小隊シナリオ)。</div>
      )}

      <div className="plan-body">
        {plans.map((p) => (
          <div key={p.side} className="plan-force">
            <div className={`plan-force-head ${p.side === "blue" ? "force-blue" : "force-red"}`}>
              <span className="force-label">{p.side.toUpperCase()}</span>
              {p.side !== viewSide && <span className="plan-peek">神視点</span>}
              <span className="plan-intent">{p.intent}</span>
            </div>
            {p.tasks.map((t) => (
              <div
                key={t.key}
                className="plan-task"
                onMouseEnter={() => setHovered(t.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className={`plan-role plan-role-${t.role}`}>{ROLE_LABEL[t.role]}</span>
                <span className="plan-mission">{MISSION_LABEL[t.missionKind]}</span>
                <span className="plan-order">{t.order}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="plan-foot">
        <button type="button" className="plan-start" onClick={startBattle}>
          ▶ 戦闘開始 <span className="plan-key">Enter</span>
        </button>
        <button type="button" className="vc-btn" onClick={toggleDeploy}>
          配置を変える (G)
        </button>
        <span className="dbg-k">配置を変えると中隊長が立案し直します</span>
      </div>
    </div>
  );
}
