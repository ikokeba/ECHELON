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
  | "evade"
  /**
   * 集合・追従(仕様 §6.5)。`move` とは明確に別物で、仕様も分けている:
   * 「移動」は1回限りの目的地指定、「集合・追従」は継続的な相対追従。
   * 目標位置は毎ティック再計算される隊形位置なので、経路探索は通さず直接近づく。
   */
  | "follow";

/**
 * FTリーダーのステートマシンのモード(仕様 §1 [v5] — これ自体が「命令システム」)。
 *
 * `CQB` は仕様 §7.3 が「室内クリアリング中は専用モードとして扱い、ADVANCE/CONTACT/
 * SEARCH/FALLBACK のいずれとも異なる」と明記しているため、5つ目の状態として持つ。
 */
export type FireteamMode = "ADVANCE" | "CONTACT" | "SEARCH" | "FALLBACK" | "CQB" | "ROUT";

/**
 * 突入待機命令の3段階(仕様 §7.3)。`CQB` モードの内部進行。
 *   stack   : 指定扉から1.5m以内に集合、壁沿いに縦列で待機
 *   bang    : `[v7.2]` 扉を開けてフラッシュバンを投げ込み、炸裂を待つ(仕様 §8.4)。
 *             持っていなければこの段は飛ばす
 *   breach  : ドクトリン準拠の順序で室内へ進入開始(単一ファイル、0.6秒間隔)
 *   clear   : 先頭2名が近傍コーナーを制圧、後続が危険地帯を索敵
 *   reorg   : 再編成(次の部屋/建物への行動判断は分隊長、仕様 §7.2)
 */
export type CqbStage = "stack" | "bang" | "breach" | "clear" | "reorg";

/** 分隊長/小隊長が選択する屋外の移動技術(仕様 §6)。 */
export type MovementTechnique = "traveling" | "traveling_overwatch" | "bounding_overwatch";

/**
 * 任務の種別(WHAT。仕様 §3①/§4)。`[v6.1]`
 *
 * 従来は「目的地(点)」しか下ろせなかったため、確保も支援射撃も掩護も同じ「そこへ行け」
 * になっていた。上位AI(および将来は人間)がこの3種のどれかを下ろし、下位はそれに沿って
 * 目的地の意味を解釈する。
 *   seize          : 到達して確保・保持する(拠点確保、突撃)
 *   support_by_fire : 目標へ射線の通る位置に就いて制圧する。目標の上には乗らない
 *   screen         : 目標(軸線)に沿って広く展開し、監視・遅滞する。踏み込まない
 */
export type MissionKind = "seize" | "support_by_fire" | "screen";

export interface Mission {
  kind: MissionKind;
  /** 任務の対象地点(seize=確保点 / support_by_fire=制圧目標 / screen=掩護軸の中心) */
  target: Vec2;
}

/**
 * シミュレーションの局面(`[v6.5]`)。
 *
 * `planning` = 戦闘開始前の作戦立案。時間は止まっており、`stepWorld` は何もしない。
 * 中隊長が拠点に対する計画を立て、プレイヤーがそれを見てから戦闘を始める
 * (仕様 §3① / §11 — 米陸軍の指揮活動手順 TLP に対応)。
 */
export type SimPhase = "planning" | "battle";

/**
 * 戦闘の型(仕様 §12「モード別の追加条件」)。`[v6.8]`
 *
 * `meeting`  遭遇戦。全拠点が中立から始まり、過半数を一定時間保持した側が勝つ。
 *            両陣営の勝利条件が同一なので、§2/§13 の対称性がそのまま成り立つ
 * `assault`  攻防非対称戦。**防御側が最初から全拠点を保有**し、攻撃側は制限時間内に
 *            過半数を奪って保持しなければならない。時間切れは防御側の勝ち。
 *            勝利条件が左右で違う唯一のモードなので、対称性テストはこれを使わない
 */
export type BattleMode = "meeting" | "assault";

/**
 * 作戦計画の1項目 = 1個小隊に与える任務(`[v6.5]`)。
 *
 * 中隊長が下ろすのは「どこへ行け」ではなく**任務(WHAT)**である、という §3① /
 * 任務種別の方針をそのまま形にしたもの。目標地点は任務に付随する情報にすぎない。
 */
export interface PlanTask {
  platoonId: number;
  /**
   * 戦闘序列上の位置づけ(ADP 3-90)。
   *   main       = 主攻。勝敗を決める拠点に充てる1個小隊
   *   supporting = 助攻。自正面の拠点確保、または主攻への支援射撃
   *   reserve    = 予備。拠点より小隊が多いときに後方で待機する
   */
  role: "main" | "supporting" | "reserve";
  mission: Mission;
  /** 対象の拠点id(拠点に紐づかない任務は null) */
  objectiveId: number | null;
  /**
   * 接近経路(axis of advance)。出発地点から目標までの折れ線。
   * ナビグリッド上の実経路を単純化したもので、UIの矢印であると同時に
   * 小隊の初期前進軸(`advanceDir`)の出どころでもある。
   */
  route: Vec2[];
  /** 命令の一文(日本語)。UIにそのまま出す */
  order: string;
  /**
   * 経由点(`[v7.3]` ロードマップ A-1)。人間・LLM が描いた接近経路。小隊はこれを順に
   * 通ってから任務の目標へ向かう。AI の案には無い(AI は最短の経路を通る)
   */
  via?: Vec2[];
  /** いま向かっている経由点の番号(`[v7.3]`)。`via` を通り終えたら `via.length` */
  viaIdx?: number;
  /** 開始時刻 = 戦闘開始から何秒後に動き出すか(`[v7.3]` H時)。それまでは出発地点で待つ */
  startSec?: number;
  /** 最後に小隊へ下ろした作戦の段階(`[v7.3]`。"wait" / "viaN" / "pl" / "mission") */
  legKey?: string;
}

/**
 * 射撃計画の1件(`[v7.3]` ロードマップ A-1)。戦闘開始から `atSec` 秒後に、中隊長が
 * `target` へ迫撃砲を要請する。要請はAIの中隊長・人間・LLM と同じ `requestFireMission`
 * を通るので、弾・指揮所・要請間隔・射程・危険近接はすべて同じに掛かる
 */
export interface PlannedFire {
  target: Vec2;
  atSec: number;
  /** 要請を出し終えた(または時機を逸して取りやめた) */
  done?: boolean;
}

/**
 * 作戦の書き換え1件(`[v7.3]` ロードマップ A-1)。人間・LLM が立案中に、中隊長の座席から
 * AI の案の上に重ねる。初期条件コードに載る(P3)ので、同じコードからは同じ作戦になる。
 *   task      : 小隊の任務(種別と対象の拠点)。`reserve` は予備(集結地点で待機)
 *   main      : 主攻(防御なら主陣地)にする拠点
 *   route     : 小隊の経由点。空なら AI の経路
 *   start     : 小隊の開始時刻(戦闘開始からの秒)
 *   phaseLine : 調整線。2点の線分。null で消す
 *   fires     : 射撃計画(全件を置き換える)
 */
export type PlanEdit =
  | { side: Side; op: "task"; platoonId: number; mission: MissionKind | "reserve"; objectiveId: number | null }
  | { side: Side; op: "main"; objectiveId: number }
  | { side: Side; op: "route"; platoonId: number; via: Vec2[] }
  | { side: Side; op: "start"; platoonId: number; startSec: number }
  | { side: Side; op: "phaseLine"; line: [Vec2, Vec2] | null }
  | { side: Side; op: "fires"; fires: Array<{ target: Vec2; atSec: number }> };

