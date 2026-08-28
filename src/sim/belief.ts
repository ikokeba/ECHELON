/**
 * 接触報告の確度減衰(仕様 §5)。
 *
 * 仕様は3点を確定値としている: 30秒 → 80%、90秒 → 50%、180秒 → 消滅。
 * 減衰を駆動するのは経過時間のみで、敵の移動は無関係。
 *
 * `[v6]` 3点の間の補間形状は線形補間で確定(3点を厳密に通る)。階段状の離散低下は
 * 採用しない — 境界をまたぐ瞬間にAIの判断が急変してしまうため。
 */

import { CONFIDENCE_POINTS } from "./constants.ts";

/** `ageSeconds` 秒前に観測された接触の確度 [0,1]。 */
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
