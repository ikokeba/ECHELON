/**
 * LLM(外部エージェント)とシミュレーションのあいだの通信口(`[v7.0]`)。
 *
 * 設計の全体像は `docs/LLM連携_設計.md`。ここに置くのは**やり取りされるデータの形**だけ:
 *
 *   シム ──観測(Observation)──▶ エージェント
 *   シム ◀──応答(AgentResponse)── エージェント
 *
 * ── 守っている一線 ──
 *   1. **情報階層(仕様 §5)を迂回しない。** 観測に入る敵情報は、エージェントが座っている
 *      指揮官の belief(無線で届いた、遅れて粗い像)だけ。真の敵位置は一切渡さない。
 *   2. **能力を足さない(仕様 §4)。** 出せる命令は、人間がその座席でホットスワップした
 *      ときに出せる命令・AIの指揮官が出している命令と同じものだけ。
 *   3. **陣営を名前で渡さない(仕様 §2/§13)。** 観測の中の陣営は "own" / "enemy" に
 *      読み替える。青でも赤でも、エージェントには同じ形の盤面に見える。
 *
 * 形式は素の JSON。LM Studio の構造化出力(`response_format: json_schema`)へそのまま
 * 渡せるよう、応答の JSON Schema もここで定義する。
 */

import type { Echelon, MissionKind, Side, Vec2 } from "../sim/types.ts";

/** プロトコルの版。形を変えたら上げる。エージェント側はこれを見て解釈を切り替えられる */
export const PROTOCOL_VERSION = "echelon-llm/0.7";

/** エージェントが座れる階層。兵士・FTは毎ティックの反射が要るので対象外(設計書 §3) */
export type AgentEchelon = Extract<Echelon, "company" | "platoon" | "squad">;
export const AGENT_ECHELONS: readonly AgentEchelon[] = ["company", "platoon", "squad"];

/** エージェントの座席。人間の操作枠(`ControlState`)と同じ形 */
export interface AgentSeat {
  side: Side;
  echelon: AgentEchelon;
  /** company=companyId / platoon=platoonId / squad=squadId */
  unitId: number;
}

/** 陣営を相対で表す("own" = エージェント自身の陣営) */
export type RelSide = "own" | "enemy";

export interface ObsObjective {
  id: number;
  label: string;
  pos: Vec2;
  radius: number;
  owner: RelSide | null;
  /** 確保の進捗 0..1 */
  progress: number;
  progressBy: RelSide | null;
  contested: boolean;
}

/** 麾下の部隊1つ。中隊なら小隊、小隊なら分隊、分隊ならFT */
export interface ObsSubordinate {
  /** 命令の `unit` に入れる識別子 */
  unit: number;
  kind: "platoon" | "squad" | "fireteam";
  /** 表示名(例: "第2小隊")。命令には使わない */
  name: string;
  /** 報告された重心。分隊座席のFTは直接見えている位置 */
  pos: Vec2;
  /** 健在 / 編成 */
  effective: number;
  total: number;
  /** いま下りている任務(分かっていれば) */
  mission?: { kind: MissionKind; target: Vec2 };
  /** 報告の古さ s(無線経由のとき)。直接見えているなら 0 */
  ageSec: number;
  /** FTの状態(分隊座席のみ。ADVANCE/CONTACT/…) */
  mode?: string;
  /** 火器分隊(機関銃班)なら true */
  weapons?: boolean;
}

/** 指揮官が把握している敵の接触1件(belief そのもの。真の位置ではない) */
export interface ObsContact {
  pos: Vec2;
  /** 位置誤差の概算半径 m */
  posError: number;
  /** 確度 0..1 */
  confidence: number;
  /** 最後に観測されてからの秒数 */
  ageSec: number;
  count?: number;
  /** 見たのではなく銃声で聞いた接触(`[v7.3]`)。方角とだいたいの距離だけで、位置は粗い */
  heard?: boolean;
}

/** エージェントが出せる命令の説明。座席の階層で変わる */
export interface CommandSpec {
  type: AgentCommand["type"];
  description: string;
}

/**
 * 中隊長の作戦(`[v7.3]` ロードマップ A-1)。中隊長の座席にだけ載る。
 * 立案中(`phase: "planning"`)は `plan` 命令で書き換えられる
 */
export interface ObsPlan {
  /** 主攻(防御なら主陣地)の拠点 id */
  mainObjective: number | null;
  tasks: Array<{
    unit: number;
    name: string;
    role: "main" | "supporting" | "reserve";
    mission: MissionKind;
    /** 対象の拠点 id(予備は null) */
    objective: number | null;
    /** 開始時刻(戦闘開始からの秒) */
    startSec: number;
    /** 経由点 */
    via: Vec2[];
  }>;
  phaseLine: [Vec2, Vec2] | null;
  fires: Array<{ target: Vec2; atSec: number }>;
}