/**
 * 中隊長が戦闘前に立てる作戦(`[v6.5]`)。
 *
 * **敵情は一切使わない。** 立案時点で belief は空であり、そこを覗く実装にすると
 * 仕様 §5 の情報階層が最初の1手で崩れる。地形・拠点・自軍の配置だけで組む。
 */
export interface OperationPlan {
  side: Side;
  companyId: number;
  /** 主効の対象拠点id(拠点が無ければ null) */
  mainObjectiveId: number | null;
  tasks: PlanTask[];
  /** 企図(commander's intent)の一文。UIの見出しに使う */
  intent: string;
  /**
   * 調整線(`[v7.3]` ロードマップ A-1、phase line)。麾下の小隊はこの線の手前で止まり、
   * 任務を持つ全小隊が線に着いたら(または待ちきれなくなったら)揃って越える
   */
  phaseLine?: [Vec2, Vec2] | null;
  /** 調整線に最初の小隊が着いたティック / 線を越えてよくなったティック(`[v7.3]`) */
  phaseLineFirstTick?: number | null;
  phaseLineLiftedTick?: number | null;
  /** 射撃計画(`[v7.3]` ロードマップ A-1) */
  fires?: PlannedFire[];
  /** 人間・LLM が書き換えた作戦か(`[v7.3]`)。UI の見出しに出す */
  edited?: boolean;
}

/**
 * 生存状態のみを表す。制圧は status ではない — 余韻を持たない一律の命中率低下効果
 * (仕様 §8.6)であり、`suppressedUntilTick` で管理する。
 */
export type SoldierStatus = "ok" | "wia" | "kia";

/**
 * 後送(担架搬送)の進行状態(仕様 §9)。
 *
 * `none` → 分隊長の後送命令で `requested` → 担架班が収容して `carrying`
 * → CCP到達で `evacuated`(以後戦場から離脱、生存者としてカウント)
 * → 後送アセットが収容して `collected`(同じMOSの補充兵1名が分隊へ合流、仕様 §9)。
 *
 * 応急手当が命令不要の自律トリガーであるのに対し、**担架搬送は明示的な命令を要する**
 * (仕様 §9)。この差が「止血はするが後送は指揮判断」という戦術的トレードオフを作る。
 */
export type EvacStage = "none" | "requested" | "carrying" | "evacuated" | "collected";

/**
 * FT内の役割(仕様 §14 のMOS)。mos-balance-simulator が検証した4名編成に対応する。
 * 戦闘性能に効くのは SAW(制圧効果) と 擲弾手(遮蔽無視) のみで、それ以外は同一。
 *
 * `[v6.1]` `"mg"` は火器分隊(小隊直轄の機関銃班、M240系×2、仕様 §2)の射手。
 * SAW をさらに強めた持続制圧火器: 制圧の行動抑制が強く、交戦距離が長く、移動射撃が苦手。
 *
 * `[v7.0]` `"shield"` は盾持ち(防弾盾+拳銃)。編成オプションで各FTのライフルマンと
 * 置き換わる。正面からの被弾を大きく減らし、真後ろの味方を盾の陰に入れる(constants `SHIELD`)。
 */
export type SoldierRole = "leader" | "saw" | "grenadier" | "rifleman" | "mg" | "shield";

/**
 * 本部要員の職(仕様 §2)。ライフル分隊の外側にいる、指揮系統そのものを担う人員。
 *
 * 仕様 §2 は中隊本部を「役割ごとに固定配置。いずれも直接操作は不可(NPC的に待機)」と
 * 定めている。ただし**中隊長本人は §3① のプレイ対象**なので、直接操作の可否は
 * `hqRole` ごとに分かれる(`co` と `pl` のみ操作可能)。
 *
 * 小隊本部は仕様 §2 の編成表にあるが人員構成の明示がないため、小隊長+無線手の
 * 2名編成とした(`[v6]`)。身体を持たせる目的は §12 の指揮官排除を成立させること —
 * 排除できない指揮官では「指揮系統の崩壊」が近道条件として機能しない。
 */
export type HqRole = "co" | "xo" | "coRto" | "firstSergeant" | "pl" | "plRto";

/**
 * 資格の離散フラグ(仕様 §14「MOSごとの基礎検定を離散フラグとして持たせ、その上に
 * 連続値の熟練度を乗せる二層構造」)。
 *
 * 単一のenumではなくフラグの集合にしているのは、仕様上ひとりが複数の資格を
 * 兼任しうるため(例: ブラボー組のライフルマンは選抜射手とされる一方、
 * 各FTのライフルマン1名は衛生要員を兼任する)。
 */
export interface SoldierQualifications {
  /** `[v6]` 衛生要員兼任。バディエイド処置時間が3秒→1.5秒に短縮(仕様 §9, §14) */
  medicalCrossTrained: boolean;
  /** 選抜射手。制圧時の命中率低下が −40% ではなく −10% に留まる(仕様 §8.6 [v5], §14) */
  designatedMarksman: boolean;
  /** `[v7.3]` 対戦車・対構造物火器の射手(ロードマップ A-3)。弾は `Soldier.atRounds` */
  antiArmor?: boolean;
}

export interface SoldierOrder {
  kind: SoldierOrderKind;
  /** move/maneuver/retreat/evade の目的地 */
  target?: Vec2;
  /** hold/suppress の照準・監視方向(単位ベクトル) */
  facing?: Vec2;
  /**
   * `follow` しながら制圧射撃も行う(`[v7.0]` 盾の密集隊形)。盾の後ろの隊員は
   * 隊形位置へ追従しつつ撃つので、`suppress`(経路探索つきの移動)では表せない。
   */
  suppress?: boolean;
  /** この命令が発行されたティック(陳腐化判定・デバッグ用) */
  issuedTick: number;
  /**
   * 隊形の基準になる兵士と、その兵士から見た相対位置(`[v7.1]` 盾の密集隊形)。
   * `follow` の目標を**毎ティック**この兵士の位置と向きから計算し直す。FTリーダーの
   * 判断周期(0.3秒)ごとの固定点を追うと、動いている盾持ちから数メートル遅れる。
   *   lat  = 右が正の横ずれ m / back = 後ろが正の距離 m
   */
  anchor?: { id: number; lat: number; back: number };
}

/**
 * 兵士1名。シミュレーション上の最小実体。
 * 分隊以上の階層は**コントローラ**(c2/ 配下)であって、身体を持つ実体ではない —
 * ただし指揮官本人の兵士は例外的にユニットとして戦場に存在する。
 */
export interface Soldier {
  id: number;
  side: Side;
  /** 所属中隊のID */
  companyId: number;
  /** 所属小隊のID。中隊本部要員は -1 */
  platoonId: number;
  /**
   * 所属分隊のID。**本部要員は負値**(小隊本部 -1 / 中隊本部 -2)で、
   * 分隊コントローラを持たないことを表す。
   */
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

  /** FT内の役割(仕様 §14) */
  role: SoldierRole;
  /** 本部要員ならその職(仕様 §2)。分隊の隊員は null */
  hqRole: HqRole | null;
  /** 資格の離散フラグ(仕様 §14) */
  quals: SoldierQualifications;

