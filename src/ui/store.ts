/**
 * Zustand store — the React-facing mirror of sim state and the place UI intent
 * (pause / speed / step / selection) is recorded. The runtime loop reads intent
 * from here each frame and writes back a small HUD snapshot. Per-tick simulation
 * data never lives here (design §2, mocks' "React state is HUD only" rule).
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
  /** index into SPEED_STEPS for the running (non-paused) speed */
  speedIdx: number;
  /** bump to request one single sim step while paused */
  stepNonce: number;
  selectedSoldierId: number | null;

  togglePause: () => void;
  cycleSpeed: () => void;
  requestStep: () => void;
  select: (id: number | null) => void;
  pushHud: (snap: HudSnapshot) => void;
}

/** running speeds only (drop the 0 that sits at SPEED_STEPS[0]) */
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

/** current effective time-scale (0 while paused). */
export function currentSpeed(s: Pick<UiState, "paused" | "speedIdx">): number {
  return s.paused ? 0 : (RUN_SPEEDS[s.speedIdx] ?? 1);
}
