/**
 * 配色の単一ソース(`[v6.6]` — UIレビュー 07-01「色の単一ソース化」)。
 *
 * これまで地図の色は `render/renderer.ts` の数値定数、HUDの色は `ui/styles.css` の
 * `:root` にあり、同じ色を2箇所で維持していた。凡例が地図とずれる事故はここから出る。
 * 以後、**色はこのファイルにしか無い**:
 *   - three.js は `MAP`(数値)を読む
 *   - CSS は起動時に `applyTheme()` が流し込む `--*` 変数を読む
 *   - モックアップ生成器(`tools/uiMockup.ts`)も同じ `PALETTE` を読む
 *
 * ── 色の役割(UIレビュー 03)──
 * **色相は「誰か」、明度と形は「どうなっているか」**。地形は彩度を落とした乾いた土色に
 * 統一し、彩度を持つのは兵士と統制手段だけにする。意味を持つ色は5つしか置かない:
 *
 *   blue / red … 陣営
 *   warn       … 要処置(負傷・係争・移動命令・要判断)
 *   live       … 操作・選択・搬送(いま人が触っているもの、動いている関係)
 *   safe       … 安定・確保済
 *
 * 状態を増やしたくなったら**色ではなく形**で分ける(記号体系は renderer.ts を参照)。
 * 色を1つ足すたびに、引きの絵で判別できる状態の総数はむしろ減る。
 */

export const PALETTE = {
  // ── 地形: 彩度を殺す ──────────────────────────────────────────────
  /** 屋外の地面。乾いた土 */
  ground: "#9c8763",
  /** 盤外。play area を額装する */
  outOfPlay: "#453c2e",
  /** 建物の壁の天端。日に焼けた漆喰 */
  wall: "#d9c9a4",
  /** 街路の低い遮蔽(塀・土嚢・車列) */
  clutter: "#6a5230",
  /** 建物の床。屋根の下なので日陰 */
  roomFloor: "#6d5f47",
  /** 建物・兵士が落とす影 */
  shadow: "#2b2318",
  /** 閉じた扉。突入口なので地形の中で唯一明度を上げる(仕様 §7.6) */
  doorClosed: "#c2662a",
  /** 開いた扉 */
  doorOpen: "#413524",

  // ── 意味: 5色だけ ────────────────────────────────────────────────
  blue: "#4a8ce6",
  red: "#e8483c",
  /** 要処置: 負傷・係争・移動命令・要判断 */
  warn: "#f2b32a",
  /** 操作・選択・搬送 */
  live: "#35d6f0",
  /** 安定・確保済 */
  safe: "#22c07f",

  /**
   * 迫撃砲(`[v6.9]` 仕様 §10/§11)。**意味を担う5色には数えない。**
   * 5色の規則(2陣営 + warn + live + safe)は「盤上に居続けるもの」の話で、
   * これは0.1〜1.5秒で消える一過性の発光。常設の記号と競合しないので、
   * 遠景での状態の読み取りやすさを損なわない。
   */
  /**
   * 窓(`[v6.10]`、色は `[v6.15]` で入れ替え)。
   *
   * **最初は壁より少し明るい暖色(#e2c98f)にしていたが、壁(#d9c9a4)とほぼ同じ色で
   * 見えなかった。** 地形の色はすべて暖色(砂・土・日干し煉瓦)で固まっているので、
   * その中に暖色をもう1つ足しても沈む。**寒色の暗い色**にすると、明度でも色相でも
   * 離れて「壁に空いた穴」として読める。
   *
   * 扉(#c2662a の橙)とも衝突しない — 扉は暖色の彩度で目立たせ、窓は寒色の明度で
   * 目立たせる、と役割を分けてある。意味を担う5色には数えない(地形の記号であって
   * 兵士の状態ではない)。
   */
  window: "#3a4f5c",

  blastCore: "#fff4d6",
  blastShock: "#ff9a2e",
  blastDust: "#8d7351",

  // ── 無彩の補助(意味を持たない差分) ──────────────────────────────
  /** 戦死。円をやめて×になるので、色は「もう動かないもの」を示すだけ */
  kia: "#3a352b",
  /** 確度が尽きた最終目撃情報(ゴースト) */
  ghost: "#6a6252",
  /** 制圧の外周リング。陣営色を置き換えず、外側に足す */
  suppress: "#f3e8cf",
  /** 階級章の横棒 */
  rank: "#f0e2c2",

  // ── HUD ────────────────────────────────────────────────────────
  /** パネルは1種類だけ。強調は枠線色でのみ作る(UIレビュー 05) */
  panel: "rgba(20, 17, 12, 0.88)",
  border: "#3f382c",
  text: "#ece2cf",
  /** 二次テキスト */
  textDim: "#c9bb9e",
  muted: "#9c8e76",
  /** ラベル・単位など、読まなくてよい文字 */
  faint: "#6f6552",
  /** 入れ子の面(ボタンの地・トラック) */
  surface: "#241e14",
  /** 選択されている面 */
  surfaceHi: "#3d3324",
  /** 最下層の面(孫ノード) */
  surfaceLo: "#1d180f",
  /** ページの地 */
  bg: "#0d0b07",
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** `#rrggbb` → three.js が使う 0xRRGGBB。 */
export function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

/**
 * three.js 用の数値版。**`PALETTE` から導出するので、値の定義は1箇所しかない。**
 * `rgba()` を持つ `panel` はここには入らない(地図では使わない)。
 */
export const MAP = {
  ground: hexToInt(PALETTE.ground),
  outOfPlay: hexToInt(PALETTE.outOfPlay),
  wall: hexToInt(PALETTE.wall),
  clutter: hexToInt(PALETTE.clutter),
  roomFloor: hexToInt(PALETTE.roomFloor),
  shadow: hexToInt(PALETTE.shadow),
  doorClosed: hexToInt(PALETTE.doorClosed),
  doorOpen: hexToInt(PALETTE.doorOpen),
  blue: hexToInt(PALETTE.blue),
  red: hexToInt(PALETTE.red),
  warn: hexToInt(PALETTE.warn),
  live: hexToInt(PALETTE.live),
  safe: hexToInt(PALETTE.safe),
  kia: hexToInt(PALETTE.kia),
  ghost: hexToInt(PALETTE.ghost),
  suppress: hexToInt(PALETTE.suppress),
  window: hexToInt(PALETTE.window),
  blastCore: hexToInt(PALETTE.blastCore),
  blastShock: hexToInt(PALETTE.blastShock),
  blastDust: hexToInt(PALETTE.blastDust),
  rank: hexToInt(PALETTE.rank),
  text: hexToInt(PALETTE.text),
} as const;

/** CSS カスタムプロパティ名 → 値。`applyTheme` と生成器の両方が使う。 */
export function themeCssVars(): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(PALETTE)) {
    // camelCase → kebab-case(`doorClosed` → `--door-closed`)
    v[`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = val;
  }
  return v;
}

/**
 * `:root` へ流し込む。`main.tsx` が React を描く前に一度だけ呼ぶ。
 * CSS 側には `var(--…)` しか書かないこと — 生の16進数を書いた時点で二重管理に戻る。
 */
export function applyTheme(root: HTMLElement): void {
  for (const [name, value] of Object.entries(themeCssVars())) {
    root.style.setProperty(name, value);
  }
}
