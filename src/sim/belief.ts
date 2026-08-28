/**
 * Confidence decay for contact reports (spec §5).
 *
 * The spec fixes three points as 確定値: 30s → 80%, 90s → 50%, 180s → gone.
 * Decay is driven by elapsed time only — enemy movement is irrelevant. The
 * interpolation shape between those points is OQ-2 (docs/design/00 §6); the
 * current choice is piecewise-linear, which passes exactly through all three.
 */

import { CONFIDENCE_POINTS } from "./constants.ts";

/** Confidence in [0,1] for a contact last observed `ageSeconds` ago. */
export function decayedConfidence(ageSeconds: number): number {
  if (ageSeconds <= 0) return 1;
  const pts = CONFIDENCE_POINTS;
  const last = pts[pts.length - 1]!;
  if (ageSeconds >= last[0]) return last[1];

  for (let i = 1; i < pts.length; i++) {
    const [t1, c1] = pts[i]!;
    if (ageSeconds <= t1) {
      const [t0, c0] = pts[i - 1]!;
      const f = (ageSeconds - t0) / (t1 - t0);
      return c0 + (c1 - c0) * f;
    }
  }
  return last[1];
}
