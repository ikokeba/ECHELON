import { useSimStore } from "./store.ts";
import { RankBars } from "./RankBars.tsx";
import { platoonName } from "@sim/c2/planning.ts";

/**
 * R2 — 階層ツリーによるホットスワップUI(仕様 §4「分隊長以上はミニマップまたは
 * 階層ツリーメニューから選択」)。
 *
 * 仕様 §4 のとおり、クールダウン・距離制限・視界制限は設けない。いつでもどこへでも飛べる。
 * スワップを促すアラートも出さない(仕様 §15「階層を跨いだアラート設計 → なしで確定」)。
 *
 * `[v6.6]` — UIレビュー 05: 階層はインデントではなく**左の縦罫**で示し、階級は
 * 地図と同じ横棒の記号を流用する。「継承中」の文字タグは黄の点1つに置き換えた
 * (仕様 §12 の情報を隠したのではなく、行の中で最も細い表現に移しただけ)。
 */
export function EchelonTree() {
  const roster = useSimStore((s) => s.roster);
  const control = useSimStore((s) => s.control);
  const swap = useSimStore((s) => s.requestSwap);
  const select = useSimStore((s) => s.select);
  const viewSide = useSimStore((s) => s.viewSide);

  /**
   * ノードを押したら、交代すると同時にその指揮官本人を**選択**する。`[v6.4]`
   * 選択すると麾下ユニットが画面上で強調されるので、「誰が誰の下にいるのか」を
   * ツリーと戦場の両方で同時に確かめられる。
   */
  const pick = (c: Parameters<typeof swap>[0], commanderId: number | null): void => {
    swap(c);
    select(commanderId);
  };

  const companies = roster.filter((r) => r.side === viewSide);

  return (
    <div className="panel panel-scroll">
      <div className="panel-cap">
        <span>ECHELON</span>
        <span>クリックで交代</span>
      </div>

      <div className="et-list">
        <button
          type="button"
          className={control === null ? "et-node et-on" : "et-node"}
          onClick={() => pick(null, null)}
          title="全ユニットをAIに任せる"
        >
          <span className="et-name">観戦(全AI)</span>
        </button>

        {companies.map((co) => (
          <div key={co.companyId} className="et-list">
            <button
              type="button"
              className={
                control?.echelon === "company" && control.unitId === co.companyId
                  ? "et-node et-on"
                  : "et-node"
              }
              onClick={() =>
                pick({ echelon: "company", side: viewSide, unitId: co.companyId }, co.commanderId)
              }
              title="指揮所(CP)から無線で統制する(仕様 §11)"
            >
              <RankBars level="company" />
              <span className="et-name">{co.companyId}中隊</span>
              {co.degraded && <span className="et-deg" title="指揮継承直後(仕様 §12)" />}
              <span className="et-strength">
                {co.effective}/{co.total}
              </span>
            </button>

            <div className="et-assets" title="後送アセットの稼働状況(仕様 §9)">
              後送 {co.assetsTotal - co.assetsBusy}/{co.assetsTotal} 待機
            </div>

            <div className="et-sub">
              {co.platoons.map((pl) => (
                <div key={pl.platoonId} className="et-list">
                  <button
                    type="button"
                    className={
                      control?.echelon === "platoon" && control.unitId === pl.platoonId
                        ? "et-node et-on"
                        : "et-node"
                    }
                    onClick={() =>
                      pick(
                        { echelon: "platoon", side: viewSide, unitId: pl.platoonId },
                        pl.commanderId,
                      )
                    }
                  >
                    <RankBars level="platoon" />
                    <span className="et-name">{platoonName(pl.platoonId)}</span>
                    {pl.degraded && <span className="et-deg" title="指揮継承直後(仕様 §12)" />}
                    <span className="et-strength">
                      {pl.effective}/{pl.total}
                    </span>
                  </button>

                  <div className="et-sub">
                    {pl.squads.map((sq) => (
                      <button
                        key={sq.squadId}
                        type="button"
                        className={
                          control?.echelon === "squad" && control.unitId === sq.squadId
                            ? "et-node et-leaf et-on"
                            : "et-node et-leaf"
                        }
                        onClick={() =>
                          pick(
                            { echelon: "squad", side: viewSide, unitId: sq.squadId },
                            sq.commanderId,
                          )
                        }
                      >
                        <span className="et-name">{sq.squadId}分隊</span>
                        {sq.degraded && <span className="et-deg" title="指揮継承直後(仕様 §12)" />}
                        <span className="et-strength">
                          {sq.effective}/{sq.total}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
