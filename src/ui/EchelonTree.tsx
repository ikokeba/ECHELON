import { useSimStore } from "./store.ts";

/**
 * 階層ツリーによるホットスワップUI(仕様 §4「分隊長以上はミニマップまたは階層ツリー
 * メニューから選択」)。
 *
 * 仕様 §4 のとおり、クールダウン・距離制限・視界制限は設けない。いつでもどこへでも飛べる。
 * スワップを促すアラートも出さない(仕様 §15「階層を跨いだアラート設計 → なしで確定」)。
 *
 * `[v6]` 中隊長ノードと指揮継承の表示を追加。指揮官が無力化されて次席者が引き継いだ
 * ノードには「継承中」を出す — 仕様 §12 の「味方ステータスはフォグオブウォーの対象外、
 * 常にリアルタイムで共有される」に従い、この情報は隠さない。
 */
export function EchelonTree() {
  const roster = useSimStore((s) => s.roster);
  const control = useSimStore((s) => s.control);
  const swap = useSimStore((s) => s.requestSwap);
  const viewSide = useSimStore((s) => s.viewSide);

  const companies = roster.filter((r) => r.side === viewSide);

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

      {companies.map((co) => (
        <div key={co.companyId} className="et-group">
          <button
            type="button"
            className={
              control?.echelon === "company" && control.unitId === co.companyId
                ? "et-node et-on"
                : "et-node"
            }
            onClick={() => swap({ echelon: "company", side: viewSide, unitId: co.companyId })}
            title="指揮所(CP)から無線で統制する(仕様 §11)"
          >
            <span className="et-rank">中隊長</span>
            <span className="et-name">
              {co.companyId}中隊
              {co.degraded && <span className="et-degraded">継承中</span>}
            </span>
            <span className="et-strength mono">
              {co.effective}/{co.total}
            </span>
          </button>

          <div className="et-assets" title="後送アセットの稼働状況(仕様 §9)">
            後送アセット {co.assetsTotal - co.assetsBusy}/{co.assetsTotal} 待機
          </div>

          {co.platoons.map((pl) => (
            <div key={pl.platoonId} className="et-group">
              <button
                type="button"
                className={
                  control?.echelon === "platoon" && control.unitId === pl.platoonId
                    ? "et-node et-child et-on"
                    : "et-node et-child"
                }
                onClick={() => swap({ echelon: "platoon", side: viewSide, unitId: pl.platoonId })}
              >
                <span className="et-rank">小隊長</span>
                <span className="et-name">
                  {pl.platoonId}小隊
                  {pl.degraded && <span className="et-degraded">継承中</span>}
                </span>
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
                      ? "et-node et-grandchild et-on"
                      : "et-node et-grandchild"
                  }
                  onClick={() => swap({ echelon: "squad", side: viewSide, unitId: sq.squadId })}
                >
                  <span className="et-rank">分隊長</span>
                  <span className="et-name">
                    {sq.squadId}分隊
                    {sq.degraded && <span className="et-degraded">継承中</span>}
                  </span>
                  <span className="et-strength mono">
                    {sq.effective}/{sq.total}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
