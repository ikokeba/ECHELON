import { SCENARIOS, type ScenarioKey } from "@sim/scenario.ts";
import { useSimStore, type ViewEchelon } from "./store.ts";

const ECHELON_LABEL: Record<ViewEchelon, string> = {
  company: "中隊長",
  platoon: "小隊長",
  squad: "分隊長",
  truth: "神視点",
};

const ECHELON_HINT: Record<ViewEchelon, string> = {
  company: "小隊長からの報告の集約。無線2ホップ分、さらに古く粗い(仕様 §5)",
  platoon: "無線報告のみ。遅延と確度減衰あり(仕様 §5)",
  squad: "麾下2FTの視界の合算。生の視界はここまで",
  truth: "デバッグ表示。実際の敵位置",
};

/**
 * 視点切替。仕様 §5 の「情報の階層化」を体感させるための中核UI。
 * 同じ戦場を、小隊長として見るか分隊長として見るかで、見える敵の量と鮮度が変わる。
 */
export function ViewControls() {
  const viewEchelon = useSimStore((s) => s.viewEchelon);
  const viewSide = useSimStore((s) => s.viewSide);
  const setViewEchelon = useSimStore((s) => s.setViewEchelon);
  const setViewSide = useSimStore((s) => s.setViewSide);
  const known = useSimStore((s) => s.knownContacts);
  const stale = useSimStore((s) => s.staleContacts);
  const scenarioKey = useSimStore((s) => s.scenarioKey);
  const setScenario = useSimStore((s) => s.setScenario);

  return (
    <div className="view-controls">
      <div className="vc-row">
        <span className="vc-label">規模</span>
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => (
          <button
            key={k}
            type="button"
            className={k === scenarioKey ? "vc-btn vc-on" : "vc-btn"}
            onClick={() => setScenario(k)}
            title={SCENARIOS[k].detail}
          >
            {SCENARIOS[k].label}
          </button>
        ))}
      </div>

      <div className="vc-row">
        <span className="vc-label">視点</span>
        {(["company", "platoon", "squad", "truth"] as ViewEchelon[]).map((e) => (
          <button
            key={e}
            type="button"
            className={e === viewEchelon ? "vc-btn vc-on" : "vc-btn"}
            onClick={() => setViewEchelon(e)}
            title={ECHELON_HINT[e]}
          >
            {ECHELON_LABEL[e]}
          </button>
        ))}
      </div>

      <div className="vc-row">
        <span className="vc-label">陣営</span>
        <button
          type="button"
          className={viewSide === "blue" ? "vc-btn vc-on vc-blue" : "vc-btn"}
          onClick={() => setViewSide("blue")}
        >
          BLUE
        </button>
        <button
          type="button"
          className={viewSide === "red" ? "vc-btn vc-on vc-red" : "vc-btn"}
          onClick={() => setViewSide("red")}
        >
          RED
        </button>
      </div>

      <div className="vc-hint">{ECHELON_HINT[viewEchelon]}</div>

      <div className="vc-contacts">
        <span>
          把握中の敵 <b className="mono">{known}</b>
        </span>
        <span className="vc-stale">
          最終目撃 <b className="mono">{stale}</b>
        </span>
      </div>
    </div>
  );
}
