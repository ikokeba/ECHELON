import { useEffect } from "react";
import { GameView } from "./ui/GameView.tsx";
import { useSimStore } from "./ui/store.ts";

export function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        useSimStore.getState().togglePause();
      }
      if (e.code === "Period" && useSimStore.getState().paused) {
        useSimStore.getState().requestStep();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <GameView />;
}
