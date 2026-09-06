import { useSimStore } from "./store.ts";
import { ClockBar } from "./ClockBar.tsx";
import { ViewControls } from "./ViewControls.tsx";
import { EchelonTree } from "./EchelonTree.tsx";
import { ObjectivePanel } from "./ObjectivePanel.tsx";
import { ForcePanel } from "./ForcePanel.tsx";
import { ControlBanner } from "./ControlBanner.tsx";
import { OrderToast } from "./OrderToast.tsx";
import { ThinkingPanel } from "./ThinkingPanel.tsx";
import { DebugPanel } from "./DebugPanel.tsx";
import { DeploymentPanel } from "./DeploymentPanel.tsx";
import { PlanPanel } from "./PlanPanel.tsx";
import { Legend } from "./Legend.tsx";

/**
 * HUDの骨格(`[v6.6]` — UIレビュー 02「3列 + 2レール」)。
 *
 * 以前は各パネルが `position: absolute; top: …` で自分の居場所を主張しており、
 * 出るものが増えるたびに衝突していた(`.plan-panel` と `.thinking-panel` が
 * 同じ `top: 292px` にいたのが典型)。列の flow に乗せれば、増減しても重ならない。
 *
 *   左列 L1 操作 / L2 文脈スロット(常に1つだけ) / L3 拠点
 *   右列 R1 戦力 / R2 指揮階層
 *   中央 上レール(時間と権限) と 下レール(凡例)。盤面は中央帯に収まる
 *
 * デバッグと配置エディタだけは右列に**重ねる**オーバーレイ。常設ではなく、
 * 開いている間だけ他を隠してよいものなので、列には入れない。
 */
export function Hud() {
  const phase = useSimStore((s) => s.phase);
  const collapsed = useSimStore((s) => s.hudCollapsed);
  const toggleHud = useSimStore((s) => s.toggleHud);

  return (
    <div className={collapsed ? "hud hud-collapsed" : "hud"}>
      {/* `[v6.18]` 狭い画面用。列が盤面を覆うので、地図だけにできる逃げ道を置く */}
      <button
        type="button"
        className="hud-toggle"
        onClick={toggleHud}
        title={collapsed ? "パネルを出す" : "パネルを畳んで地図を見る"}
      >
        {collapsed ? "▤" : "▢"}
      </button>

      <div className="hud-col hud-col-l">
        <ViewControls />
        {/* L2 文脈スロット: 立案中は作戦、戦闘中は分隊の思考。常にどちらか1つ */}
        <div className="hud-slot">{phase === "planning" ? <PlanPanel /> : <ThinkingPanel />}</div>
        <ObjectivePanel />
      </div>

      <div className="hud-center">
        <div className="hud-rail">
          <ClockBar />
          <ControlBanner />
        </div>
        <OrderToast />
        <div className="hud-rail">
          <Legend />
        </div>
      </div>

      <div className="hud-col hud-col-r">
        <ForcePanel />
        <EchelonTree />
      </div>

      <DebugPanel />
      <DeploymentPanel />
    </div>
  );
}
