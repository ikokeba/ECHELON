import { useSimStore, type ViewEchelon } from "./store.ts";

/**
 * いま「どの陣営の・どの指揮階層の・どのユニット」を操作しているかを常時表示する
 * (初回テストプレイ指摘: 操作対象が画面から分からない)。
 *
 * 仕様 §4 のホットスワップは操作対象を頻繁に切り替える前提なので、現在地の常設表示が要る。
 */
const ECHELON_JP: Record<ViewEchelon, string> = {
  company: "中隊長",
  platoon: "小隊長",
  squad: "分隊長",
  truth: "神視点",
};
const UNIT_SUFFIX: Record<"company" | "platoon" | "squad", string> = {
  company: "中隊",
  platoon: "小隊",
  squad: "分隊",
};

export function ControlBanner() {
  const control = useSimStore((s) => s.control);
  const viewSide = useSimStore((s) => s.viewSide);
  const viewEchelon = useSimStore((s) => s.viewEchelon);

  if (!control) {
    return (
      <div className="control-banner cb-idle">
        <span className="cb-role">観戦中</span>
        <span className="cb-unit">全ユニットAI制御</span>
        <span className="cb-view">視点: {ECHELON_JP[viewEchelon]}</span>
      </div>
    );
  }

  const sideCls = control.side === "blue" ? "cb-blue" : "cb-red";
  return (
    <div className={`control-banner ${sideCls}`}>
      <span className="cb-side">{control.side === "blue" ? "BLUE" : "RED"}</span>
      <span className="cb-role">{ECHELON_JP[control.echelon as ViewEchelon] ?? control.echelon}</span>
      <span className="cb-unit">
        {control.unitId}
        {UNIT_SUFFIX[control.echelon as "company" | "platoon" | "squad"] ?? ""}
        <span className="cb-rep"> 操作中</span>
      </span>
      {viewSide !== control.side && <span className="cb-view">視点: {viewSide.toUpperCase()}</span>}
    </div>
  );
}
