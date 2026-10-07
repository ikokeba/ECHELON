/**
 * 編成プリセット(`[v6.9]` 仕様 §2 編成 / §14 MOS)。
 *
 * 陣営ごとに「どれだけの規模を、どんな特技保有者込みで出すか」を選ぶ。ドクトリン
 * (`doctrine.ts`)が**指揮の効き方**を切り替えるのに対し、こちらは**盤上に置く駒そのもの**を
 * 切り替える。両者は直交する — 「非正規軍の中隊」も「正規軍の分隊」も作れる。
 *
 * 設計上の一線は `doctrine.ts` と同じで、**個々の兵士の強さには一切触れない**こと。
 * 変わるのは頭数と、特技保有者(選抜射手・擲弾手・機関銃班)を編成に持つかどうかだけで、
 * 命中率や耐久はどの編成でも同一の `rollShot` を通る。ここに倍率を入れた瞬間、
 * 仕様 §2/§13 の「敵軍は反転した自軍」が成り立たなくなる。
 *
 * 特技を外したときの扱いは「その枠が消える」ではなく「**その枠がライフルマンになる**」。
 * 分隊の頭数を規模だけで決められるようにするため(そうしないと編成ごとに人数が変わり、
 * 「規模は同じなのに人数が違う」という読みにくい盤面になる)。
 */

import type { ReinforcementSpec, Side } from "./types.ts";

/** 出せる部隊の規模。上へ行くほど指揮階層が1つずつ増える(仕様 §2)。 */
export type ForceScale = "squad" | "platoon" | "company";

export interface ForceSpec {
  scale: ForceScale;
  /**
   * 選抜射手(仕様 §14)。分隊に1名、ブラボー組のライフルマンが兼任する。
   * 外すと索敵300m・専用の射撃諸元(§10 `dm`)・支援射撃の優先配置が丸ごと無くなる。
   */
  marksman: boolean;
  /**
   * 擲弾手(仕様 §14)。FTごとに1名、擲弾3発(§8.1)を携行する。
   * 外すと分隊から擲弾が消える — 唯一の弾数管理資源なので、室内戦の掃討力に効く。
   */
  grenadier: boolean;
  /**
   * 火器分隊(仕様 §2 の機関銃班、M240系×2)。小隊直轄の支援火力。
   * 分隊規模には元から存在しない(下の `weapons` との論理積で決まる)。
   */
  weaponsSquad: boolean;
  /**
   * 盾持ち(`[v7.0]`)。各FTのライフルマン1名が防弾盾+拳銃に置き換わり、FTは盾を
   * 先頭にした密集隊形で動く。頭数は変わらない(枠の置き換え)。
   * 衛生要員の兼任は擲弾手(または2人目のライフルマン)の枠へ移り、選抜射手は
   * ブラボー組の擲弾手枠がライフルマンとして引き継ぐ(擲弾手は1名減る)。
   */
  shield?: boolean;
  /**
   * 後援部隊(`[v7.0]`)。未指定・`calls: 0` なら後援なし。数・規模・出現位置は暫定。
   * 盤上の初期の駒ではないが、戦闘の初期条件の一部なので編成に持たせる
   * (初期条件コード `setupCode.ts` にもそのまま畳まれる)。
   */
  reinforcement?: ReinforcementSpec;
}

/** 後援部隊の既定値(UIで「あり」にしたときの出発点)。**暫定値** */
export const DEFAULT_REINFORCEMENT: ReinforcementSpec = {
  calls: 1,
  size: "squad",
  delaySec: 90,
  entry: "rear",
  autoCallBelow: 0.6,
};

/** 規模ごとの編成の形。ここだけが「何個作るか」を知っている。 */
export interface ScaleShape {
  label: string;
  detail: string;
  /** 小隊の数 */
  platoons: number;
  /** 小隊あたりのライフル分隊の数 */
  rifleSquads: number;
  /** 火器分隊を持ち得るか(`ForceSpec.weaponsSquad` と論理積を取る) */
  weapons: boolean;
  /** 小隊本部(小隊長+無線手)を持つか */
  platoonHq: boolean;
  /** 中隊本部(中隊長/XO/無線手/1SG)を持つか */
  companyHq: boolean;
}

