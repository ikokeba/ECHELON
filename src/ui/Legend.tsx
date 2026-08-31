import { useSimStore } from "./store.ts";

/**
 * 地図の凡例(`[v6.5]`)。
 *
 * 兵士の色は状態そのもの — 陣営・制圧・出血・止血・搬送・戦死が1つのトークンの
 * 色に畳み込まれている。凡例が無いと、盤面で起きていることの半分が読めない。
 *
 * 色見本の値は `render/renderer.ts` の定数と**必ず一致させること**。地図と凡例が
 * ずれた時点で凡例は嘘になる。
 */

interface Item {
  color: string;
  label: string;
  /** 丸ではなく別の形で描くもの(菱形・リングなど) */
  shape?: "diamond" | "ring" | "bar";
  title?: string;
}

/** 兵士トークンの色(renderer.ts の SIDE_COLOR / WIA_COLOR ほかと同値)。 */
const SOLDIER_ITEMS: Item[] = [
  { color: "#2f74d8", label: "BLUE" },
  { color: "#d8342f", label: "RED" },
  { color: "#e3d9c6", label: "制圧中", title: "被制圧: 命中率 −40%(仕様 §8.6)。色が白茶ける" },
  { color: "#ffcc17", label: "出血中", title: "負傷。45秒以内に応急手当が要る(仕様 §9)" },
  { color: "#2fbf72", label: "止血済", title: "出血は止まったが行動不能。後送待ち(仕様 §9)" },
  { color: "#7ad3ff", label: "担架", title: "搬送中の負傷者と、担いでいる担架要員(仕様 §9)" },
  { color: "#3a352b", label: "戦死" },
];

/** 敵と統制手段のマーカー。 */
const MARKER_ITEMS: Item[] = [
  {
    color: "#d8342f",
    label: "敵(報告)",
    shape: "diamond",
    title: "実体ではなく最終目撃位置。薄いほど確度が低い(仕様 §5)",
  },
  { color: "#6a6252", label: "ゴースト", shape: "diamond", title: "確度が尽きた最終目撃情報" },
  { color: "#18a86e", label: "拠点・中立", shape: "ring" },
  { color: "#f0a81c", label: "拠点・係争中", shape: "ring", title: "確保カウントが停止(仕様 §12)" },
  { color: "#ffffff", label: "操作中", shape: "ring" },
  { color: "#00e0ff", label: "選択・麾下", shape: "ring", title: "指揮官を選ぶと麾下が光る" },
  { color: "#ffc21e", label: "移動命令", shape: "ring" },
  { color: "#7c4a1e", label: "閉じた扉", shape: "bar", title: "視線も移動も遮る(仕様 §7.6)" },
];

/** 階級章(`[v6.2]`)。指揮継承の結果で付く(仕様 §12)。 */
const RANK_ITEMS: Array<{ mark: string; label: string }> = [
  { mark: "▪", label: "FTリーダー" },
  { mark: "▪▪", label: "分隊長" },
  { mark: "▬", label: "小隊長" },
  { mark: "▬▬", label: "中隊長" },
];

function Swatch({ item }: { item: Item }) {
  const cls =
    item.shape === "diamond"
      ? "lg-dot lg-diamond"
      : item.shape === "ring"
        ? "lg-dot lg-ring"
        : item.shape === "bar"
          ? "lg-dot lg-bar"
          : "lg-dot";
  const style =
    item.shape === "ring"
      ? { borderColor: item.color }
      : { background: item.color };
  return (
    <span className="lg-item" title={item.title}>
      <span className={cls} style={style} />
      {item.label}
    </span>
  );
}

export function Legend() {
  const open = useSimStore((s) => s.legendOpen);
  const toggle = useSimStore((s) => s.toggleLegend);

  if (!open) {
    return (
      <button type="button" className="lg-open" onClick={toggle} title="凡例 (L)">
        凡例
      </button>
    );
  }

  return (
    <div className="legend">
      <div className="lg-head">
        <span>凡例</span>
        <button type="button" className="dbg-x" onClick={toggle} title="閉じる (L)">
          ×
        </button>
      </div>
      <div className="lg-row">
        <span className="lg-cap">兵士</span>
        {SOLDIER_ITEMS.map((it) => (
          <Swatch key={it.label} item={it} />
        ))}
      </div>
      <div className="lg-row">
        <span className="lg-cap">標識</span>
        {MARKER_ITEMS.map((it) => (
          <Swatch key={it.label} item={it} />
        ))}
      </div>
      <div className="lg-row">
        <span className="lg-cap">階級</span>
        {RANK_ITEMS.map((r) => (
          <span key={r.label} className="lg-item">
            <span className="lg-rankmark">{r.mark}</span>
            {r.label}
          </span>
        ))}
      </div>
    </div>
  );
}
