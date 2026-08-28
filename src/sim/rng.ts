/**
 * シミュレーション用の決定論的疑似乱数生成器。
 *
 * プロトタイプのモックはすべて `Math.random()` を使っていたが、それではリプレイ・
 * 回帰テスト・戦力対称性の検証が成立しない。統合シムでは**すべての乱数**を
 * ワールド状態が保持する1本のシード付きストリームに通す。`src/sim/` 配下では
 * `Math.random` を ESLint で禁止している。
 *
 * アルゴリズムは mulberry32 — 小さく高速で、ゲーム用途には十分。暗号用途には不可。
 */

export interface Rng {
  /** 32bitの生状態。シリアライズ可能なので、リプレイもスナップショットも厳密に再現できる */
  state: number;
}

export function createRng(seed: number): Rng {
  // uint32 へ丸める
  return { state: seed >>> 0 };
}

/** ストリームを1つ進めて [0, 1) の実数を返す。`rng` を破壊的に更新する。 */
export function next(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) | 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [min, max) の実数。 */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + next(rng) * (max - min);
}

/** [min, max] の整数(両端を含む)。 */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(next(rng) * (max - min + 1));
}

/** 確率 p (0..1) で true。 */
export function chance(rng: Rng, p: number): boolean {
  return next(rng) < p;
}

/**
 * 毎秒あたりの発生率を、1ティックあたりの確率へ変換する(ポアソン的な事象を想定)。
 * mos-balance モックは命中率・制圧率を「0.2秒ティックあたり」で表現していたが、
 * 統合シムのティックレートは異なる。そのため constants.ts では毎秒あたりで保持し、
 * ここでティック単位へ再量子化する。
 */
export function ratePerTick(ratePerSecond: number, dtSeconds: number): number {
  return 1 - Math.exp(-ratePerSecond * dtSeconds);
}

/** 一様に1要素を選ぶ。空配列なら undefined。 */
export function pick<T>(rng: Rng, arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(next(rng) * arr.length)];
}
