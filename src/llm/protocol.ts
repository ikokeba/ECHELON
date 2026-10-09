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
export const PROTOCOL_VERSION = "echelon-llm/0.2";

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
}

/** エージェントが出せる命令の説明。座席の階層で変わる */
export interface CommandSpec {
  type: AgentCommand["type"];
  description: string;
}

export interface Observation {
  protocol: typeof PROTOCOL_VERSION;
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
export type AgentCommand =
  | MoveCommand
  | AssignCommand
  | CasevacCommand
  | HoldCommand
  | ReinforceCommand
  | FireMissionCommand;

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
          type: { type: "string", enum: ["move", "assign", "casevac", "hold", "reinforce", "fire_mission"] },
          unit: { type: "integer", description: "assign の対象(subordinates[].unit)" },
          mission: { type: "string", enum: ["seize", "support_by_fire", "screen"] },
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
