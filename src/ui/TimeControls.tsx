import { RUN_SPEEDS, useSimStore } from "./store.ts";

export function TimeControls() {
  const paused = useSimStore((s) => s.paused);
  const speedIdx = useSimStore((s) => s.speedIdx);
  const togglePause = useSimStore((s) => s.togglePause);
  const cycleSpeed = useSimStore((s) => s.cycleSpeed);
  const requestStep = useSimStore((s) => s.requestStep);

  const speed = RUN_SPEEDS[speedIdx] ?? 1;

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
