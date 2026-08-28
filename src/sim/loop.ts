/**
 * Fixed-timestep accumulator. Pure: the caller feeds it elapsed real
 * milliseconds (from an rAF driver living outside src/sim/) and it returns how
 * many sim ticks to run this frame. This is what makes tactical pause, slow-mo,
 * fast-forward and single-step trivial (spec §1/§6: pause with zero-lag resume).
 */

import { SIM_DT } from "./constants.ts";

export interface SimClock {
  /** unconsumed simulated seconds carried between frames */
  accumulator: number;
  /** time-scale multiplier; 0 = paused */
  speed: number;
  /** queued single-step ticks to run regardless of speed (used while paused) */
  stepQueue: number;
  /** never run more than this many ticks in one frame (spiral-of-death guard) */
  maxTicksPerFrame: number;
}

export function createSimClock(speed = 1): SimClock {
  return { accumulator: 0, speed, stepQueue: 0, maxTicksPerFrame: 8 };
}

export function setSpeed(clock: SimClock, speed: number): void {
  clock.speed = Math.max(0, speed);
  if (clock.speed === 0) clock.accumulator = 0; // paused: don't bank real time
}

/** Queue N ticks to execute on the next drain even while paused. */
export function requestSteps(clock: SimClock, n = 1): void {
  clock.stepQueue += n;
}

/**
 * Given real elapsed milliseconds, return how many fixed ticks to run now and
 * update the clock. Explicit single-step requests are always honoured first.
 */
export function drainTicks(clock: SimClock, realElapsedMs: number): number {
  let ticks = 0;

  if (clock.stepQueue > 0) {
    ticks += clock.stepQueue;
    clock.stepQueue = 0;
  }

  if (clock.speed > 0) {
    clock.accumulator += (realElapsedMs / 1000) * clock.speed;
    while (clock.accumulator >= SIM_DT && ticks < clock.maxTicksPerFrame) {
      clock.accumulator -= SIM_DT;
      ticks += 1;
    }
    if (clock.accumulator > SIM_DT * clock.maxTicksPerFrame) {
      clock.accumulator = 0; // dropped frames: give up the backlog
    }
  }

  return ticks;
}

/** Interpolation alpha in [0,1) for rendering between the last two sim states. */
export function renderAlpha(clock: SimClock): number {
  return clock.speed > 0 ? Math.min(1, Math.max(0, clock.accumulator / SIM_DT)) : 0;
}
