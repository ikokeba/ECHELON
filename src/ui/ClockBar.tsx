import { RUN_SPEEDS, useSimStore } from "./store.ts";

/**
 * 上レール左 — 時計と時間操作(`[v6.6]` で `TimeControls` と時計を1つのパネルに統合)。
 *
 * 別々のパネルに分かれていると「時刻」と「その時刻を進める操作」が離れて見える。
 * UIレビュー 05 のとおり、速度は倍率ボタンを横並びにして現在値だけ枠線で示す。
 */
function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ClockBar() {
  const tick = useSimStore((s) => s.tick);
  const simSeconds = useSimStore((s) => s.simSeconds);
  const paused = useSimStore((s) => s.paused);
  const speedIdx = useSimStore((s) => s.speedIdx);
  const phase = useSimStore((s) => s.phase);
  const togglePause = useSimStore((s) => s.togglePause);
  const setSpeedIdx = useSimStore((s) => s.setSpeedIdx);
  const requestStep = useSimStore((s) => s.requestStep);

  return (
    <div className="panel clockbar">
      <span className="clockbar-time">{fmtClock(simSeconds)}</span>
      <span className="clockbar-tick">tick {tick}</span>
      <span className="clockbar-sep" />
      {phase === "planning" ? (
        // 立案中は時間そのものが流れていない。ポーズと区別がつかないと
        // 「再開を押しても動かない」と読まれるので、時間操作は伏せる
        <span className="tc-planning">作戦立案中 — 時間は止まっています</span>
      ) : (
        <div className="tc-group">
          <button
            type="button"
            className={paused ? "tc-btn tc-on" : "tc-btn"}
            onClick={togglePause}
            title="一時停止 / 再開 (Space)"
          >
            {paused ? "▶" : "❚❚"}
          </button>
          {RUN_SPEEDS.map((sp, i) => (
            <button
              key={sp}
              type="button"
              className={!paused && i === speedIdx ? "tc-btn tc-on" : "tc-btn"}
              onClick={() => setSpeedIdx(i)}
              title={`${sp}倍速`}
            >
              ×{sp}
            </button>
          ))}
          <button
            type="button"
            className="tc-btn"
            onClick={requestStep}
            disabled={!paused}
            title="1ティック進める (.)"
          >
            ⏭
          </button>
        </div>
      )}
    </div>
  );
}