/**
 * 各構成要素の頭数。`scenario.ts` の組み立てループと**一致していなければならない**。
 * 二重管理になるので、`test/force.test.ts` が実際に組んだ人数と突き合わせている。
 */
export const HEADCOUNT = {
  /** 分隊長1 + 4名FT×2(makeSquad) */
  rifleSquad: 9,
  /** 分隊長1 + 3名の機関銃班×2(makeWeaponsSquad) */
  weaponsSquad: 7,
  /** 小隊長 + 無線手(makePlatoonHq) */
  platoonHq: 2,
  /** 中隊長/XO/無線手/1SG(makeCompanyHq) */
  companyHq: 4,
} as const;

export const FORCE_SCALES = {
  squad: {
    label: "分隊",
    detail: "9名。分隊長〜FTリーダーの2階層。無線は介さず、視界がそのまま指揮の範囲",
    platoons: 1,
    rifleSquads: 1,
    weapons: false,
    platoonHq: false,
    companyHq: false,
  },
  platoon: {
    label: "小隊",
    detail: "36名。3個ライフル分隊+火器分隊+小隊本部。無線報告で捌く小隊長が加わる",
    platoons: 1,
    rifleSquads: 3,
    weapons: true,
    platoonHq: true,
    companyHq: false,
  },
  company: {
    label: "中隊",
    detail: "112名。3個小隊+中隊本部。CP・CCP・後送を含む5階層すべて",
    platoons: 3,
    rifleSquads: 3,
    weapons: true,
    platoonHq: true,
    companyHq: true,
  },
} as const satisfies Record<ForceScale, ScaleShape>;

export const FORCE_SCALE_KEYS = ["squad", "platoon", "company"] as const;


/** 既定の編成。現行の `companyClashScenario` と厳密に一致する(完全編成の中隊)。 */
export const DEFAULT_FORCE: ForceSpec = {
  scale: "company",
  marksman: true,
  grenadier: true,
  weaponsSquad: true,
};

export function defaultForce(): Record<Side, ForceSpec> {
  return { blue: { ...DEFAULT_FORCE }, red: { ...DEFAULT_FORCE } };
}

/** その編成が盤上に置く人数。UIの表示と、規模から展開線を決めるのに使う。 */
export function forceSize(spec: ForceSpec): number {
  const sh = FORCE_SCALES[spec.scale];
  const perPlatoon =
    sh.rifleSquads * HEADCOUNT.rifleSquad +
    (sh.weapons && spec.weaponsSquad ? HEADCOUNT.weaponsSquad : 0) +
    (sh.platoonHq ? HEADCOUNT.platoonHq : 0);
  return sh.platoons * perPlatoon + (sh.companyHq ? HEADCOUNT.companyHq : 0);
}

/**
 * 両陣営の規模から、展開線を自陣側へどれだけ下げるかの倍率を返す。
 *
 * 盤面(市街地マップ)は中隊規模を前提に作ってあるので、分隊9名を既定の展開線
 * (中央から140m)に置くと、接敵まで1分以上ただ歩くだけの時間になる。**大きいほうの
 * 規模**で決めるのは、両陣営を中央から等距離に保つため — 片側だけ前に出すと
 * 地形由来ではない有利不利が生まれる(仕様 §2/§13)。
 */
export function spawnDepthMul(force: Record<Side, ForceSpec>): number {
  const rank: Record<ForceScale, number> = { squad: 0, platoon: 1, company: 2 };
  const larger = rank[force.blue.scale] >= rank[force.red.scale] ? force.blue.scale : force.red.scale;
  return { squad: 0.3, platoon: 0.55, company: 1 }[larger];
}