  /** 制圧状態が解けるティック(0 = 非制圧) */
  suppressedUntilTick: number;
  /**
   * 制圧射撃に誘発された回避行動が終わるティック(0 = 回避中でない)。仕様 §14。
   * SAW手の制圧はこの誘発率が1.5倍になる — SAWの戦術的な価値がここに出る。
   */
  evadeUntilTick: number;
  /**
   * このティック時点で、いずれかの敵の**視界扇形(FOV+LOS+索敵距離)の中に自分がいる**か。
   * 索敵システムが `敵.sees` の逆引きとして毎ティック再構築する一時値(仕様 §5 `[v6.1]`)。
   * 接敵反応(F-6)の分岐材料。デバッグ表示(被発見)にも使う。
   */
  observedByEnemy: boolean;
  /**
   * 突撃フェーズが終わるティック(0 = 突撃中でない)。仕様 §6 `[v6.1]` F-6。
   * 機動組が近接まで詰めると入り、この間は命中率が上がる。
   */
  assaultingUntilTick: number;
  /**
   * この兵士が自発的な発砲を控えるティック(0 = 制限なし)。仕様 §6 `[v6.1]` F-6。
   * 機動組が未発見のまま側面へ回り込む間だけ、FTリーダーAIが短時間セットする。
   * 制圧を受ける・被弾する等の受け身の処理はすべて通常どおり進む。
   */
  holdFireUntilTick: number;
  /** 擲弾の残数(仕様 §14 — 3発/戦闘)。擲弾手以外は0 */
  grenades: number;
  /** 対戦車・対構造物火器の残弾(`[v7.3]` A-3)。射手以外は 0(未指定も 0) */
  atRounds?: number;
  /**
   * 潰走中(仕様 §12)。所属FTが崩壊判定を受けている状態。
   * 潰走中の兵士は交戦対象にはなるが、自分からは撃たない(武装放棄)。
   * ただし**プレイヤーが直接操作している兵士は潰走を拒否できる**
   * (仕様 §12:「人間の意志は命令より強い」)。
   */
  routed: boolean;
  /** WIAがKIAへ移行するティック(0 = 該当なし。止血済みなら0) */
  bleedOutTick: number;

  // ── CASEVAC(仕様 §9)──
  /**
   * この負傷者の応急手当担当として割り当てられた兵士のID(null = 未割当)。
   * 仕様 §9: 負傷が発生すると最寄りの健常な隊員が動的に割り当てられる。
   */
  assignedAider: number | null;
  /** 自分がいま手当している負傷者のID(null = 手当していない) */
  treating: number | null;
  /** 手当の進捗ティック数。必要ティック数に達すると止血完了 */
  aidProgressTicks: number;
  /**
   * 止血・安定化済み。出血タイマーは止まるが行動不能のままで、後送を要する
   * (仕様 §9: 負傷=即行動不能、バディエイドが必須。軽傷/重傷の段階分けはしない)。
   */
  stabilized: boolean;
  /** 後送(担架搬送)の進行状態(仕様 §9)。 */
  evac: EvacStage;
  /** この負傷者を担いでいる担架要員のID列(2名 または 4名。仕様 §9) */
  bearers: number[];
  /** 自分がいま担いでいる負傷者のID(null = 担架要員ではない) */
  bearing: number | null;

  /**
   * 移動速度の倍率。担架搬送(0.5/0.85倍)や室内進入(0.7倍)など、
   * 一時的な速度変調をシステム間で受け渡すための共有フィールド。
   * 毎ティック、変調をかけるシステムが自分で1.0へ戻す責任を持つ。
   */
  speedMul: number;

  order: SoldierOrder;
  /** 現在の経路(ウェイポイント列)。先頭から順に消費する */
  path: Vec2[];
  pathIdx: number;
  /**
   * 移動しようとしているのに前進できていない連続ティック数。`[v6.4]`
   *
   * ナビグリッドと身体半径がずれると「経路には乗っているが身体が入らない」
   * ウェイポイントができ、そこで永久に止まる(4回目のテストプレイ指摘)。
   * 定数側は直したが、幾何の穴が二度と出ないことは保証できないので、
   * **詰まりは必ず時間で抜ける**という保険を移動システムに持たせる。
   */
  stuckTicks: number;

  /**
   * このティックに本人が直接視認できている敵兵士のID(距離+視界扇形+LOS、仕様 §5)。
   * 一時的な値で、毎ティック perceptionSystem が再構築する。
   */
  sees: number[];
  /** 「制圧役」状態(仕様 §8.6)。命令またはAIの自律判断で立つ */
  suppressor: boolean;
  /**
   * FTリーダーが割り当てた射撃目標の敵兵士ID(null = 各自の判断)。`[v6.3]`
   *
   * 米軍ドクトリンの**火力の統制と配分**(fire control / distribution、ATP 3-21.8)。
   * リーダーは射撃命令で各員に目標を振り、(1) 一点集中を避けて敵の隊形全体を覆い、
   * (2) 重火器(機関銃・SAW)と指揮官を優先目標にする。これが無いと全員が最寄りの
   * 同じ敵を撃ち、集中しすぎと取りこぼしが同時に起きる(3回目のテストプレイ指摘)。
   *
   * 割り当ての情報源はFT隊員が**実際に見ている**敵だけ(仕様 §5: 生の視界は
   * 分隊長まで)。見えない敵を撃たせることはできない。
   */
  assignedTarget: number | null;

  /**
   * 視線の原点(仕様 §7.5 ビハインドカメラ)。通常は `pos` と同じだが、壁角で
   * 「覗いて」いる間は横へずれる。
   *
   * **見る側と見られる側の両方でこの点を使う**のが要点。覗けば見えるが、同時に
   * 覗かれてもいる — 仕様が要求する「一方的な有利を与えない」を、片方だけ有利に
   * なりようのない形で実装している。プレイヤーもAIも同じ計算を通る。
   */
  eye: Vec2;
  /** いま覗いている(視線原点が体からずれている)か。描画とデバッグ用 */
  peeking: boolean;
  /**
   * いま窓に就いているか(`[v6.10]` 仕様 §7/§8)。毎ティック `windowsSystem` が更新する。
   * 位置から導かれる状態であって、兵士が持つ「構え」ではない。
   */
  atWindow: boolean;

  /** 個体差パラメータ(仕様 §14)。各 0..1 */
  traits: SoldierTraits;

  /**
   * **自軍の中での編成上の通し番号**。`[v6.2]`/`[v6.3]`
   *
   * 「鏡像の位置に立つ兵士どうしで一致していなければならない」種類の判断に使う。
   * 中隊マップは点対称なので、そこがずれると地形由来ではない有利不利になる
   * (仕様 §2/§13)。両陣営は同じ順序で同じ編成を組み立てるため、この番号は
   * 鏡像の2人で必ず一致する。個体差(traits.ts)と索敵の分散(perception)が使う。
   * 兵士IDでは代用できない — IDは両軍を交互に採番するのでオフセットが乗る。
   */
  ordinal: number;
  /**
   * 遠距離索敵の前回結果のキャッシュ。`[v6.3]`
   * 索敵距離が150mになり、遠方まで毎ティック全員ぶん判定すると破綻するため、
   * 遠距離だけ数ティックおきに更新してその間はここを使い回す。
   */
  seesFar: number[];
  /**
   * 最後に自分を撃ってきた者の位置と、それを覚えている期限(`[v7.1]` 個人の戦闘動作)。
   * 「撃たれたら撃ってきた方を向く」に使う。見えていない敵の位置を知る手段ではなく、
   * 向きを変えるきっかけにだけ使う(そこから先は自分の目で見る、仕様 §5)
   */
  alertFrom: Vec2 | null;
  alertUntilTick: number;
  /**
   * 機関銃陣地の射界(`[v7.2]` S-1)。陣地に就いている間だけ `defenseSystem` が入れる。
   * 入っている間は射界の外の敵を撃たない・向かない(陣地を据えた意味がなくなるので)
   */
  sector?: { dir: Vec2; cosHalf: number } | null;
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
  /**
   * 見たのではなく**聞いた**接触(`[v7.3]` ロードマップ A-5)。銃声の方角とだいたいの距離
   * だけで、誰が撃ったかは分からない。位置誤差が大きく、確度も最初から低い
   */
  heard?: boolean;
  /** 聞いた接触の、音の見積もりそのものの粗さ m(`[v7.3]`)。ホップの粗さは `hopError` に別に乗る */
  heardError?: number;
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
  /**
   * 臨時報告のきっかけ(`[v7.3]` ロードマップ A-8)。定時報告なら無い。
   * 中身(接触・自隊の状況)は定時報告と同じで、違うのは**いつ送られたか**だけ
   */
  flash?: FlashReason[];
  /** 送信元自身の戦力・状況サマリ(SALUTE報告の S/L に相当) */
  ownStatus: {
    effective: number;
    total: number;
    posCentroid: Vec2;
    /**
     * 送信元の**先頭**の位置(`[v6.16]`)。自陣営の前進フレームで最も前に出ている隊員。
     * 「うちの先頭は今ここ」は部隊が自分で分かる情報なので、報告に載せてよい。
     * 火力の統制線(FSCM)はこちらで引く — 味方を撃たない線を重心で引いてはいけない。
     */
    posLead: Vec2;
  };
}

