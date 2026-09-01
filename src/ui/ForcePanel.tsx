import { useSimStore } from "./store.ts";

/**
 * R1 — 両軍の戦力(`[v6.6]` — UIレビュー 05)。
 *
 * 数字だけだと「まだ余裕があるのか」が読めないので、残存率をバーで併記する。
 * 下段は損耗の内訳(後送待ち / 搬送中 / 戦死)。仕様 §12 は味方ステータスを
 * フォグオブウォーの対象外としているので、両軍の生存数はここで隠さない
 * — 敵の内訳まで出すと索敵の意味が薄れるため、内訳は自陣営ぶんだけ。
 */
export function ForcePanel() {
  const s = useSimStore();
  const viewSide = s.viewSide;

  const rows = [
    {
      side: "blue" as const,
      label: "BLUE",
      eff: s.blueEffective,
      total: s.blueTotal,
      awaiting: s.blueAwaitingEvac,
      carrying: s.blueCarrying,
      kia: s.blueTotal - s.blueAlive,
    },
    {
      side: "red" as const,
      label: "RED",
      eff: s.redEffective,
      total: s.redTotal,
      awaiting: s.redAwaitingEvac,
      carrying: s.redCarrying,
      kia: s.redTotal - s.redAlive,
    },
  ];
  const own = rows.find((r) => r.side === viewSide) ?? rows[0]!;

  return (
    <div className="panel">
      <div className="panel-cap">
        <span>FORCE</span>
      </div>
      {rows.map((r) => (
        <div key={r.side} className={`force-row force-${r.side}`}>
          <span className="force-label">{r.label}</span>
          <span className="force-bar">
            <span style={{ width: `${r.total > 0 ? (r.eff / r.total) * 100 : 0}%` }} />
          </span>
          <span className="force-num">
            {r.eff}
            <i>/{r.total}</i>
          </span>
        </div>
      ))}
      <div className="force-detail" title="自陣営の損耗内訳(仕様 §9)">
        <span>後送待ち {own.awaiting}</span>
        <span>搬送中 {own.carrying}</span>
        <span>戦死 {own.kia}</span>
      </div>
    </div>
  );
}
