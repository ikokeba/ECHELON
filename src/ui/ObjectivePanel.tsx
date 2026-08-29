import { useSimStore } from "./store.ts";

/**
 * 拠点の状況表示(仕様 §12 メイン条件「拠点確保」)。
 *
 * 仕様 §12 は味方ステータスをフォグオブウォーの対象外としているが、**拠点の所有は
 * 敵情ではなく統制手段の状態**なので、ここでも隠さない。確保進捗とコンテスト状態
 * (拠点内に敵がいて確保カウントが止まっている)を出すことで、
 * 「どこへ増援を送るか」という §3① の判断材料になる。
 */
export function ObjectivePanel() {
  const objectives = useSimStore((s) => s.objectives);
  const victory = useSimStore((s) => s.victory);

  if (objectives.length === 0 && !victory) return null;

  return (
    <div className="objectives">
      {victory && (
        <div className={`obj-victory obj-victory-${victory.winner}`}>
          {victory.winner === "blue" ? "BLUE" : "RED"} 勝利
          <span className="obj-reason">
            {victory.reason === "objectives" ? "拠点確保" : "戦力の枯渇"}
          </span>
        </div>
      )}
      {objectives.map((o) => (
        <div key={o.id} className="obj-row">
          <span className={`obj-dot obj-${o.owner ?? "neutral"}`} />
          <span className="obj-label">{o.label}</span>
          <span className="obj-bar">
            <span
              className={`obj-fill obj-${o.contested ? "contested" : (o.owner ?? "neutral")}`}
              style={{ width: `${Math.round(o.progress * 100)}%` }}
            />
          </span>
          {o.contested && <span className="obj-contested">係争中</span>}
        </div>
      ))}
    </div>
  );
}
