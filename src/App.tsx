import { useEffect } from "react";
import { GameView } from "./ui/GameView.tsx";
import { useSimStore } from "./ui/store.ts";

export function App() {
  // グローバルなキーボードショートカット:
  //   Space  ポーズ切替 / "."  1ティック実行 / "H"  デバッグパネル /
  //   "G"  配置パネル / "L"  凡例 / Enter  戦闘開始(立案中) /
  //   Esc  選択解除・配置の道具を戻す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const onBody = e.target === document.body;
      // 立案中は Space に「一時停止」の意味が無いので、Enter と同じ「開始」に振る。
      // **ポーズより先に見ること** — 順序を逆にすると Space で開始と同時にポーズがかかる
      if (
        (e.code === "Enter" || e.code === "Space") &&
        useSimStore.getState().phase === "planning"
      ) {
        e.preventDefault();
        useSimStore.getState().startBattle();
        return;
      }
      if (e.code === "Space" && onBody) {
        e.preventDefault();
        useSimStore.getState().togglePause();
      }
      if ((e.code === "KeyL" || e.key === "l") && onBody) {
        useSimStore.getState().toggleLegend();
      }
      if (e.code === "Period" && useSimStore.getState().paused) {
        useSimStore.getState().requestStep();
      }
      if ((e.code === "KeyH" || e.key === "h") && onBody) {
        const s = useSimStore.getState();
        s.setDebug({ panelOpen: !s.debug.panelOpen });
      }
      // `[v7.2]` 振り返り(AAR、S-4)
      if ((e.code === "KeyR" || e.key === "r") && onBody) {
        useSimStore.getState().toggleAar();
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

  /**
   * 初期条件コードを URL の `#` に載せ続ける(`[v6.18]`)。
   *
   * **パネルの中ではなくここでやる。** 配置パネルを開かないと URL が更新されない
   * のでは、「いま見ている条件をそのまま共有する」という用途に使えない
   * (LAN内の別端末で同じ URL を開く、が主目的)。
   *
   * `setupCode()` が副作用を持たないことがここの前提。書き戻す実装だと
   * 「導く → state が変わる → 依存が変わる → 導き直す」で止まらなくなる。
   */
  const scenarioKey = useSimStore((s) => s.scenarioKey);
  const seed = useSimStore((s) => s.seed);
  const force = useSimStore((s) => s.force);
  const doctrine = useSimStore((s) => s.doctrine);
  const posture = useSimStore((s) => s.posture);
  const tuning = useSimStore((s) => s.tuning);
  const deployment = useSimStore((s) => s.deployment);
  useEffect(() => {
    const code = useSimStore.getState().setupCode();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${code}`,
    );
  }, [scenarioKey, seed, force, doctrine, posture, tuning, deployment]);

  return <GameView />;
}
