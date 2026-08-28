import { useEffect, useRef } from "react";
import { startRuntime } from "./runtime.ts";
import { Hud } from "./Hud.tsx";

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stop = startRuntime(canvas);
    return stop;
  }, []);

  return (
    <div className="game-view">
      <canvas ref={canvasRef} className="game-canvas" />
      <Hud />
    </div>
  );
}
