import { SCENARIOS, type ScenarioKey } from "@sim/scenario.ts";
import { useSimStore, type ViewEchelon } from "./store.ts";

/**
 * L1 — 操作(盤面 / 視点 / 陣営 / 配置)。
 *
 * `[v6.11]` 盤面の選択が戻った。選ぶのは**地形だけ** — 規模は陣営ごとの編成
 * (`force.ts`)なので、この列は「どんな街で戦うか」しか意味しない。
 *
 * 視点切替は仕様 §5 の「情報の階層化」を体感させるための中核UI。同じ戦場を、
 * 小隊長として見るか分隊長として見るかで、見える敵の量と鮮度が変わる。
 *
 * `[v6.6]` — UIレビュー 05: 独立したボタンの並びから**セグメント切替**にした。
 * 4つのボタンが横並びだと「押せるもの」が4つあるように見えるが、実際は
 * 4択のうち1つを選ぶ操作なので、1つの部品として見えるほうが正しい。
 */
const ECHELON_LABEL: Record<ViewEchelon, string> = {
  company: "中隊長",
  platoon: "小隊長",
  squad: "分隊長",
  truth: "神",
};

const ECHELON_HINT: Record<ViewEchelon, string> = {
  company: "小隊長からの報告の集約。無線2ホップ分、さらに古く粗い(仕様 §5)",
  platoon: "無線報告のみ。遅延と確度減衰あり(仕様 §5)",
  squad: "麾下2FTの視界の合算。生の視界はここまで",
  truth: "デバッグ表示。実際の敵位置",
};

/** 盤面のセグメントは幅が足りないので、短縮名を別に持つ */
const SCENARIO_SHORT: Record<ScenarioKey, string> = {
  oldQuarter: "旧市街",
  bazaar: "大通り",
  planned: "新市街",
  trench: "塹壕",
  company: "格子",
};

export function ViewControls() {
  const viewEchelon = useSimStore((s) => s.viewEchelon);
  const viewSide = useSimStore((s) => s.viewSide);
  const setViewEchelon = useSimStore((s) => s.setViewEchelon);
  const setViewSide = useSimStore((s) => s.setViewSide);
  const known = useSimStore((s) => s.knownContacts);
  const scenarioKey = useSimStore((s) => s.scenarioKey);
  const setScenario = useSimStore((s) => s.setScenario);
  const stale = useSimStore((s) => s.staleContacts);
  const deployOpen = useSimStore((s) => s.deployOpen);
  const toggleDeploy = useSimStore((s) => s.toggleDeploy);

  return (
    <div className="panel">
      <div className="seg-row">
        <span className="seg-label">盤面</span>
        <div className="seg">
          {(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={k === scenarioKey ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => setScenario(k)}
              title={`${SCENARIOS[k].label} — ${SCENARIOS[k].detail}`}
            >
              {SCENARIO_SHORT[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="vc-hint">{SCENARIOS[scenarioKey].detail}</div>

      <div className="seg-row">
        <span className="seg-label">視点</span>
        <div className="seg">
          {(["company", "platoon", "squad", "truth"] as ViewEchelon[]).map((e) => (
            <button
              key={e}
              type="button"
              className={e === viewEchelon ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => setViewEchelon(e)}
              title={ECHELON_HINT[e]}
            >
              {ECHELON_LABEL[e]}
            </button>
          ))}
        </div>
      </div>

      <div className="seg-row">
        <span className="seg-label">陣営</span>
        <div className="seg">
          <button
            type="button"
            className={viewSide === "blue" ? "seg-btn seg-on seg-blue" : "seg-btn"}
            onClick={() => setViewSide("blue")}
          >
            BLUE
          </button>
          <button
            type="button"
            className={viewSide === "red" ? "seg-btn seg-on seg-red" : "seg-btn"}
            onClick={() => setViewSide("red")}
          >
            RED
          </button>
        </div>
      </div>

      <button
        type="button"
        className={deployOpen ? "btn btn-on" : "btn"}
        onClick={toggleDeploy}
        title="陣営の編成・ドクトリン・展開位置・拠点を決める (G)"
      >
        編成・初期配置を編集
      </button>

      <div className="vc-hint">{ECHELON_HINT[viewEchelon]}</div>

      <div className="vc-contacts">
        <span>
          把握中の敵 <b>{known}</b>
        </span>
        <span>
          最終目撃 <b>{stale}</b>
        </span>
      </div>
    </div>
  );
}
