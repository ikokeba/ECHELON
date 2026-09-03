/**
 * 陣営のドクトリン(指揮文化)プリセット。`[v6.8]` 仕様 §13。
 *
 * 仕様 §2/§13 が要求するのは「**両陣営が同一の機構で動く**」ことであって、
 * 「両陣営が同じ組織である」ことではない。ここで切り替えるのは兵士の能力値ではなく、
 * **指揮系統の効き方**だけ:
 *
 *   - 各階層がどれくらいの間隔で判断し直すか(`decideMul`)
 *   - 無線報告がどれくらい遅れて届くか(`radioLatencyMul`)
 *   - 下から上へどれくらいの頻度で報告が上がるか(`reportIntervalMul`)
 *   - 下位が「上から降りてきた目標」より「自分が見ているもの」をどれだけ優先するか
 *     (`initiative`)
 *
 * **能力ではなく統制の差**にしてあるのが要点。「精鋭は命中率が高い」にしてしまうと、
 * 仕様 §13 の「敵軍は反転した自軍」という担保が崩れ、勝敗が編成ではなく係数で決まる。
 * 統制の差なら、非正規軍でも局地では正規軍を食えるし、正規軍は連携で押し返す。
 *
 * すべて `regular` を基準(全係数 identity)にしてあるので、**既定では現行の挙動と
 * 厳密に一致する** — 対称性テストも決定論テストもここに触れない。
 */

import type { Side } from "./types.ts";

export interface Doctrine {
  /** UIに出す名前 */
  label: string;
  /** 一行説明 */
  detail: string;
  /**
   * 意思決定周期の倍率(階層別)。**大きいほど判断が遅い**。
   * 中隊長6.0秒・小隊長2.0秒・分隊長0.3秒(仕様 §3)にこれを掛ける。
   */
  decideMul: { company: number; platoon: number; squad: number };
  /** 無線1ホップの遅延倍率(仕様 §5)。大きいほど上位の地図が古くなる */
  radioLatencyMul: number;
  /** 定時報告の間隔倍率(仕様 §5)。大きいほど報告が疎になる */
  reportIntervalMul: number;
  /**
   * 自主性 0..1。下位が上位の任務目標をどれだけ「自分の判断」で上書きするか。
   *
   * 0   上位の指示どおり(正規軍)
   * 1   自分が見ている脅威がすべて。上からの目標は事実上無視
   *
   * 実装は目標地点の線形補間なので連続的で決定論的。乱数は引かない
   * (引くと仕様 §2/§13 の鏡像性が壊れる)。
   */
  initiative: number;
  /** 既定のリスク許容度(`Posture` のマスター、0.5 が identity) */
  riskTolerance: number;
  /**
   * 火力支援の保有比 0..1(仕様 §10/§11)。`[v6.9]`
   * 中隊が持つ迫撃砲弾に掛かる。0 なら火力支援そのものを持たない。
   *
   * ここが**能力ではなく組織の差**であることに注意 — 弾が当たりやすくなるのではなく、
   * 「後方から支援を呼べる建制があるかどうか」の違い。自律群は各要素が目の前に
   * 反応するだけなので、後方の砲へ要請が上る経路そのものが無い。
   */
  fireSupport: number;
}

export const DOCTRINES = {
  /** 現行の挙動そのもの。米軍型の正規軍(全係数 identity) */
  regular: {
    label: "正規軍",
    detail: "米軍型。5階層のC2が機能し、報告と命令が滞りなく流れる",
    decideMul: { company: 1, platoon: 1, squad: 1 },
    radioLatencyMul: 1,
    reportIntervalMul: 1,
    initiative: 0,
    riskTolerance: 0.5,
    fireSupport: 1,
  },
  /**
   * 非正規軍。上位の統制は緩いが、現場は勝手に戦える。
   * 中隊長の判断は滅多に更新されず、無線も遅い。そのぶん分隊は自分の判断で動く。
   */
  militia: {
    label: "非正規軍",
    detail: "上位の統制が緩い。命令の更新が遅く報告も疎で、分隊は現場判断で動く",
    decideMul: { company: 2.5, platoon: 1.8, squad: 1.0 },
    radioLatencyMul: 2.5,
    reportIntervalMul: 2.0,
    initiative: 0.45,
    riskTolerance: 0.42,
    // 呼べるが遅い。要請が上るのにも許可が下りるのにも時間が掛かる
    fireSupport: 0.5,
  },
  /**
   * 各兵士が自己判断する陣営。指揮系統は名目上あるが、ほとんど機能しない。
   * 目の前の敵に各自が反応する群れで、全体の連携は起きない代わりに反応は速い。
   */
  swarm: {
    label: "自律群",
    detail: "指揮系統がほぼ機能しない。各隊が目の前の敵に各自で反応する",
    decideMul: { company: 5, platoon: 3, squad: 0.8 },
    radioLatencyMul: 4,
    reportIntervalMul: 3,
    initiative: 0.9,
    riskTolerance: 0.62,
    // 後方の砲へ要請が上る経路そのものが無い(仕様 §13)
    fireSupport: 0,
  },
} as const satisfies Record<string, Doctrine>;

export type DoctrineKey = keyof typeof DOCTRINES;

export const DOCTRINE_KEYS = Object.keys(DOCTRINES) as DoctrineKey[];

/**
 * 既定は両陣営とも正規軍 = 全係数 identity(現行の挙動と厳密に一致)。
 *
 * `World` が持つのは**解決済みのオブジェクト**でキーではない。プリセット名に縛られず
 * 任意の係数を注入できるので、「どの係数が効いているのか」を1つずつ切り分けて
 * 計測できる(実際に鏡像性が崩れた原因の特定に使った)。
 */
export function defaultDoctrine(): Record<Side, Doctrine> {
  return { blue: DOCTRINES.regular, red: DOCTRINES.regular };
}

export function doctrineOf(key: DoctrineKey): Doctrine {
  return DOCTRINES[key];
}
