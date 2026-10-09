import { useSimStore } from "./store.ts";

/**
 * 各分隊・FTの思考と状態を可視化する(初回テストプレイ指摘)。
 *
 * squad-12v12 モックの「FT1: ADVANCE [攻撃/防衛]」表示を踏襲する。表示側(viewSide)の
 * 全FTのモードと役割、分隊の移動技術・室内戦・指揮継承、そしてクリック選択した兵士の詳細。
 */
const ORDER_JP: Record<string, string> = {
  move: "移動",
  hold: "保持",
  suppress: "制圧",
  maneuver: "機動",
  retreat: "後退",
  evade: "回避",
  follow: "追従",
};
const EVAC_JP: Record<string, string> = {
  none: "—",
  requested: "後送要請",
  carrying: "搬送中",
  evacuated: "後送済",
  collected: "収容済",
};

export function ThinkingPanel() {
  // 立案フェーズは同じ枠に作戦パネルが出る。まだ1ティックも進んでいないので
  // 表示すべき「思考」も無い(`[v6.5]`)
  const phase = useSimStore((s) => s.phase);
  if (phase === "planning") return null;
  return <ThinkingPanelBody />;
}

function ThinkingPanelBody() {
  const thinking = useSimStore((s) => s.thinking);
  const viewSide = useSimStore((s) => s.viewSide);
  const sel = thinking.selected;

  return (
    <div className="panel panel-scroll">
      <div className="panel-cap">
        <span>CONTEXT / 分隊の思考</span>
        <span>{viewSide.toUpperCase()}</span>
      </div>

      <div className="tp-list">
        {thinking.squads.map((sq) => (
          <div key={sq.label} className={sq.cqb ? "tp-squad tp-squad-hot" : "tp-squad"}>
            <div className="tp-squad-head">
              <span className="tp-name">{sq.label}</span>
              <span className="tp-tech">{sq.technique}</span>
              {sq.cqb && <span className="tp-tag tp-cqb">室内戦</span>}
              {sq.degraded && <span className="tp-tag tp-deg">継承中</span>}
            </div>
            {thinking.fireteams
              .filter((ft) => ft.label.startsWith(`${sq.label} `))
              .map((ft) => (
                <div key={ft.label} className="tp-ft">
                  <span className="tp-ft-name">{ft.label.replace(`${sq.label} `, "")}</span>
                  <span className={`tp-mode${ft.routed ? " tp-routed" : ""}`}>
                    {ft.routed ? "潰走" : ft.mode}
                  </span>
                  <span className="tp-role">[{ft.role}]</span>
                </div>
              ))}
          </div>
        ))}
        {thinking.squads.length === 0 && <div className="tp-empty">（この陣営に分隊なし）</div>}
      </div>

      {thinking.counter && <div className="tp-empty">⟲ {thinking.counter}</div>}
      {thinking.flashes.length > 0 && (
        <div className="tp-selected">
          <div className="panel-cap">
            <span>FLASH / 臨時報告</span>
          </div>
          {thinking.flashes.map((f) => (
            <div key={f.key} className="mono">
              {f.from} <b>{f.what}</b> · {f.agoSec}秒前
            </div>
          ))}
        </div>
      )}

      <div className="tp-selected">
        <div className="panel-cap">
          <span>SELECTED</span>
        </div>
        {sel ? (
          <div className="mono">
            <div>
              #{sel.id} {sel.hqRole ?? sel.role} · {sel.squadId}分隊
              {sel.fireteamId >= 0 ? ` FT${sel.fireteamId}` : ""}
            </div>
            <div>
              命令 <b>{ORDER_JP[sel.order] ?? sel.order}</b>
              {sel.hasTarget ? "（目標あり）" : ""}
            </div>
            <div>
              視認 <b>{sel.sees}</b> · {sel.observed ? "被発見" : "未発見"} ·{" "}
              {sel.suppressed ? "被制圧" : "非制圧"}
              {sel.routed ? " · 潰走" : ""}
            </div>
            <div>後送 {EVAC_JP[sel.evac] ?? sel.evac}</div>
          </div>
        ) : (
          <div className="tp-empty">マップ上のユニットをクリックで選択</div>
        )}
      </div>
    </div>
  );
}
