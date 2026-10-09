import { useEffect, useRef } from "react";
import { startRuntime } from "./runtime.ts";
import { Hud } from "./Hud.tsx";
import { useSimStore } from "./store.ts";

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scenarioKey = useSimStore((s) => s.scenarioKey);
  // 配置を適用したときも作り直す(`[v6.4]`)。初期配置は世界の構築時にしか効かない
  const deploymentNonce = useSimStore((s) => s.deploymentNonce);
  // 「最初から再生」でも作り直す(`[v7.2]` S-4)。記録は store.replay に載って渡る
  const replayNonce = useSimStore((s) => s.replayNonce);

  // シナリオを切り替えたらランタイムごと作り直す。World は不変の初期状態を持たないので、
  // 途中で差し替えるより丸ごと作り直すほうが安全。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stop = startRuntime(canvas, scenarioKey);
    return stop;
  }, [scenarioKey, deploymentNonce, replayNonce]);

  return (
    <div className="game-view">
      <canvas ref={canvasRef} className="game-canvas" />
      <Hud />
    </div>
  );
}
