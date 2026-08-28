/**
 * シミュレーションのコア型定義。純粋なデータのみ — 振る舞いも three.js も DOM も持たない。
 *
 * 座標系の規約(プロトタイプのモックから変更なし):
 *   X/Z が地表平面、Y が上方向、単位はメートル。
 *   壁は軸平行ボックス { cx, cz, hw, hd }(中心 + 半径)。
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** 地表平面上の軸平行な壁・障害物ボックス。 */
export interface AABB {
  cx: number;
  cz: number;
  /** X方向の半幅 */
  hw: number;
  /** Z方向の半奥行き */
  hd: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 所属陣営。両陣営は機構的に完全同一(仕様 §2, §13)。 */
export type Side = "blue" | "red";

/** 5つの指揮階層(仕様 §2)。 */
export type Echelon = "company" | "platoon" | "squad" | "fireteam" | "soldier";

/** ファイアチームリーダーAIが発行する兵士単位の命令(仕様 §1 [v5], §6)。 */
export type SoldierOrderKind =
  | "move"
  | "hold"
  | "suppress"
  | "maneuver"
  | "retreat"
  | "evade";

/** FTリーダーのステートマシンのモード(仕様 §1 [v5] — これ自体が「命令システム」)。 */
export type FireteamMode = "ADVANCE" | "CONTACT" | "SEARCH" | "FALLBACK";

/** 分隊長/小隊長が選択する屋外の移動技術(仕様 §6)。 */
export type MovementTechnique = "traveling" | "traveling_overwatch" | "bounding_overwatch";

/**
 * 生存状態のみを表す。制圧は status ではない — 余韻を持たない一律の命中率低下効果
 * (仕様 §8.6)であり、`suppressedUntilTick` で管理する。
 */
export type SoldierStatus = "ok" | "wia" | "kia";

export interface SoldierOrder {
  kind: SoldierOrderKind;
  /** move/maneuver/retreat/evade の目的地 */
  target?: Vec2;
  /** hold/suppress の照準・監視方向(単位ベクトル) */
  facing?: Vec2;
  /** この命令が発行されたティック(陳腐化判定・デバッグ用) */
  issuedTick: number;
}

/**
 * 兵士1名。シミュレーション上の最小実体。
 * 分隊以上の階層は**コントローラ**(c2/ 配下)であって、身体を持つ実体ではない —
 * ただし指揮官本人の兵士は例外的にユニットとして戦場に存在する。
 */
export interface Soldier {
  id: number;
  side: Side;
  /** 所属小隊のID */
  platoonId: number;
  /** 所属分隊のID */
  squadId: number;
  /** 分隊内のファイアチームID(0 または 1。分隊長枠は -1) */
  fireteamId: number;
  /** このFTのリーダーである兵士なら true */
  isFireteamLeader: boolean;
  /** この分隊の分隊長である兵士なら true */
  isSquadLeader: boolean;

  pos: Vec2;
  /** 向き。地表平面上の単位ベクトル */
  facing: Vec2;
  status: SoldierStatus;

  /** 制圧状態が解けるティック(0 = 非制圧) */
  suppressedUntilTick: number;
  /** WIAがKIAへ移行するティック(0 = 該当なし) */
  bleedOutTick: number;

  order: SoldierOrder;
  /** 現在の経路(ウェイポイント列)。先頭から順に消費する */
  path: Vec2[];
  pathIdx: number;

  /**
   * このティックに本人が直接視認できている敵兵士のID(距離+視界扇形+LOS、仕様 §5)。
   * 一時的な値で、毎ティック perceptionSystem が再構築する。
   */
  sees: number[];
  /** 「制圧役」状態(仕様 §8.6)。命令またはAIの自律判断で立つ */
  suppressor: boolean;

  /** 個体差パラメータ(仕様 §14)。各 0..1 */
  traits: SoldierTraits;
}

export interface SoldierTraits {
  aggressiveness: number;
  boldness: number;
  caution: number;
}

/**
 * ある階層の world picture に含まれる1件の接触情報(仕様 §5)。Soldier への直接参照
 * では**ない** — 時間とともに減衰する、古くなりうる観測結果である。
 */
export interface Contact {
  /** 安定キー。同一対象の再観測が重複ではなく更新になるように */
  key: string;
  side: Side;
  /** 最終目撃位置 */
  pos: Vec2;
  /**
   * 位置誤差の概算半径(m)。`hopError + 経過時間 × 拡大率` で毎ティック再計算される。
   * 描画上は最終目撃位置を中心とする不確度円になる(仕様 §5)。
   */
  posError: number;
  /**
   * 無線を1ホップ経るごとに加算される、時間経過とは無関係な粒度の粗さ(m)。
   * 仕様 §5「中隊長は…さらに遅延・粒度が粗くなる」を表現する。
   * 直接視認した接触では0。
   */
  hopError: number;
  /** この接触情報の元になった最新の観測ティック */
  lastSeenTick: number;
  /** 0..1。lastSeenTick からの経過で毎ティック減衰(仕様 §5: 30秒→.8 / 90秒→.5 / 180秒→0) */
  confidence: number;
  /** 判明していれば目撃した人数 */
  count?: number;
}

/** 階層コントローラが持つ、報告のみから構築された私的な world picture(仕様 §5)。 */
export interface Belief {
  contacts: Map<string, Contact>;
}

/**
 * 指揮系統を上へ伝わる無線報告(仕様 §5)。到達には遅延がある。
 *
 * 中身は送信時点の接触情報のスナップショットである。受信側のbeliefへ統合された
 * あとも確度は減衰し続けるため、上位階層ほど古く粗い情報を持つことになる。
 */
export interface Report {
  fromEchelon: Echelon;
  /** 送信元ユニットの識別子(分隊なら squadId、小隊なら platoonId) */
  fromUnitId: number;
  /** 宛先ユニットの識別子 */
  toUnitId: number;
  side: Side;
  /** 報告が生成されたティック */
  sentTick: number;
  /** 受信側が読めるようになるティック(sentTick + 遅延) */
  deliverTick: number;
  contacts: Contact[];
  /** 送信元自身の戦力・状況サマリ(SALUTE報告の S/L に相当) */
  ownStatus: {
    effective: number;
    total: number;
    posCentroid: Vec2;
  };
}

/** 1個ファイアチームに対するシナリオ側の意図。コントローラの初期化に使う。 */
export interface FireteamPlan {
  side: Side;
  squadId: number;
  ftIndex: number;
  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;
}

/**
 * 分隊長コントローラの状態(仕様 §3 ③)。
 *
 * `belief` は麾下2個FTの視界の**合算**である(仕様 §5)。分隊長は無線を介さず
 * 直接この情報を得る — 仕様が生の視界の共有を認めているのはこの階層までで、
 * 小隊長より上は報告のみになる。
 */
export interface SquadState {
  id: number;
  side: Side;
  squadId: number;
  platoonId: number;

