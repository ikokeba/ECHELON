import { describe, it, expect } from "vitest";
import { createRng, next, randRange, randInt, chance, ratePerTick, pick } from "../src/sim/rng.ts";

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 100 }, () => next(a));
    const seqB = Array.from({ length: 100 }, () => next(b));
    expect(seqA).toEqual(seqB);
  });

  it("diverges for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(next(a)).not.toEqual(next(b));
  });

  it("produces floats in [0, 1)", () => {
    const r = createRng(99);
    for (let i = 0; i < 10000; i++) {
      const v = next(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("randRange stays within bounds", () => {
    const r = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = randRange(r, -3, 8);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(8);
    }
  });

  it("randInt covers the inclusive range", () => {
    const r = createRng(42);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(randInt(r, 1, 6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("chance(p) frequency tracks p", () => {
    const r = createRng(2024);
    let hits = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) if (chance(r, 0.25)) hits++;
    expect(hits / n).toBeGreaterThan(0.24);
    expect(hits / n).toBeLessThan(0.26);
  });

  it("ratePerTick converts a per-second rate to a per-tick probability", () => {
    // A 0.075/s rate over a 0.2s tick ≈ the mos-balance mock's 0.015/tick.
    expect(ratePerTick(0.075, 0.2)).toBeCloseTo(0.0149, 3);
    expect(ratePerTick(0, 1 / 30)).toBe(0);
  });

  it("pick returns undefined for empty and an element otherwise", () => {
    const r = createRng(5);
    expect(pick(r, [])).toBeUndefined();
    const arr = ["a", "b", "c"] as const;
    expect(arr).toContain(pick(r, arr));
  });
});
