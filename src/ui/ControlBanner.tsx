import { useSimStore, type ViewEchelon } from "./store.ts";

/**
 * 上レール右 — 指揮権限バナー。
 *
 * いま「どの陣営の・どの指揮階層の・どのユニット」を動かしているかを常時示す。
 * 仕様 §4 のホットスワップは操作対象を頻繁に切り替える前提なので、現在地の常設表示が要る。
 *
 * `[v6.6]` — UIレビュー 05:「誰が動かしているか」を**枠線1本**で示す。
 * AI任せなら既定の灰枠で不透明度0.7、人が入ると水色枠 + `MANUAL`。
 * 陣営色は左端の1語だけに留め、枠線は「AIか人か」だけを担当させる —
 * 枠線に2つの意味を持たせると、どちらの意味かを毎回読み取る必要が出る。
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
      <div className="panel cmdbanner cb-idle">
        <span className="cb-unit">全ユニットAI制御</span>
        <span className="cb-view">視点: {ECHELON_JP[viewEchelon]}</span>
      </div>
    );
  }

  const sideCls = control.side === "blue" ? "cb-blue" : "cb-red";
  const echelon = ECHELON_JP[control.echelon as ViewEchelon] ?? control.echelon;
  const suffix = UNIT_SUFFIX[control.echelon as "company" | "platoon" | "squad"] ?? "";
  return (
    <div className={`panel panel-live cmdbanner ${sideCls}`}>
      <span className="cb-side">{control.side === "blue" ? "BLUE" : "RED"}</span>
      <span className="cb-unit">
        {control.unitId}
        {suffix}
        {echelon}を操作中
      </span>
      <span className="cb-tag">MANUAL</span>
      {viewSide !== control.side && <span className="cb-view">視点: {viewSide.toUpperCase()}</span>}
    </div>
  );
}
