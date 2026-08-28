import { useSimStore } from "./store.ts";
import { TimeControls } from "./TimeControls.tsx";

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Hud() {
  const { tick, simSeconds, blueAlive, redAlive, blueEffective, redEffective } = useSimStore();

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

      <div className="hud-hint">drag: pan · wheel: zoom</div>
    </div>
  );
}
