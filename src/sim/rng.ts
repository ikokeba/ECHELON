/**
 * Deterministic pseudo-random number generator for the simulation.
 *
 * The prototype mocks all use `Math.random()`, which makes replay, regression
 * tests, and the force-symmetry test impossible. The integrated sim routes ALL
 * randomness through one seeded stream held in world state. `Math.random` is
 * lint-banned under src/sim/.
 *
 * Algorithm: mulberry32 — small, fast, good enough for gameplay. Not for crypto.
 */

export interface Rng {
  /** raw 32-bit state; serialisable, so replays and snapshots are exact */
  state: number;
}

export function createRng(seed: number): Rng {
  // force to uint32
  return { state: seed >>> 0 };
}

/** Advance the stream and return a float in [0, 1). Mutates `rng`. */
export function next(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) | 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Float in [min, max). */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + next(rng) * (max - min);
}

/** Integer in [min, max] inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(next(rng) * (max - min + 1));
}

/** True with probability p (0..1). */
export function chance(rng: Rng, p: number): boolean {
  return next(rng) < p;
}

/**
 * Convert a per-second rate to a per-tick probability for a Poisson-like event.
 * The mos-balance mock expressed hit/suppress chances per 0.2s tick; the
 * integrated sim runs at a different rate, so rates are stored per-second in
 * constants.ts and converted here.
 */
export function ratePerTick(ratePerSecond: number, dtSeconds: number): number {
  return 1 - Math.exp(-ratePerSecond * dtSeconds);
}

/** Uniformly pick an element; returns undefined for an empty array. */
export function pick<T>(rng: Rng, arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(next(rng) * arr.length)];
}