  /** 分隊長の world picture(麾下FT視界の合算) */
  belief: Map<string, Contact>;

  /** 小隊長から指示された移動技術(仕様 §6)。麾下FTへそのまま流す */
  technique: MovementTechnique;
  /** 小隊長から割り当てられた任務目標 */
  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;

  /** 上位(小隊)へ最後に定時報告を送ったティック */
  lastReportTick: number;
}

/**
 * 小隊長コントローラの状態(仕様 §3 ②)。
 *
 * `belief` は**無線報告のみ**から構築される(仕様 §5)。麾下分隊の生の視界は
 * 一切参照しない。したがって小隊長の world picture は本質的に分隊長のそれより
 * 古く粗い — この非対称性こそが階層構造の遊びを生む。
 */
export interface PlatoonState {
  id: number;
  side: Side;
  platoonId: number;

  /** 小隊長の world picture(無線報告のみ、遅延と確度減衰を伴う) */
  belief: Map<string, Contact>;

  /** 麾下分隊へ割り当てた任務目標 */
  squadObjectives: Map<number, Vec2>;
  /** 麾下分隊へ指示した移動技術 */
  squadTechniques: Map<number, MovementTechnique>;

  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;

  lastReportTick: number;
  lastDecisionTick: number;
}

/** 1個分隊に対するシナリオ側の意図。 */
export interface SquadPlan {
  side: Side;
  squadId: number;
  platoonId: number;
  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;
}

/** 1個小隊に対するシナリオ側の意図。 */
export interface PlatoonPlan {
  side: Side;
  platoonId: number;
  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;
}

/**
 * ファイアチームのコントローラ状態 — 「命令システム」のノード(仕様 §1 [v5])。
 * squad-12v12 モックの分隊単位ステートオブジェクトから移植。`memory` はFTリーダーの
 * world picture であり、隷下隊員の視界の合算(仕様 §5)が時間とともに減衰したもの。
 */
export interface FireteamState {
  id: number;
  side: Side;
  squadId: number;
  /** 分隊内での序数(0 または 1) */
  ftIndex: number;

  mode: FireteamMode;
  /** 現在のモードに入ったティック(ヒステリシス=最小滞留時間の判定用) */
  modeSince: number;

  /** このレグで躍進する側のバディペア */
  boundingLeg: "alpha" | "bravo";
  /** 現在の躍進先。到達するまで変更しない(モックの「決めたら変えない」規則) */
  boundTarget: Vec2 | null;
  /** CONTACT時にベース・オブ・ファイアを担当する側のペア */
  baseElement: "alpha" | "bravo";

  /** 兵士ごとの目的地キャッシュと決定ティック(ばたつき防止。モックの挙動) */
  unitDest: Map<number, Vec2>;
  unitDestSince: Map<number, number>;

  /** FTリーダーの接触情報の記憶 */
  memory: Map<string, Contact>;
  /** 接敵をロストした後に掃討する地点 */
  searchPoint: Vec2 | null;

  /** このFTが最終的に目指す地点(任務目標)。分隊長から下ろされる */
  objective: Vec2;
  /** 全体の前進方向。後退方向や展開の基準に使う */
  advanceDir: Vec2;
  /** 後退時の集結地点 */
  rallyPoint: Vec2;

  /** 分隊長から指示された移動技術(仕様 §6)。ADVANCE時の動き方を決める */
  technique: MovementTechnique;
  /**
   * 接敵時に分隊長から割り当てられた役割(仕様 §6 Fire and Movement)。
   * `base` = ベース・オブ・ファイア(制圧担当)、`maneuver` = 機動担当。
   * null は未割り当て(接敵していない、または分隊長が健在でない)。
   */
  assignedRole: "base" | "maneuver" | null;
}

export interface Scenario {
  name: string;
  seed: number;
  bounds: Bounds;
  walls: AABB[];
  /** 初期配置の兵士(完全指定) */
  soldiers: Soldier[];
  /** FTごとの任務目標。未指定のFTはマップ中心にフォールバックする */
  fireteamPlans?: FireteamPlan[];
  /** 分隊ごとの任務目標 */
  squadPlans?: SquadPlan[];
  /** 小隊ごとの任務目標 */
  platoonPlans?: PlatoonPlan[];
  /** 参照・描画用の統制手段(仕様 §6): チェックポイント・フェーズライン・目標 */
  controlMeasures?: ControlMeasure[];
}

export interface ControlMeasure {
  kind: "CP" | "PL" | "OBJ";
  label: string;
  /** CP/OBJ は点、PL は折れ線 */
  points: Vec2[];
}
