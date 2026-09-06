import { useSimStore } from "./store.ts";

/**
 * 下レール — 地図の凡例(`[v6.5]`、`[v6.6]` で記号体系の変更を反映)。
 *
 * 兵士1点は「**陣営 × 状態 × 階級**」の3層でできている。状態は色を増やすのではなく
 * 塗り / 抜き / 輪の追加で表すので、凡例も「色見本の並び」ではなく**記号の見本**にする。
 *
 * ここの記号はCSSで地図の記号を再現したもの。地図側の実体は `render/renderer.ts`
 * (`discMesh` / `bodyRingMesh` / `haloRingMesh` / `kiaMesh`)。
 * **作り方を変えたら両方を直すこと** — 凡例が地図とずれた時点で凡例は嘘になる。
 * 色そのものは `src/theme.ts` の1本から来ているので、色だけがずれることはない。
 */

interface Item {
  /** `.lg-g` に足すクラス。記号の作り方 */
  cls: string;
  label: string;
  /** 陣営色などインライン指定が要るもの */
  style?: React.CSSProperties;
  title?: string;
}

const SOLDIER_ITEMS: Item[] = [
  {
    cls: "lg-fill",
    label: "健常",
    style: { background: "var(--blue)" },
    title: "陣営色のベタ塗り。これだけが動ける兵",
  },
  {
    cls: "lg-fill lg-halo",
    label: "制圧",
    style: { background: "var(--blue)" },
    title: "陣営色はそのまま、外周に白リング。命中率 −40%(仕様 §8.6)",
  },
  { cls: "lg-ring", label: "出血", title: "黄の抜き円。45秒以内に手当がないと戦死(仕様 §9)" },
  { cls: "lg-ring-core", label: "止血済", title: "同じ抜き円に緑の芯。処置は済み、後送待ち" },
  {
    cls: "lg-fill lg-inner",
    label: "担架班",
    style: { background: "var(--blue)" },
    title: "運ぶ側。水色の内リング + 負傷者への線",
  },
  { cls: "lg-line", label: "搬送", title: "運ぶ側と運ばれる側を結ぶ関係の線(仕様 §9)" },
  { cls: "lg-cross", label: "戦死", title: "円をやめた暗い×。形が変わるので引きでも読める" },
];

const MARKER_ITEMS: Item[] = [
  {
    cls: "lg-diamond",
    label: "最終目撃",
    title: "実体ではなく報告された最終目撃位置。薄いほど確度が低い(仕様 §5)",
  },
  { cls: "lg-dash", label: "不確度", title: "破線の円。時間とともに半径が開く(仕様 §5)" },
  { cls: "lg-obj", label: "拠点", title: "中立=緑 / 係争=黄 / 確保=陣営色(仕様 §12)" },
  {
    cls: "lg-window",
    label: "窓",
    title:
      "視線は通すが人は通さない開口(仕様 §7)。窓に就いて撃つ側は被命中 −60% / 命中 +30%"
      + " なので、建物を抱えた側が守りで有利になる(仕様 §8)",
  },
  {
    cls: "lg-incoming",
    label: "着弾まで",
    title:
      "迫撃砲の射撃任務。縮むリングが照準点で、色は撃っている側。砲は敵を見ておらず、"
      + "中隊長の(古い)像へ撃つので、着弾したときそこに敵がいるとは限らない(仕様 §5/§10)",
  },
  {
    cls: "lg-obj",
    label: "操作中",
    style: { borderColor: "var(--text)" },
    title: "人が操作しているユニット",
  },
  {
    cls: "lg-obj",
    label: "選択・麾下",
    style: { borderColor: "var(--live)" },
    title: "指揮官を選ぶと麾下が光る(仕様 §12 の継承結果)",
  },
  {
    cls: "lg-hline",
    label: "前線",
    title:
      "指揮官が持っている前線(FLOT、米軍 ADP 1-02)。**直線ではなく、部下の報告位置を"
      + "結んだ折れ線** — 突出したところで前へ膨らみ、遅れたところで引っ込む。太い線が"
      + "中隊長の(小隊3個ぶんの)線、細い線が各小隊長の(分隊ぶんの)線で、階層ごとに"
      + "解像度が違う。報告からしか引かないので兵士の実際の位置とずれる — ずれて"
      + "見えるのが正しい(仕様 §5)",
  },
  {
    cls: "lg-hline lg-hline-fscm",
    label: "火力統制線",
    title:
      "ここより手前へは迫撃砲を撃たない線(FSCM)。前線を危険近接ぶん前へ押し出したもの。"
      + "判定は線からの距離で行うので、側面へ張り出した部隊も守られる(仕様 §8.2/§11)",
  },
  {
    cls: "lg-fill",
    label: "閉じた扉",
    style: { background: "var(--door-closed)", borderRadius: "2px", width: "5px" },
    title: "視線も移動も遮る。突入はここからだけ(仕様 §7.6)",
  },
];

/** 階級は「円の上の横棒」。本数と長さで4階級(`[v6.6]` UIレビュー 診断D)。 */
const RANK_ITEMS: Array<{ bars: number; long: boolean; label: string }> = [
  { bars: 1, long: false, label: "FT長" },
  { bars: 2, long: false, label: "分隊長" },
  { bars: 2, long: true, label: "小隊長" },
  { bars: 3, long: true, label: "中隊長" },
];

function Glyph({ item }: { item: Item }) {
  return (
    <span className="lg-item" title={item.title}>
      <span className={`lg-g ${item.cls}`} style={item.style} />
      {item.label}
    </span>
  );
}

export function Legend() {
  const open = useSimStore((s) => s.legendOpen);
  const toggle = useSimStore((s) => s.toggleLegend);
  const control = useSimStore((s) => s.control);

  if (!open) {
    return (
      <button type="button" className="lg-open" onClick={toggle} title="凡例 (L)">
        凡例 L
      </button>
    );
  }

  return (
    <div className="panel legend">
      <div className="panel-cap">
        <span>LEGEND</span>
        <span>
          凡例 L ／ デバッグ H ／ 配置 G ／ 一時停止 Space
          {control && " ／ 右クリック 移動命令"}
        </span>
      </div>
      <div className="lg-row">
        <span className="lg-cap">兵士</span>
        {SOLDIER_ITEMS.map((it) => (
          <Glyph key={it.label} item={it} />
        ))}
      </div>
      <div className="lg-row">
        <span className="lg-cap">標識</span>
        {MARKER_ITEMS.map((it) => (
          <Glyph key={it.label} item={it} />
        ))}
      </div>
      <div className="lg-row">
        <span className="lg-cap">階級</span>
        {RANK_ITEMS.map((r) => (
          <span key={r.label} className="lg-item">
            <span className={r.long ? "rank-bars rank-long" : "rank-bars rank-short"}>
              {Array.from({ length: r.bars }, (_, i) => (
                <i key={i} />
              ))}
            </span>
            {r.label}
          </span>
        ))}
        <button type="button" className="btn-x" onClick={toggle} title="閉じる (L)">
          ×
        </button>
      </div>
    </div>
  );
}