/**
 * 臨時報告のきっかけ(`[v7.3]` ロードマップ A-8)。
 *   contact   : 接敵(確かな接触が無い状態から、ある状態になった)
 *   commander : 指揮官の交代(負傷・戦死で次席者が継いだ。仕様 §12)
 *   rout      : 麾下FTの潰走が増えた(仕様 §12)
 */
export type FlashReason = "contact" | "commander" | "rout";

/**
 * 臨時報告を出すかどうかを決めるための、送信元が前回の報告時点で覚えている状態
 * (`[v7.3]`)。いまの状態と比べて「変わった」ときだけ臨時報告が立つ。
 */
export interface FlashWatch {
  /** 確かな接触を持っていたか */
  contact: boolean;
  /** 指揮を執っていた兵士 */
  commanderId: number | null;
  /** 潰走していた麾下FTの数 */
  routed: number;
  /** 最後に臨時報告を送ったティック(連発の下限を測る) */
  lastFlashTick: number;
}

/** 受信された臨時報告1件(`[v7.3]`)。UI の表示用で、シムは読まない */
export interface FlashLogEntry {
  side: Side;
  /** 受信したティック */
  tick: number;
  /** 送信したティック */
  sentTick: number;
  fromEchelon: Echelon;
  fromUnitId: number;
  reasons: FlashReason[];
  /** 載っていた接触の件数 */
  contacts: number;
}

/**
 * 上位が保持している「部下1個の最新の状況」(`[v6.16]`)。
 * 到着した報告の `ownStatus` をそのまま留め置いたもので、前線を引く材料になる。
 */
export interface SubordinateReport {
  /** どの部下か(分隊なら squadId、小隊なら platoonId) */
  unitId: number;
  /** 報告された重心 */
  pos: Vec2;
  /** 報告された先頭の位置 */
  posLead: Vec2;
  effective: number;
  total: number;
  /** その報告が**送信された**ティック。到着ティックではない(仕様 §5 の遅延) */
  sentTick: number;
}

/**
 * 前線の折れ線の頂点1つ(`[v6.17]`)。部下1個ぶん。
 *
 * 先頭と重心の**両方**を持つ。前線として描くのは先頭を結んだ線だが、部隊は点では
 * なく縦深を持つので、火力の統制はその縦深まで見なければならない
 * (`c2/flot.ts` の `distToFlot` を参照)。
 */
export interface FlotNode {
  unitId: number;
  /** 報告された**先頭**の位置。前線の線はここを結ぶ。真の位置とはずれる(仕様 §5) */
  pos: Vec2;
  /** 報告された**重心**。部隊の縦深の後ろ側 */
  body: Vec2;
  /** その報告が送信されたティック。頂点ごとに古さが違う */
  sentTick: number;
}

/**
 * 指揮官が持っている前線(FLOT、`[v6.16]`、`[v6.17]` で折れ線化。仕様 §5/§11)。
 *
 * **直線ではなく、部下から部下へたどった折れ線。** 突出した部隊のところで前へ膨らみ、
 * 遅れているところで引っ込む。その凹凸が指揮官の読む情報そのもの。詳細は `c2/flot.ts`。
 */
export interface Flot {
  /** 折れ線。自陣営の前進フレームで左から右へ並ぶ。空なら前線は未知 */
  trace: FlotNode[];
  /** 根拠になった報告のうち最も古いものの送信ティック。線の古さ */
  asOfTick: number;
  /** 頂点の数 = 根拠になった報告の数。0 なら前線は未知 */
  sources: number;
}

/**
 * 統合・再編(consolidation & reorganization、ATP 3-21.8 "actions on the objective")。
 * `[v6.16]`
 *
 * 拠点は**奪った瞬間が最も脆い**。ドクトリンは奪取の直後を独立した段階として扱い、
 * 部隊はそこで前進を止め、逆襲の予想方向へ火器を指向し、隣接する未掃討の建物を
 * 潰し、負傷者と指揮を整理する。これが無いと部隊は拠点を「通過」してしまう。
 */
export interface Consolidation {
  /** 統合の対象になっている拠点 */
  objectiveId: number;
  /** この段階に入ったティック */
  sinceTick: number;
  /**
   * 逆襲が来ると見ている方向(単位ベクトル)。奪取した側から見て**さらに前方** —
   * 敵は自分が来たのと反対側から来る。ここが「警戒方向」の実体。
   */
  watch: Vec2;
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
/**
 * 側面攻撃の段取り(`[v7.0]` 仕様 §6 Fire and Movement / ATP 3-21.8 Battle Drill 1)。
 *
 * 分隊長(FT単位)と小隊長(分隊単位)が同じ形で持つ。**一度決めた役割と回り込む側は
 * 交戦が続く限り変えない** — 以前は 0.3 秒ごとに「敵に近いほうがベース」を引き直して
 * いたため、機動組が敵へ寄るたびに役割が入れ替わり、側面へ回る動きが毎回振り出しに
 * 戻っていた(計測: 分隊戦5回で役割の反転270回、小隊戦で1118回)。
 */
export interface FlankPlan {
  /** ベース・オブ・ファイア(制圧)を担う要素。分隊ではFT番号、小隊では squadId */
  baseKey: number;
  /** 側面へ回る機動要素 */
  maneuverKey: number;
  /** 回り込む側。ベース→敵の軸から見て +1 = 左回り / −1 = 右回り(座標系に依存しない符号) */
  dir: 1 | -1;
  /** 段取りを決めたティック(時間切れの判定用) */
  sinceTick: number;
  /** 最後に脅威を把握していたティック。見失ってもしばらくは段取りを保つ */
  lastThreatTick: number;
  /** 側面を取り終えた(=突撃へ移った) */
  done: boolean;
  /** 突撃へ移ったティック。突撃が一段落したら段取りを解いて状況を見直す */
  doneTick: number | null;
}

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
  /** 小隊長から下ろされた任務(WHAT。`[v6.1]` §3①)。既定は objective への seize */
  mission: Mission;
  advanceDir: Vec2;
  rallyPoint: Vec2;

  /** 上位(小隊)へ最後に定時報告を送ったティック */
  lastReportTick: number;
  /** 最後に意思決定を行ったティック。指揮継承による判断周期の劣化を反映するため */
  lastDecisionTick: number;

  /**
   * 分隊長が後送を命じた負傷者のID(仕様 §9: 担架搬送は明示的な命令発行を要する)。
   * 応急手当と違い自律トリガーではないので、ここに載って初めて担架班が編成される。
   */
  casevacOrders: number[];