export interface Observation {
  protocol: typeof PROTOCOL_VERSION;
  /** `[v7.3]` planning = 戦闘前の立案中(時間は止まっている。plan 命令だけが意味を持つ) */
  phase: "planning" | "battle";
  /** 戦闘開始からの経過 s */
  timeSec: number;
  tick: number;
  you: {
    echelon: AgentEchelon;
    unit: number;
    name: string;
    /** 指揮を執れる者がいるか(仕様 §12)。false なら命令は通らない */
    commanderAlive: boolean;
    /** 上から下りている任務(中隊座席では作戦目標) */
    mission?: { kind: MissionKind; target: Vec2 };
    /** 前進方向(単位ベクトル)。「前」がどちらかの手がかり */
    advanceDir: Vec2;
  };
  map: {
    /** 盤面の範囲 m。+X = 東、+Z = 南(画面の下) */
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    objectives: ObsObjective[];
  };
  subordinates: ObsSubordinate[];
  contacts: ObsContact[];
  /** 決着していれば勝った側 */
  victory: RelSide | null;
  /**
   * 後援部隊(`[v7.0]`)。この座席が要請できるときだけ載る。
   * callsLeft = あと何回呼べるか / pendingEtaSec = 要請済みで到着までの秒数
   */
  reinforcement?: {
    callsLeft: number;
    size: "squad" | "platoon";
    delaySec: number;
    pendingEtaSec: number[];
  };
  /**
   * 迫撃砲(`[v7.2]`)。中隊長の座席で、中隊が火力支援を持つときだけ載る。
   * roundsLeft = 残弾 / cooldownSec = 次に要請できるまでの秒数(0 なら今すぐ)/
   * inFlightEtaSec = 飛翔中の任務の初弾までの秒数(無ければ null)。
   * 射程は指揮所から minRange〜maxRange m、前線から dangerClose m 以内へは撃てない
   */
  fireSupport?: {
    roundsLeft: number;
    roundsPerMission: number;
    cooldownSec: number;
    inFlightEtaSec: number | null;
    commandPost: Vec2;
    minRange: number;
    maxRange: number;
    dangerClose: number;
    timeOfFlightSec: number;
  };
  /**
   * 発煙弾(`[v7.2]`)。分隊長の座席だけに載る。left = 残数 / cooldownSec = 次に焚けるまでの秒数 /
   * thrower = 投げる分隊長の位置(戦えなければ null)/ throwRange = 投げられる距離 m /
   * active = 盤上の煙(双方に見える)。煙は半径 radius の円の中を通る視線を遮る
   */
  /**
   * 観測ドローン(`[v7.3]` A-2)。中隊長の座席で、中隊がドローンを持つときだけ載る。
   * state = ready / flying / returning / swapping / lost / spent。ドローンが見たものは
   * 操縦手から無線で届く(contacts に遅れて入る)。真下 viewRadius m だけ、屋根の下と煙の中は見えない
   */
  drone?: {
    state: string;
    pos: Vec2;
    batteriesLeft: number;
    flightSec: number | null;
    viewRadius: number;
    maxRange: number;
    operator: Vec2 | null;
  };
  /**
   * 対戦車・対構造物火器(`[v7.3]` A-3)。分隊長の座席で、分隊に射手がいるときだけ載る。
   * gunner = 射手の位置(撃てなければ null)。射手から minRange〜maxRange m の、射線の通る点だけ撃てる
   */
  antiArmor?: {
    left: number;
    cooldownSec: number;
    gunner: Vec2 | null;
    minRange: number;
    maxRange: number;
  };
  smoke?: {
    left: number;
    cooldownSec: number;
    thrower: Vec2 | null;
    throwRange: number;
    radius: number;
    durationSec: number;
    active: { pos: Vec2; leftSec: number }[];
  };
  /** 中隊長の作戦(`[v7.3]`)。中隊長の座席のみ */
  plan?: ObsPlan;
  commands: CommandSpec[];
  /** 前回の応答をどう処理したか。エージェントが自分の誤りを直すための手がかり */
  lastResult: string[];
}

// ── 命令 ─────────────────────────────────────────────────────────

