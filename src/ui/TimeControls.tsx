import { RUN_SPEEDS, useSimStore } from "./store.ts";

export function TimeControls() {
  const paused = useSimStore((s) => s.paused);
  const speedIdx = useSimStore((s) => s.speedIdx);
  const phase = useSimStore((s) => s.phase);
  const togglePause = useSimStore((s) => s.togglePause);
  const cycleSpeed = useSimStore((s) => s.cycleSpeed);
  const requestStep = useSimStore((s) => s.requestStep);

  const speed = RUN_SPEEDS[speedIdx] ?? 1;

  // 作戦立案フェーズ(`[v6.5]`)は時間そのものが流れていない。ポーズと区別が
  // つかないと「再開を押しても動かない」と読まれるので、時間操作は伏せる。
  if (phase === "planning") {
    return (
      <div className="time-controls">
        <span className="tc-planning">作戦立案中 — 時間は止まっています</span>
      </div>
    );
  }

  return (
    <div className="time-controls">
      <button
        type="button"
        className={paused ? "tc-btn tc-active" : "tc-btn"}
        onClick={togglePause}
        title="Space"
      >
        {paused ? "▶ 再開" : "❚❚ 一時停止"}
      </button>
      <button type="button" className="tc-btn" onClick={cycleSpeed} title="速度">
        ×{speed}
      </button>
      <button
        type="button"
        className="tc-btn"
        onClick={requestStep}
        disabled={!paused}
        title="1ティック進める"
      >
        ⏭ ステップ
      </button>
    </div>
  );
}