  /** 小隊長から下ろされた警戒方向の目印(`[v6.16]`)。統合・再編中のみ非 null */
  watch: Vec2 | null;

  /** 現在この分隊の指揮を執っている兵士のID(仕様 §12 の指揮継承) */
  commanderId: number | null;
  /** 指揮継承が起きたティック(null = 継承していない) */
  degradedSinceTick: number | null;

  /**
   * いま攻略中の扉ID(仕様 §7.2)。**一度決めたら掃討が終わるまで手放さない**。
   *
   * 建物単位の一連の流れ(孤立化→支援射撃→突撃→突入→掃討→再編成)は分隊長が
   * 一貫して担当する、という仕様の要求は「途中で気を変えない」ことを含む。
   * 毎周期に判断し直すと、屋外で接敵情報が入るたびに任務目標がそちらへ引っ張られ、
   * スタックを組んでは解散するのを繰り返して永久に突入できない(実装して確認した)。
   */
  assaultDoorId: number | null;
  /** 掃討済みの扉ID。同じ部屋を何度も攻略し直さないため */
  clearedDoorIds: number[];

  /** 分隊長が決めた側面攻撃の段取り(`[v7.0]`)。FT番号で持つ */
  flank: FlankPlan | null;
  /**
   * 小隊長から「分隊ごと側面へ回れ」と下ろされた経由点(`[v7.0]`)。
   * 非 null の間は分隊内の火力/機動の分割をやめ、両FTとも機動要素としてここへ向かう
   * (支援射撃は小隊のベース分隊が持つ)。
   */
  flankGoal: Vec2 | null;
  /** 小隊の側面機動が側面を取り終え、分隊ごと突撃に移った(`[v7.0]`) */
  flankAssault: boolean;

  /** 臨時報告の判定に使う前回の状態(`[v7.3]` ロードマップ A-8) */
  flashWatch: FlashWatch;

  /** 発煙弾の残数(`[v7.2]` ロードマップ S-2)。分隊の装備で、分隊長が投げる */
  smokes: number;
  /** 最後に発煙弾を投げたティック(連投の下限を測る)。投げていなければ -Infinity 相当の負値 */
  lastSmokeTick: number;
  /** 最後に対戦車・対構造物火器を撃ったティック(`[v7.3]` A-3) */
  lastAntiArmorTick?: number;
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
  companyId: number;

  /** 小隊長の world picture(無線報告のみ、遅延と確度減衰を伴う) */
  belief: Map<string, Contact>;

  /** 麾下分隊へ割り当てた任務目標 */
  squadObjectives: Map<number, Vec2>;
  /** 麾下分隊へ下ろした任務(WHAT。`[v6.1]` §3①) */
  squadMissions: Map<number, Mission>;
  /** 麾下分隊へ指示した移動技術 */
  squadTechniques: Map<number, MovementTechnique>;
  /** 麾下分隊から届いた最新の状況(`[v6.16]`)。前線を引く材料。squadId → 報告 */
  squadReports: Map<number, SubordinateReport>;
  /** 小隊長が持っている前線(`[v6.16]`)。`squadReports` からのみ引く(仕様 §5) */
  flot: Flot;

  /**
   * 統合・再編(consolidation & reorganization、ATP 3-21.8)。`[v6.16]`
   * 拠点を奪取した小隊が、そこに留まって逆襲に備えている間だけ非 null。
   */
  consolidation: Consolidation | null;

  objective: Vec2;
  /** 中隊長から下ろされた任務(WHAT。`[v6.1]` §3①)。既定は objective への seize */
  mission: Mission;
  advanceDir: Vec2;
  rallyPoint: Vec2;

  lastReportTick: number;
  lastDecisionTick: number;

  /** 現在この小隊の指揮を執っている兵士のID(仕様 §12 の指揮継承) */
  commanderId: number | null;
  /** 指揮継承が起きたティック(null = 継承していない)。判断の質低下の起点 */
  degradedSinceTick: number | null;

  /** 小隊長が決めた側面攻撃の段取り(`[v7.0]`)。squadId で持つ */
  flank: FlankPlan | null;

  /** 臨時報告の判定に使う前回の状態(`[v7.3]` ロードマップ A-8) */
  flashWatch: FlashWatch;
}

/**
 * 中隊長コントローラの状態(仕様 §3 ①、§11)。
 *
 * 情報上の立ち位置: 各小隊長からの報告の**集約**で、小隊長より**さらに遅延し
 * 粒度も粗い**(仕様 §5)。無線を2ホップ経ているため位置誤差も2ホップ分乗る。
 *
 * やること(仕様 §3 ①):
 *   - 小隊への任務(WHAT)割り当て
 *   - 予備戦力の投入判断
 *   - CASEVAC(後送)アセットの配分判断 = トリアージ(仕様 §9)
 *
 * 中隊長は指揮所(CP)を拠点とし、前線には出ない(仕様 §11)。
 */
export interface CompanyState {
  id: number;
  side: Side;
  companyId: number;

  /** 中隊長の world picture(小隊長からの報告の集約のみ) */
  belief: Map<string, Contact>;

  /** 指揮所(CP)の位置(仕様 §11)。中隊長・XO・RTOが常駐する */
  cp: Vec2;

  /** 麾下小隊へ割り当てた任務目標 */
  platoonObjectives: Map<number, Vec2>;
  /** 麾下小隊へ下ろした任務(WHAT。`[v6.1]` §3①) */
  platoonMissions: Map<number, Mission>;
  /** 麾下小隊から届いた最新の状況(`[v6.16]`)。前線を引く材料。platoonId → 報告 */
  platoonReports: Map<number, SubordinateReport>;
  /** 中隊長が持っている前線(`[v6.16]`)。2ホップぶん古い(仕様 §5) */
  flot: Flot;

  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;

  lastDecisionTick: number;

  /** 後送アセット(仕様 §9)。中隊長が限られた台数を配分する */
  assets: CasevacAsset[];

  /**
   * 迫撃砲の残弾(仕様 §10/§11)。`[v6.9]`
   * **中隊の共有資源**であって個人の携行弾ではないので、§8.1「弾薬管理は擲弾のみ」の
   * 例外にはあたらない。撃つほど後半の選択肢が減る、という中隊長の裁量そのもの。
   */
  mortarRoundsUsed: number;
  /** 最後に射撃要請を出したティック(連続要請の下限を測る) */
  lastFireMissionTick: number;

  /**
   * 逆襲(`[v7.3]` ロードマップ A-4)。攻防戦の防御側の中隊長が、奪われた拠点を取り返しに
   * 1個小隊を差し向けている間だけ非 null
   */
  counterattack: { objectiveId: number; platoonId: number; sinceTick: number } | null;

  /**
   * 戦闘前に立てた作戦(`[v6.5]`)。null なら立案フェーズを踏んでいない
   * (テストやヘッドレス実行の既定)。作戦がある間、麾下小隊への任務割り当ては
   * 幾何的な担当区域ではなくこの計画から引く — 計画は FRAGO(=拠点の確保完了や
   * 攻勢分遣の判断)まで有効、という指揮の作法をそのまま実装している。
   */
  plan: OperationPlan | null;
  /**
   * 書き換える前の AI の作戦(`[v7.3]` A-1)。書き換えはいつもこの上に重ね直すので、
   * 何度書き換えても初期条件コードから作り直した盤面と同じになる(P3)
   */
  basePlan: OperationPlan | null;

  commanderId: number | null;
  degradedSinceTick: number | null;
}

