import { useSimStore } from "./store.ts";

/**
 * 階層ツリーによるホットスワップUI(仕様 §4「分隊長以上はミニマップまたは階層ツリー
 * メニューから選択」)。
 *
 * 仕様 §4 のとおり、クールダウン・距離制限・視界制限は設けない。いつでもどこへでも飛べる。
 * スワップを促すアラートも出さない(仕様 §15「階層を跨いだアラート設計 → なしで確定」)。
 */
export function EchelonTree() {
  const roster = useSimStore((s) => s.roster);
  const control = useSimStore((s) => s.control);
  const swap = useSimStore((s) => s.requestSwap);
  const viewSide = useSimStore((s) => s.viewSide);

  const platoons = roster.filter((r) => r.side === viewSide);

  return (
    <div className="echelon-tree">
      <div className="et-title">指揮階層(クリックで交代)</div>

      <button
        type="button"
        className={control === null ? "et-node et-on" : "et-node"}
        onClick={() => swap(null)}
        title="全ユニットをAIに任せる"
      >
        観戦(全AI)
      </button>

      {platoons.map((pl) => (
        <div key={pl.platoonId} className="et-group">
          <button
            type="button"
            className={
              control?.echelon === "platoon" && control.unitId === pl.platoonId
                ? "et-node et-on"
                : "et-node"
            }
            onClick={() => swap({ echelon: "platoon", side: viewSide, unitId: pl.platoonId })}
          >
            <span className="et-rank">小隊長</span>
            <span className="et-name">{pl.platoonId}小隊</span>
            <span className="et-strength mono">
              {pl.effective}/{pl.total}
            </span>
          </button>

          {pl.squads.map((sq) => (
            <button
              key={sq.squadId}
              type="button"
              className={
                control?.echelon === "squad" && control.unitId === sq.squadId
                  ? "et-node et-child et-on"
                  : "et-node et-child"
              }
              onClick={() => swap({ echelon: "squad", side: viewSide, unitId: sq.squadId })}
            >
              <span className="et-rank">分隊長</span>
              <span className="et-name">{sq.squadId}分隊</span>
              <span className="et-strength mono">
                {sq.effective}/{sq.total}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
