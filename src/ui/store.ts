/**
 * Zustand ストア — シム状態のReact側ミラーであり、UIの意図(ポーズ/速度/ステップ/選択)を
 * 記録する場所。ランタイムループが毎フレームここから意図を読み、小さなHUDスナップショットを
 * 書き戻す。**毎ティックのシミュレーションデータは決してここに置かない**
 * (design §2、およびモックの「React stateはHUD専用」規則)。
 */

import { create } from "zustand";
import { SPEED_STEPS } from "@sim/constants.ts";
import type { Side } from "@sim/types.ts";

/**
 * プレイヤーがいま「どの立場で戦場を見ているか」。
 *
 * 仕様 §5 の中核: 描画は選択した階層の world picture(belief)に基づいて行う。
 * 神視点(ground truth)は開発用のデバッグ表示としてのみ残す。
 */
export type ViewEchelon = "platoon" | "squad" | "truth";

export interface HudSnapshot {
  tick: number;
  simSeconds: number;
  blueAlive: number;
  redAlive: number;
  blueEffective: number;
  redEffective: number;
  /** 現在の視点階層が把握している敵接触の件数 */
  knownContacts: number;
  /** そのうち確度0まで落ちた「最終目撃情報」の件数 */
  staleContacts: number;
}

interface UiState extends HudSnapshot {
  paused: boolean;
  /** 非ポーズ時の速度を指す SPEED_STEPS のindex */
  speedIdx: number;
  /** ポーズ中に1ステップ実行を要求するためのカウンタ */
  stepNonce: number;
  selectedSoldierId: number | null;

  /** どの陣営の立場で見るか */
  viewSide: Side;
  /** どの階層の world picture を見るか */
  viewEchelon: ViewEchelon;
  /** viewEchelon === "squad" のときに覗く分隊 */
  viewSquadId: number | null;

  togglePause: () => void;
  cycleSpeed: () => void;
  requestStep: () => void;
  select: (id: number | null) => void;
  setViewSide: (side: Side) => void;
  setViewEchelon: (e: ViewEchelon) => void;
  setViewSquadId: (id: number | null) => void;
  pushHud: (snap: HudSnapshot) => void;
}

/** 実行中の速度のみ(SPEED_STEPS[0] の 0 を除く) */
export const RUN_SPEEDS = SPEED_STEPS.filter((s) => s > 0);

export const useSimStore = create<UiState>((set) => ({
  tick: 0,
  simSeconds: 0,
  blueAlive: 0,
  redAlive: 0,
  blueEffective: 0,
  redEffective: 0,
  knownContacts: 0,
  staleContacts: 0,

  paused: false,
  speedIdx: RUN_SPEEDS.indexOf(1) >= 0 ? RUN_SPEEDS.indexOf(1) : 0,
  stepNonce: 0,
  selectedSoldierId: null,

  viewSide: "blue",
  viewEchelon: "platoon",
  viewSquadId: null,

  togglePause: () => set((s) => ({ paused: !s.paused })),
  cycleSpeed: () => set((s) => ({ speedIdx: (s.speedIdx + 1) % RUN_SPEEDS.length })),
  requestStep: () => set((s) => ({ stepNonce: s.stepNonce + 1 })),
  select: (id) => set({ selectedSoldierId: id }),
  setViewSide: (side) => set({ viewSide: side }),
  setViewEchelon: (e) => set({ viewEchelon: e }),
  setViewSquadId: (id) => set({ viewSquadId: id }),
  pushHud: (snap) => set(snap),
}));

/** 現在の実効時間倍率(ポーズ中は0)。 */
export function currentSpeed(s: Pick<UiState, "paused" | "speedIdx">): number {
  return s.paused ? 0 : (RUN_SPEEDS[s.speedIdx] ?? 1);
}