/**
 * 後送アセット1台(仕様 §9: 車両/ヘリ)。
 * 中隊長の資源であり、CCPへの到着まで時間がかかる(いわゆるゴールデンアワー)。
 */
export interface CasevacAsset {
  id: number;
  /** null = 待機中。値があればそのティックにCCPへ到着する */
  arriveTick: number | null;
}

/** 1個中隊に対するシナリオ側の意図。 */
export interface CompanyPlan {
  side: Side;
  companyId: number;
  objective: Vec2;
  advanceDir: Vec2;
  rallyPoint: Vec2;
  /** 指揮所(CP)。未指定なら初期配置の後方に自動配置する */
  cp?: Vec2;
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
  companyId?: number;
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

  /**
   * 警戒方向の**目印**(`[v6.16]`)。統合・再編中だけ非 null で、逆襲が来ると
   * 見ている方角に置かれた遠い1点。接触が分かっていないときの「どちらを向くか」を
   * これで決める(接触があればそちらが優先)。方向ではなく点で持つのは、銃眼の
   * 選定が「その窓の外側に敵がいるか」という点の判定でできているため。
   */
  watch: Vec2 | null;

  /** 分隊長から指示された移動技術(仕様 §6)。ADVANCE時の動き方を決める */
  technique: MovementTechnique;
  /**
   * 接敵時に分隊長から割り当てられた役割(仕様 §6 Fire and Movement)。
   * `base` = ベース・オブ・ファイア(制圧担当)、`maneuver` = 機動担当。
   * null は未割り当て(接敵していない、または分隊長が健在でない)。
   */
  assignedRole: "base" | "maneuver" | null;
  /**
   * 機動役のFTが次に向かう側面の経由点(`[v7.0]`)。分隊長が敵を中心とした弧の上に
   * 少しずつ置き直す。非 null の間、機動組は目標への躍進より側面の確保を優先する。
   */
  flankGoal: Vec2 | null;
  /** 側面を取り終えた。機動組は敵陣地へ突撃する(`[v7.0]`) */
  flankDone: boolean;

  // ── CQB(仕様 §7.3)──
  /** 突入待機命令の対象扉ID(null = CQB中ではない) */
  cqbDoorId: number | null;
  /** 突入待機命令の進行段階 */
  cqbStage: CqbStage;
  /** 現在の段階に入ったティック(流入間隔・タイムアウトの基準) */
  cqbStageSince: number;
  /** 兵士IDごとの担当コーナー(進入後の索敵扇形の中心)。仕様 §7.3 ③ */
  cqbCorner: Map<number, Vec2>;
  /** 突入順(スタック順)。単一ファイルでの流入間隔に使う */
  cqbEntryOrder: number[];
  /**
   * フラッシュバンの残数(`[v7.2]` 仕様 §8.4、ロードマップ S-3)。FTの装備で、突入のたびに
   * 1発使う。尽きたら投げずに入る — 部屋の多い建物では後半の部屋ほど素で入ることになる
   */
  flashbangs: number;

  /**
   * 潰走を開始したティック(null = 潰走していない)。仕様 §12 の補助条件。
   * 判定単位はファイアチーム — 分隊・小隊レベルでの直接判定は行わず、
   * 上位への波及は麾下FTの崩壊の集積として間接的に表現される。
   */
  routedSinceTick: number | null;
}

/**
 * 後援部隊(増援)の設定(`[v7.0]`)。陣営ごとの編成オプション(`ForceSpec.reinforcement`)。
 *
 * **数・規模・出現位置は暫定**で、詳細はユーザーと相談して詰める前提の値(既定は「なし」)。
 * 仕組みとしては「最上位の指揮官が呼ぶ → `delaySec` 後に `entry` へ現れる → 既存の
 * 指揮系統に組み込まれてAIが動かす」だけで、増援だけが特別な能力を持つことはない。
 */
export interface ReinforcementSpec {
  /** 呼べる回数。0 なら後援なし */
  calls: number;
  /** 1回で来る規模。squad = 9名の分隊 / platoon = 3個分隊+小隊本部(29名) */
  size: "squad" | "platoon";
  /** 呼んでから戦場に現れるまで s(シム時間) */
  delaySec: number;
  /**
   * どこに現れるか。
   *   rear = 自軍の後方(中隊の指揮所、無ければ負傷者集合点)
   *   edge = 自陣側の盤端(前進方向の真後ろの縁)
   */
  entry: "rear" | "edge";
  /**
   * AIの最上位指揮官が自動で呼ぶ条件: 自軍の戦闘可能者が編成のこの割合を下回ったら。
   * 0 ならAIは呼ばない(人間・LLM の要請だけ)
   */
  autoCallBelow: number;
}

/** 1回の要請。着くまで `pending` に並ぶ(`[v7.0]`) */
export interface ReinforcementCall {
  calledTick: number;
  arriveTick: number;
  size: ReinforcementSpec["size"];
}

/** 陣営ごとの後援部隊の状態(`[v7.0]`) */
export interface ReinforcementState {
  /** null なら後援なし */
  spec: ReinforcementSpec | null;
  /** 使った回数 */
  callsUsed: number;
  pending: ReinforcementCall[];
  /** 到着した回数(新しい部隊の通し番号にも使う) */
  arrived: number;
}

