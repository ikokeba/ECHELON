import { useEffect, useRef } from "react";
import { startRuntime } from "./runtime.ts";
import { Hud } from "./Hud.tsx";
import { useSimStore } from "./store.ts";

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scenarioKey = useSimStore((s) => s.scenarioKey);

  // シナリオを切り替えたらランタイムごと作り直す。World は不変の初期状態を持たないので、
  // 途中で差し替えるより丸ごと作り直すほうが安全(design AD-10)。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stop = startRuntime(canvas, scenarioKey);
    return stop;
  }, [scenarioKey]);

  return (
    <div className="game-view">
      <canvas ref={canvasRef} className="game-canvas" />
      <Hud />
    </div>
  );
}