/** 座席の部隊(中隊/小隊/分隊)をまるごと地点へ向かわせる */
export interface MoveCommand {
  type: "move";
  target: Vec2;
}
/** 麾下の1部隊へ任務を下ろす(中隊→小隊、小隊→分隊) */
export interface AssignCommand {
  type: "assign";
  unit: number;
  mission: MissionKind;
  target: Vec2;
}
/** 止血済みの負傷者を後送する(分隊座席のみ、仕様 §9) */
export interface CasevacCommand {
  type: "casevac";
}
/** 何もしない(現在の命令を続ける) */
export interface HoldCommand {
  type: "hold";
}
/** 後援部隊を要請する(陣営の最上位の指揮官のみ、回数に上限あり)`[v7.0]` */
export interface ReinforceCommand {
  type: "reinforce";
}
/**
 * 迫撃砲の射撃を要請する(中隊長の座席のみ、`[v7.2]`)。照準点は要請時点で凍結され、
 * 飛翔時間のあいだに敵が動けば外れる
 */
export interface FireMissionCommand {
  type: "fire_mission";
  target: Vec2;
}
/** 発煙弾を地点へ焚く(分隊長の座席のみ、`[v7.2]`)。煙は視線だけを遮る */
export interface SmokeCommand {
  type: "smoke";
  target: Vec2;
}
/**
 * 作戦を書き換える(中隊長の座席・立案中のみ、`[v7.3]` ロードマップ A-1)。
 *   op=task       : unit の任務を mission(seize / support_by_fire / screen / reserve)と objective(拠点 id)に
 *   op=main       : objective を主攻(主陣地)に
 *   op=route      : unit の経由点を points に(空なら AI の経路)
 *   op=start      : unit の開始時刻を atSec 秒に
 *   op=phase_line : 調整線を points の2点に(空なら消す)
 *   op=fires      : 迫撃砲の射撃計画を fires で置き換える
 */
/** 観測ドローンを地点の上へ飛ばす(中隊長の座席のみ、`[v7.3]` A-2) */
export interface DroneCommand {
  type: "drone";
  target: Vec2;
}
/** 対戦車・対構造物火器を地点へ撃たせる(分隊長の座席のみ、`[v7.3]` A-3) */
export interface AntiArmorCommand {
  type: "anti_armor";
  target: Vec2;
}
export interface PlanCommand {
  type: "plan";
  op: "task" | "main" | "route" | "start" | "phase_line" | "fires";
  unit?: number;
  mission?: MissionKind | "reserve";
  objective?: number;
  points?: Vec2[];
  atSec?: number;
  fires?: Array<{ target: Vec2; atSec: number }>;
}
export type AgentCommand =
  | MoveCommand
  | AssignCommand
  | CasevacCommand
  | HoldCommand
  | ReinforceCommand
  | FireMissionCommand
  | SmokeCommand
  | PlanCommand
  | AntiArmorCommand
  | DroneCommand;

export interface AgentResponse {
  commands: AgentCommand[];
  /** 指揮官の意図(1文)。ログと画面表示に使う */
  intent?: string;
}

/** 1回の応答に含めてよい命令数の上限(暴走した出力で盤面を荒らさない) */
export const MAX_COMMANDS = 8;

/**
 * 応答の JSON Schema。LM Studio の `response_format: { type: "json_schema" }` へ渡す。
 * llama.cpp の文法制約に落とせる素直な形に留める(oneOf を使わない)。
 */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", description: "指揮官の意図を1文で" },
    commands: {
      type: "array",
      maxItems: MAX_COMMANDS,
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "move",
              "assign",
              "casevac",
              "hold",
              "reinforce",
              "fire_mission",
              "smoke",
              "plan",
              "anti_armor",
              "drone",
            ],
          },
          unit: { type: "integer", description: "assign / plan の対象(subordinates[].unit)" },
          mission: { type: "string", enum: ["seize", "support_by_fire", "screen", "reserve"] },
          op: { type: "string", enum: ["task", "main", "route", "start", "phase_line", "fires"] },
          objective: { type: "integer", description: "plan の対象の拠点 id" },
          atSec: { type: "number" },
          points: {
            type: "array",
            items: { type: "object", properties: { x: { type: "number" }, z: { type: "number" } }, required: ["x", "z"] },
          },
          fires: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: { type: "object", properties: { x: { type: "number" }, z: { type: "number" } }, required: ["x", "z"] },
                atSec: { type: "number" },
              },
              required: ["target", "atSec"],
            },
          },
          target: {
            type: "object",
            properties: { x: { type: "number" }, z: { type: "number" } },
            required: ["x", "z"],
          },
        },
        required: ["type"],
      },
    },
  },
  required: ["intent", "commands"],
} as const;
