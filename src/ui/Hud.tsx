import { useSimStore } from "./store.ts";
import { TimeControls } from "./TimeControls.tsx";
import { ViewControls } from "./ViewControls.tsx";
import { EchelonTree } from "./EchelonTree.tsx";

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Hud() {
  const { tick, simSeconds, blueAlive, redAlive, blueEffective, redEffective, control } =
    useSimStore();

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="hud-clock">
          <span className="mono">{fmtClock(simSeconds)}</span>
          <span className="hud-tick mono">tick {tick}</span>
        </div>
        <TimeControls />
      </div>

      <div className="hud-forces">
        <div className="force force-blue">
          <span className="force-label">BLUE</span>
          <span className="mono">
            {blueEffective}/{blueAlive}
          </span>
        </div>
        <div className="force force-red">
          <span className="force-label">RED</span>
          <span className="mono">
            {redEffective}/{redAlive}
          </span>
        </div>
      </div>

      <ViewControls />
      <EchelonTree />

      <div className="hud-hint">
        ドラッグ: 移動 · ホイール: 拡大縮小 · Space: 一時停止 · . : 1ティック
        {control && " · 右クリック: 移動命令"}
      </div>
    </div>
  );
}
