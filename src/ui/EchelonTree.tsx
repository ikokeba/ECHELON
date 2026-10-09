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

  /**
   * この分隊の中(分隊長・FT・隊員のどれか)を操作しているか(`[v7.3]` A-7)。
   * FTと隊員のノードは、いま触っている分隊の下にだけ開く — 全分隊ぶん並べると長すぎる
   */
  const inSquad = (
    sq: (typeof companies)[number]["platoons"][number]["squads"][number],
  ): boolean => {
    if (!control || control.side !== viewSide) return false;
    if (control.echelon === "squad") return control.unitId === sq.squadId;
    if (control.echelon === "fireteam" || control.echelon === "soldier") {
      return sq.fireteams.some(
        (ft) => ft.leaderId === control.unitId || ft.members.some((m) => m.id === control.unitId),
      );
    }
    return false;
  };

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
            {/* `[v6.9]` 本部要員を持たない階層は指揮ノードとして描かない。
                分隊規模の編成では中隊・小隊は分隊を束ねるだけの容れ物で、
                そこへ交代できるように見せると実体のない相手を選ばせることになる。 */}
            {co.structural && (
              <>
                <button
                  type="button"
                  className={
                    control?.echelon === "company" && control.unitId === co.companyId
                      ? "et-node et-on"
                      : "et-node"
                  }
                  onClick={() =>
                    pick(
                      { echelon: "company", side: viewSide, unitId: co.companyId },
                      co.commanderId,
                    )
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
                {/* 迫撃砲(`[v6.9]` 仕様 §10/§11)。中隊本部を持つ編成だけが持つ資源 */}
                {co.mortarTotal > 0 && (
                  <div
                    className={co.mortarEtaSec !== null ? "et-assets et-firing" : "et-assets"}
                    title="60mm迫撃砲の残弾(仕様 §10)。中隊長が中隊のbeliefに向けて要請する"
                  >
                    {co.mortarEtaSec !== null
                      ? `迫撃砲 弾着まで ${co.mortarEtaSec.toFixed(1)}秒`
                      : `迫撃砲 ${co.mortarLeft}/${co.mortarTotal} 発`}
                  </div>
                )}
              </>
            )}

            <div className={co.structural ? "et-sub" : undefined}>
              {co.platoons.map((pl) => (
                <div key={pl.platoonId} className="et-list">
                  {pl.structural && (
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
                  )}

                  <div className={pl.structural ? "et-sub" : undefined}>
                    {pl.squads.map((sq) => (
                      <div key={sq.squadId} className="et-list">
                        <button
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
                          {sq.degraded && (
                            <span className="et-deg" title="指揮継承直後(仕様 §12)" />
                          )}
                          <span className="et-strength">
                            {sq.effective}/{sq.total}
                          </span>
                        </button>
                        {/* `[v7.3]` FTリーダー・一兵卒の座席(A-7)。いま触っている分隊だけ開く */}
                        {inSquad(sq) && (
                          <div className="et-sub">
                            {sq.fireteams.map((ft) => (
                              <div key={ft.ftIndex} className="et-team">
                                <button
                                  type="button"
                                  disabled={ft.leaderId === null}
                                  className={
                                    control?.echelon === "fireteam" &&
                                    control.unitId === ft.leaderId
                                      ? "et-node et-leaf et-on"
                                      : "et-node et-leaf"
                                  }
                                  onClick={() =>
                                    ft.leaderId !== null &&
                                    pick(
                                      { echelon: "fireteam", side: viewSide, unitId: ft.leaderId },
                                      ft.leaderId,
                                    )
                                  }
                                  title="FTリーダーとして4名を動かす(右クリックで移動)"
                                >
                                  <RankBars level="fireteam" />
                                  <span className="et-name">FT{ft.ftIndex}</span>
                                </button>
                                <div className="et-members">
                                  {ft.members.map((m) => (
                                    <button
                                      key={m.id}
                                      type="button"
                                      disabled={!m.ok}
                                      className={
                                        control?.echelon === "soldier" && control.unitId === m.id
                                          ? "et-chip et-on"
                                          : "et-chip"
                                      }
                                      onClick={() =>
                                        pick(
                                          { echelon: "soldier", side: viewSide, unitId: m.id },
                                          m.id,
                                        )
                                      }
                                      title={`#${m.id} 一兵卒として操作する(右クリックで移動)`}
                                    >
                                      {m.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
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
