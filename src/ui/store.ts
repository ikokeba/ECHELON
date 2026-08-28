/**
 * Zustand ストア — シム状態のReact側ミラーであり、UIの意図(ポーズ/速度/ステップ/選択)を
 * 記録する場所。ランタイムループが毎フレームここから意図を読み、小さなHUDスナップショットを
 * 書き戻す。**毎ティックのシミュレーションデータは決してここに置かない**
 * (design §2、およびモックの「React stateはHUD専用」規則)。
 */

import { create } from "zustand";
import { SPEED_STEPS } from "@sim/constants.ts";

export interface HudSnapshot {
  tick: number;
  simSeconds: number;
  blueAlive: number;
  redAlive: number;
  blueEffective: number;
  redEffective: number;
}

interface UiState extends HudSnapshot {
  paused: boolean;
  /** 非ポーズ時の速度を指す SPEED_STEPS のindex */
  speedIdx: number;
  /** ポーズ中に1ステップ実行を要求するためのカウンタ */
  stepNonce: number;
  selectedSoldierId: number | null;

  togglePause: () => void;
  cycleSpeed: () => void;
  requestStep: () => void;
  select: (id: number | null) => void;
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

  paused: false,
  speedIdx: RUN_SPEEDS.indexOf(1) >= 0 ? RUN_SPEEDS.indexOf(1) : 0,
  stepNonce: 0,
  selectedSoldierId: null,

  togglePause: () => set((s) => ({ paused: !s.paused })),
  cycleSpeed: () => set((s) => ({ speedIdx: (s.speedIdx + 1) % RUN_SPEEDS.length })),
  requestStep: () => set((s) => ({ stepNonce: s.stepNonce + 1 })),
  select: (id) => set({ selectedSoldierId: id }),
  pushHud: (snap) => set(snap),
}));

/** 現在の実効時間倍率(ポーズ中は0)。 */
export function currentSpeed(s: Pick<UiState, "paused" | "speedIdx">): number {
  return s.paused ? 0 : (RUN_SPEEDS[s.speedIdx] ?? 1);
}
