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
  // 後援部隊(`[v7.0]`)。要請できるのは最上位の指揮官を操作しているときだけ(仕様 §4)
  const reinf = s.reinforcement[viewSide];
  // 迫撃砲(`[v7.2]`)。要請できるのは中隊長を操作しているときだけ(仕様 §4)
  const fire = s.fireSupport[viewSide];

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
      {reinf && (
        <div className="force-detail force-reinf" title="後援部隊(暫定仕様)。最上位の指揮官が要請し、時間をおいて後方に現れる">
          <span>
            後援 {reinf.callsLeft}/{reinf.calls}回({reinf.size === "squad" ? "分隊" : "小隊"})
          </span>
          {reinf.etaSec !== null && <span>到着まで {Math.ceil(reinf.etaSec)}秒</span>}
          {reinf.arrived > 0 && <span>到着済 {reinf.arrived}</span>}
          <button
            type="button"
            className="seg-btn"
            disabled={!reinf.canCall || reinf.callsLeft <= 0}
            onClick={s.requestReinforcement}
            title={
              reinf.canCall
                ? "後援部隊を要請する"
                : "最上位の指揮官(中隊長、いなければ小隊長)を操作しているときだけ要請できる。AI指揮官は戦力が減ると自分で呼ぶ"
            }
          >
            要請
          </button>
        </div>
      )}
      {fire && (
        <div
          className="force-detail force-reinf"
          title="60mm迫撃砲(仕様 §10)。照準点は要請した時点の像で固定され、飛翔時間ののちに落ちる"
        >
          <span>
            迫撃砲 {fire.roundsLeft}/{fire.roundsTotal}発
          </span>
          {fire.etaSec !== null ? (
            <span>弾着まで {fire.etaSec.toFixed(1)}秒</span>
          ) : (
            fire.cooldownSec > 0 && <span>次の要請まで {Math.ceil(fire.cooldownSec)}秒</span>
          )}
          <button
            type="button"
            className={`seg-btn${s.fireMissionArmed ? " seg-on" : ""}`}
            disabled={!fire.canCall || fire.roundsLeft <= 0}
            onClick={() => s.armFireMission(!s.fireMissionArmed)}
            title={
              fire.canCall
                ? "押してから盤面をクリックした地点へ射撃を要請する(もう一度押すと取り消し)"
                : "中隊長を操作しているときだけ要請できる。AIの中隊長は自分で要請する"
            }
          >
            {s.fireMissionArmed ? "照準中…" : "射撃要請"}
          </button>
        </div>
      )}
      {reinf && reinf.progress !== null && (
        <div className="reinf-gauge" title="後援部隊の到着ゲージ。満ちると指揮所付近に現れる">
          <span style={{ width: `${Math.round(reinf.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
