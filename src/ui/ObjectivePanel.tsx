import { useSimStore } from "./store.ts";

/**
 * L3 — 拠点の状況(仕様 §12 メイン条件「拠点確保」)。
 *
 * 仕様 §12 は味方ステータスをフォグオブウォーの対象外としているが、**拠点の所有は
 * 敵情ではなく統制手段の状態**なので、ここでも隠さない。
 *
 * `[v6.6]` — UIレビュー 05: 占領度は1本のバーで示し、状態は右端の一語にした。
 * 係争中に「係争中」というタグを別に足していたのをやめ、色と語でだけ表す
 * (同じことを2度言うと、行が長くなるだけで読みは速くならない)。
 */
export function ObjectivePanel() {
  const objectives = useSimStore((s) => s.objectives);
  const victory = useSimStore((s) => s.victory);

  if (objectives.length === 0 && !victory) return null;

  return (
    <div className="panel">
      <div className="panel-cap">
        <span>OBJECTIVES</span>
        <span>過半数の保持で勝利</span>
      </div>
      {victory && (
        <div className={`obj-victory obj-victory-${victory.winner}`}>
          {victory.winner === "blue" ? "BLUE" : "RED"} 勝利
          <span className="obj-reason">
            {victory.reason === "objectives" ? "拠点確保" : "戦力の枯渇"}
          </span>
        </div>
      )}
      {objectives.map((o) => {
        const cls = o.contested ? "contested" : (o.owner ?? "neutral");
        const state = o.contested
          ? "係争"
          : o.owner
            ? "確保"
            : o.progress > 0
              ? `${Math.round(o.progress * 100)}%`
              : "中立";
        return (
          <div key={o.id} className="obj-row">
            <span className={`obj-dot obj-${o.owner ?? "neutral"}`} />
            <span className="obj-label">{o.label.replace("OBJ ", "")}</span>
            <span className="obj-bar">
              <span
                className={`obj-fill obj-${cls}`}
                style={{ width: `${Math.round(o.progress * 100)}%` }}
              />
            </span>
            <span className={`obj-state obj-${cls}`}>{state}</span>
          </div>
        );
      })}
    </div>
  );
}
