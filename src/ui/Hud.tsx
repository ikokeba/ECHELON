import { useSimStore } from "./store.ts";
import { TimeControls } from "./TimeControls.tsx";
import { ViewControls } from "./ViewControls.tsx";
import { EchelonTree } from "./EchelonTree.tsx";
import { ObjectivePanel } from "./ObjectivePanel.tsx";
import { ControlBanner } from "./ControlBanner.tsx";
import { OrderToast } from "./OrderToast.tsx";
import { ThinkingPanel } from "./ThinkingPanel.tsx";
import { DebugPanel } from "./DebugPanel.tsx";

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Hud() {
  const {
    tick,
    simSeconds,
    blueAlive,
    redAlive,
    blueEffective,
    redEffective,
    blueEvacuated,
    redEvacuated,
    blueAwaitingEvac,
    redAwaitingEvac,
    control,
  } = useSimStore();

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="hud-clock">
          <span className="mono">{fmtClock(simSeconds)}</span>
          <span className="hud-tick mono">tick {tick}</span>
        </div>
        <TimeControls />
      </div>

      <ControlBanner />
      <OrderToast />

      <div className="hud-forces">
        <div className="force force-blue">
          <span className="force-label">BLUE</span>
          <span className="mono">
            {blueEffective}/{blueAlive}
          </span>
          <span className="force-evac mono" title="後送待ち / 後送済み(仕様 §9)">
            ▲{blueAwaitingEvac} ✚{blueEvacuated}
          </span>
        </div>
        <div className="force force-red">
          <span className="force-label">RED</span>
          <span className="mono">
            {redEffective}/{redAlive}
          </span>
          <span className="force-evac mono" title="後送待ち / 後送済み(仕様 §9)">
            ▲{redAwaitingEvac} ✚{redEvacuated}
          </span>
        </div>
      </div>

      <ViewControls />
      <ObjectivePanel />
      <EchelonTree />
      <ThinkingPanel />
      <DebugPanel />

      <div className="hud-hint">
        ドラッグ: 移動 · ホイール: 拡大縮小 · Space: 一時停止 · . : 1ティック · 左クリック:
        ユニット選択 · H: デバッグ
        {control && " · 右クリック: 移動命令"}
      </div>
    </div>
  );
}
