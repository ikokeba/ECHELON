import { describe, it, expect } from "vitest";
import { closeRangeBoost, rangeAccMul } from "../src/sim/systems/combat.ts";
import { HIT_RATE_PER_SEC, WEAPON_RANGE } from "../src/sim/constants.ts";

/**
 * 近距離の命中率(`[v7.1]`)。一発で負傷/戦死する仕組みは変えず、「当たるまでの時間」を
 * 距離に見合ったものにする。以前は25m以内でも平均13秒かかっていた。
 */
const meanSecToHit = (range: number): number =>
  1 /
  (HIT_RATE_PER_SEC * rangeAccMul(range, WEAPON_RANGE.rifle.detect) * closeRangeBoost(range));

describe("近距離ほど当たる", () => {
  it("平均の被弾までの時間: 10m 約1.5秒 / 25m 約4秒 / 60m 約10秒 / 100m 約22秒", () => {
    expect(meanSecToHit(5)).toBeCloseTo(1.5, 0);
    expect(meanSecToHit(10)).toBeCloseTo(1.5, 0);
    expect(meanSecToHit(25)).toBeCloseTo(4, 0);
    expect(meanSecToHit(60)).toBeGreaterThan(9);
    expect(meanSecToHit(60)).toBeLessThan(11);
    expect(meanSecToHit(100)).toBeGreaterThan(19);
    expect(meanSecToHit(100)).toBeLessThan(25);
  });

  it("距離が伸びるほど単調に当たりにくくなる", () => {
    let prev = 0;
    for (let r = 1; r <= 150; r += 1) {
      const t = meanSecToHit(r);
      expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = t;
    }
  });
});