export interface Scenario {
  name: string;
  seed: number;
  bounds: Bounds;
  /** 視線・遮蔽の判定に使う壁。**窓の開口が空いている**(`[v6.10]`) */
  walls: AABB[];
  /**
   * 窓の開口を塞ぐ栓(`[v6.10]`)。経路探索に使う壁は **`walls + windowPlugs`**。
   *
   * 窓は視線を通して人を通さない開口なので、「見えるか」と「通れるか」で判定対象が
   * 食い違う。1本にまとめると、窓から狙撃できるようにした途端に窓から出入りも
   * できてしまい、突入ドリル(仕様 §7.2)が崩れる。
   *
   * **差分で持つことに意味がある。** 最初は2本のリストを別々に組み立てていたが、
   * 街路の塀を片方へ積み忘れた結果、経路探索が塀を素通りできると誤認して担架班が
   * 900秒で5mしか進まなくなった。差分なら、どこにどれだけ壁を足しても
   * 取りこぼしようがない。
   */
  windowPlugs?: AABB[];
  /**
   * 最初から屋内ナビを張っておく建物のID(`[v6.12]`)。
   *
   * 通常は突入が決まった時点で張れば足りる(仕様 §7.2)。塹壕だけは誰も「突入」
   * しないまま守る側が最初から入って戦う場所なので、張っておかないと**ただの
   * 障害物**になり、部隊が迂回してしまう。
   */
  navBuildingIds?: number[];
  /** 初期配置の兵士(完全指定) */
  soldiers: Soldier[];
  /** FTごとの任務目標。未指定のFTはマップ中心にフォールバックする */
  fireteamPlans?: FireteamPlan[];
  /** 分隊ごとの任務目標 */
  squadPlans?: SquadPlan[];
  /** 小隊ごとの任務目標 */
  platoonPlans?: PlatoonPlan[];
  /** 中隊ごとの任務目標 */
  companyPlans?: CompanyPlan[];
  /** 参照・描画用の統制手段(仕様 §6): チェックポイント・フェーズライン・目標 */
  controlMeasures?: ControlMeasure[];
  /**
   * 陣営ごとの負傷者集合点(CCP、仕様 §9)。担架班はここへ負傷者を運ぶ。
   * 未指定なら各陣営の初期位置の重心を使う。
   */
  /** 後援部隊の設定(`[v7.0]`)。未指定の陣営は後援なし */
  reinforcement?: Partial<Record<Side, ReinforcementSpec>>;
  ccp?: Record<Side, Vec2>;
  /** 建物(仕様 §7)。屋外と屋内はシームレスな1つのマップとして扱う */
  buildings?: Building[];
  /** 争奪する拠点(仕様 §12)。空なら勝敗は戦力の枯渇でのみ決まる */
  objectives?: Array<Omit<Objective, "owner" | "progress" | "progressBy" | "contested">>;
  /** 戦闘の型(仕様 §12)。未指定は遭遇戦 `[v6.8]` */
  mode?: BattleMode;
  /** `mode === "assault"` のときの攻撃側。防御側は最初から全拠点を保有する */
  attacker?: Side;
  /** 攻防戦の制限時間(秒)。攻撃側がこの間に落とせなければ防御側の勝ち */
  timeLimitSec?: number;
  /** 立案時に人間が置き直した防衛陣地(`[v7.2]` S-1)。AI案の上に重ねる */
  defenseEdits?: DefenseEdit[];
  /** 立案時に人間・LLM が書き換えた作戦(`[v7.3]` A-1)。AI案の上に重ねる */
  planEdits?: PlanEdit[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 市街地戦・屋内戦闘(仕様 §7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扉(仕様 §7.3「壁の一部に幅1.0m程度の開口部。位置・向き(法線方向)を持つ」)。
 *
 * 閉じている間は**視線も移動も遮る**。仕様 §7.6 の「ドアが開いた瞬間だけ部屋の中が
 * 見える」Door Kicker式の視界ルールは、この1点だけで成立する。
 */
export interface Door {
  id: number;
  buildingId: number;
  roomId: number;
  /** 開口部の中心 */
  pos: Vec2;
  /** 法線。**室内へ向かう**単位ベクトル(スタック位置は逆方向に取る) */
  normal: Vec2;
  /** 開口幅 m */
  width: number;
  /** 開いているか。ブリーチで開く */
  open: boolean;
  /**
   * 建物の外周面にある扉か。`[v6.2]` 中廊下+区画の建物で内扉と区別するために持つ。
   * 建物の外にいる分隊は外扉からしか突入できない(内扉のスタック位置は屋内にある)。
   */
  exterior: boolean;
}

/** 壁で囲まれた閉領域1つ(仕様 §7.3「室内領域」)。初期リリースは単層のみ(§7.1)。 */
export interface Room {
  id: number;
  buildingId: number;
  /** 室内の床面。壁の内側 */
  bounds: Bounds;
}

/** 建物1棟。屋外と屋内はシームレスな1つのマップとして扱う(仕様 §7.1)。 */
/**
 * 窓(`[v6.10]` 仕様 §7)。
 *
 * 扉との違いはただ1つ、**視線は通すが人は通さない**こと。実装も扉と同じ「壁の開口」で、
 * 穴を空けるのは視線用の壁だけ。経路探索用の壁(`World.navWalls`)は塞いだままなので、
 * 窓から出入りはできない — できてしまうと突入ドリル(仕様 §7.2)が意味を失う。
 *
 * 窓に就いた兵士は、遮蔽越しに撃つ側の非対称を受ける(仕様 §8):
 * 被命中 −60% / 自身の命中 +30%。銃眼から撃つ側が有利、というだけの話で、
 * 新しい戦闘機構ではなく既存の命中判定への係数として入る。
 */
export interface WindowPort {
  /** 開口の中心(壁の中心線上) */
  pos: Vec2;
  /** 屋外向きの法線 */
  normal: Vec2;
}

export interface Building {
  id: number;
  /** 外周(壁を含む) */
  bounds: Bounds;
  rooms: Room[];
  doors: Door[];
  /** 外周に空いた窓(`[v6.10]`)。射撃位置としても使う */
  windows: WindowPort[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 勝敗条件(仕様 §12)
// ─────────────────────────────────────────────────────────────────────────────

/** 拠点規模。仕様 §12 は2段階(小/大)に単純化すると確定している。 */
export type ObjectiveSize = "small" | "large";

/**
 * 拠点(仕様 §12 メイン条件「拠点確保」)。
 *
 * 複数を同時に奪い合い、一定数を一定時間確保した側が勝利する。
 * 拠点内の人数に応じて確保速度が変化し(多いほど早い)、上限を超えた人数は
 * 混雑により追加効果がない。拠点内に敵がいる間は確保カウントが完全に停止する。
 */
export interface Objective {
  id: number;
  label: string;
  pos: Vec2;
  radius: number;
  size: ObjectiveSize;
  /** 確保済みの陣営(null = 中立) */
  owner: Side | null;
  /** 確保の進捗 0..1 */
  progress: number;
  /** いま進捗を進めている陣営(null = 誰も進めていない) */
  progressBy: Side | null;
  /** 拠点内に両陣営がいる = コンテスト状態。確保カウントは完全に停止する */
  contested: boolean;
}

/** 決着(仕様 §12)。null なら戦闘継続中。 */
export interface VictoryState {
  winner: Side;
  /**
   * `objectives`   拠点確保
   * `annihilation` 戦力の枯渇
   * `timeout`      攻防戦で制限時間まで持ちこたえた(防御側の勝ち)`[v6.8]`
   */
  reason: "objectives" | "annihilation" | "timeout";
  tick: number;
}

export interface ControlMeasure {
  kind: "CP" | "PL" | "OBJ";
  label: string;
  /** CP/OBJ は点、PL は折れ線 */
  points: Vec2[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 描画用エフェクトイベント(`[v6.1]`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * そのティックに戦闘システムが起こした「見えるべき事象」。
 *
 * **シムの結果には一切影響しない** — 誰も読まないし、次ティック先頭で捨てられる。
 * 純データなのでシリアライズ可・決定論的(乱数を新たに引かない)。レンダラとHUDが
 * ここを読んで発砲線・擲弾の着弾円・イベントログを出す(指摘: 撃った線 / 擲弾を可視化)。
 */
export type FxEvent =
  /**
   * 1発の射撃(描画専用)。`[v7.1]` 毎ティックの命中判定をそのまま1発として出すと
   * 1人が毎秒30発撃っているように見えるので、命中は必ず、外れは武器ごとの
   * 見た目の発射レート(constants `TRACER`)で間引いて出す。シムの判断には使わない。
   */
  | {
      kind: "shot";
      from: Vec2;
      to: Vec2;
      side: Side;
      hit: boolean;
      shooterId: number;
      targetId: number;
      weapon: "rifle" | "dm" | "pistol" | "saw" | "mg";
    }
  | { kind: "grenade"; at: Vec2; side: Side; radius: number; victims: number }
  /** 対戦車・対構造物火器の発射と着弾(`[v7.3]` A-3) */
  | { kind: "rocket"; from: Vec2; at: Vec2; side: Side; radius: number; victims: number; hit: boolean }
  /** フラッシュバンの炸裂(`[v7.2]`)。`radius` は部屋を覆う半径(描画用)、`stunned` は制圧した人数 */
  | { kind: "flashbang"; at: Vec2; side: Side; radius: number; stunned: number }
  /** 迫撃砲の着弾(`[v6.9]`)。`radius` は殺傷半径、`suppressRadius` は制圧が及ぶ範囲 */
  | {
      kind: "mortar";
      at: Vec2;
      side: Side;
      radius: number;
      suppressRadius: number;
      victims: number;
    };

/**
 * そのティックに鳴った銃声・爆発音1つ(`[v7.3]` ロードマップ A-5)。
 * 戦闘システムが積み、聴覚システム(systems/hearing.ts)が読んで捨てる
 */
export interface Gunshot {
  /** 撃った(投げた)者。爆発は投げた者 */
  sourceId: number;
  side: Side;
  pos: Vec2;
  /** 聞こえる距離 m(武器ごと、constants `HEARING.RANGE`) */
  range: number;
  /** 足音(`HEARING.FOOTSTEP`)。壁越しでも聞こえる距離が縮まない */
  footstep?: boolean;
}

/**
 * 防衛陣地の種類(`[v7.2]` ロードマップ S-1)。
 *   mg        : 機関銃陣地。火器分隊の1班(射手+副射手+弾薬手)が就き、射界の中だけを撃つ。
 *               撃つ相手がいないときは最終阻止射撃線(FPL)に銃を据える
 *   fighting  : 射撃壕・土嚢。就いた者は窓と同じ補正を受ける(被命中 −60% / 命中 +30%、§8)
 *   alternate : 予備陣地。拠点を持つ小隊のFTが、後退・潰走のときに下がる先
 *   wire      : `[v7.2]` 鉄条網(S-1b)。人は通さず視線は通す。接近路を横切って張る
 *   forward   : `[v7.3]` 前進陣地(A-4 縦深防御の第1線)。1個分隊が拠点の前方に就き、
 *               撃ち合いながら敵を遅らせ、押されたら拠点(第2線)へ下がる
 *   ambush    : `[v7.3]` 待ち伏せ(A-4、L字型)。1個分隊が接近路の脇に伏せ、敵が殺傷地帯に
 *               入るまで撃たない。`pos` は側面の組(長辺)の位置、`killZone` が殺傷地帯の中心
 */
export type DefenseKind = "mg" | "fighting" | "alternate" | "wire" | "forward" | "ambush";

/**
 * 防衛陣地1つ(`[v7.2]` ロードマップ S-1)。防衛側の中隊長が戦闘前に置く。
 *
 * **攻撃側には見えない**(ロードマップ P1)。描画は自陣営と神視点だけに出し、
 * 攻撃側のAIはこれを読まない。撃てば通常の視認・報告に乗る。
 */
export interface DefensivePosition {
  id: number;
  side: Side;
  kind: DefenseKind;
  pos: Vec2;
  /** 正面。mg なら最終阻止射撃線(FPL)の向き = 射界の中心 */
  facing: Vec2;
  /** 守る拠点(無ければ null) */
  objectiveId: number | null;
  /** mg に就く班(火器分隊の squadId と FT 番号)。他の種類は null */
  crew: { squadId: number; ftIndex: number } | null;
  /** 待ち伏せの殺傷地帯の中心(`[v7.3]` ambush のみ) */
  killZone?: Vec2;
  /**
   * 分隊の陣地の進み具合(`[v7.3]` forward / ambush。分隊まるごとが就くので crew.ftIndex = -1)。
   *   set      : 陣地に就いている(待ち伏せなら撃たずに待つ)
   *   sprung   : 待ち伏せが撃ち始めた。陣地で戦う
   *   withdraw : 前進陣地から拠点へ下がっている
   *   released : 役目を終え、分隊は通常の指揮に戻った
   */
  stage?: "set" | "sprung" | "withdraw" | "released";
  /** stage に入ったティック */
  stageTick?: number;
}

/** 人間が立案時に置き直した陣地(初期条件コードに載る、ロードマップ P3)。`idx` は AI 案での並び順 */
export interface DefenseEdit {
  side: Side;
  idx: number;
  pos: Vec2;
}

/**
 * 発煙の煙幕1つ(`[v7.2]` ロードマップ S-2)。
 *
 * **視線だけを遮る円**。壁と違って人も弾も通る — 遮るのは「見えるか」(索敵、仕様 §5)で、
 * 見えなければ撃てない(射撃は `sees` に載った相手にしか向かない)。煙は双方に見える
 * 出来事なので、情報の階層には掛けない(隠すのは煙の向こうの部隊)。
 */
export interface Smoke {
  id: number;
  /** 投げた陣営(描画の色と記録のため。遮る効果は陣営を見ない) */
  side: Side;
  pos: Vec2;
  /** 投げたティック。半径はここから `SMOKE.BUILD_SEC` かけて広がる */
  sinceTick: number;
  /** 消えるティック */
  untilTick: number;
}

/**
 * 進行中の火力支援任務(仕様 §10/§11)。`[v6.9]`
 *
 * `target` は**中隊長の belief から採った推定位置**であって敵の現在位置ではない。
 * 要請したときの像がそのまま凍結され、飛翔時間ののちにそこへ落ちる(仕様 §5)。
 */
export interface FireMission {
  id: number;
  side: Side;
  companyId: number;
  /** 照準点(要請時点の推定位置。以後動かない) */
  target: Vec2;
  /** 要請したティック。UI が「要請から何秒」を出すのに使う */
  requestedTick: number;
  /** 残弾。0 になったら任務は消える */
  roundsLeft: number;
  /** 次の1発が着弾するティック */
  nextImpactTick: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 実行時チューニング(`[v6.1]` — デバッグUIのスライダー)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `constants.ts` の共通スカラーの実行時オーバーライド。`createWorld` で定数そのままの
 * 値で初期化されるので、**触らなければ現状と完全一致**する(対称性・決定論テストは
 * これを触らないため不変)。デバッグパネルのスライダーだけがこれを書き換える。
 */
export interface Tuning {
  /** 索敵距離 m(既定 DETECT_RANGE) */
  detectRange: number;
  /** 前方視界扇形の半角 rad(既定 FOV_HALF_RAD) */
  fovHalfRad: number;
  /** 実射に必要な正対精度 rad(既定 FIRE_ALIGN_RAD) */
  fireAlignRad: number;
  /** 基本移動速度 m/s(既定 MOVE_SPEED) */
  moveSpeed: number;
  /** 旋回速度 rad/s(既定 TURN_RATE) */
  turnRate: number;
}

/**
 * 陣営ごとの「性格」パラメータ(`[v6.1]`)。squad-12v12 モックの「チーム別 性格
 * パラメータ」相当。**すべて identity(乗数1・絶対値は現行定数)で初期化される**ので、
 * デバッグスライダーを動かさなければ挙動は現行と厳密一致し、戦力対称性(仕様 §2/§13)も
 * 決定論も保たれる。
 *
 * `riskTolerance` は表示・一括操作用のマスター(0..1、0.5 で全係数 identity)。
 * シムが読むのは下の個別値。マスタースライダーを動かすと個別値がまとめて再計算される。
 *
 * 陣営レベルの性格。兵士個体の性格(`Soldier.traits`、仕様 §14)は `[v6.2]` から別に効いている(traits.ts)。
 */
export interface Posture {
  /** マスター 0..1(0.5 = 全 identity)。UI表示と一括操作用 */
  riskTolerance: number;
  /** 最小交戦距離への乗数(<1 で詰める) */
  engageMinMul: number;
  /** 最大交戦距離への乗数 */
  engageMaxMul: number;
  /** 躍進歩幅・最小への乗数 */
  boundMinMul: number;
  /** 躍進歩幅・最大への乗数(>1 で大胆) */
  boundMaxMul: number;
  /** 後退を判断する劣勢人数差(絶対値。既定 = FALLBACK_DEFICIT) */
  fallbackDeficit: number;
  /** 小隊長の移動技術しきい距離への乗数(<1 で近づくまで警戒しない) */
  techniqueRangeMul: number;
  /** 経路・隊形の露出回避度(1 = 現行、>1 で露出を嫌う) */
  coverPref: number;
  /** F-2 攻勢分遣の発動兵力比(既定 1.3)。中隊AIが読む */
  offensiveRatio: number;
}
