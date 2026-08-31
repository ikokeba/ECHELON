import { useEffect } from "react";
import { GameView } from "./ui/GameView.tsx";
import { useSimStore } from "./ui/store.ts";

export function App() {
  // グローバルなキーボードショートカット:
  //   Space  ポーズ切替 / "."  1ティック実行 / "H"  デバッグパネル /
  //   "G"  配置パネル / Esc  選択解除・配置の道具を戻す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const onBody = e.target === document.body;
      if (e.code === "Space" && onBody) {
        e.preventDefault();
        useSimStore.getState().togglePause();
      }
      if (e.code === "Period" && useSimStore.getState().paused) {
        useSimStore.getState().requestStep();
      }
      if ((e.code === "KeyH" || e.key === "h") && onBody) {
        const s = useSimStore.getState();
        s.setDebug({ panelOpen: !s.debug.panelOpen });
      }
      if ((e.code === "KeyG" || e.key === "g") && onBody) {
        useSimStore.getState().toggleDeploy();
      }
      if (e.code === "Escape") {
        const s = useSimStore.getState();
        if (s.setupTool) s.setSetupTool(null);
        else s.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <GameView />;
}
