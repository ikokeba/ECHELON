import { describe, it, expect } from "vitest";
import { createSimClock, drainTicks, requestSteps, setSpeed, renderAlpha } from "../src/sim/loop.ts";
import { SIM_DT } from "../src/sim/constants.ts";

describe("SimClock", () => {
  it("runs one tick per SIM_DT of scaled real time at speed 1", () => {
    const c = createSimClock(1);
    expect(drainTicks(c, SIM_DT * 1000)).toBe(1);
    expect(drainTicks(c, SIM_DT * 1000 * 3)).toBe(3);
  });

  it("runs nothing while paused, but honours explicit steps", () => {
    const c = createSimClock(1);
    setSpeed(c, 0);
    expect(drainTicks(c, 1000)).toBe(0);
    requestSteps(c, 2);
    expect(drainTicks(c, 0)).toBe(2);
    expect(drainTicks(c, 0)).toBe(0);
  });

  it("scales with the speed multiplier", () => {
    const c = createSimClock(2);
    expect(drainTicks(c, SIM_DT * 1000)).toBe(2);
  });

  it("caps catch-up at maxTicksPerFrame and drops the backlog", () => {
    const c = createSimClock(1);
    const ticks = drainTicks(c, 100_000); // absurd stall
    expect(ticks).toBe(c.maxTicksPerFrame);
    expect(c.accumulator).toBe(0);
  });

  it("renderAlpha is 0 while paused and within [0,1) while running", () => {
    const c = createSimClock(1);
    setSpeed(c, 0);
    expect(renderAlpha(c)).toBe(0);
    setSpeed(c, 1);
    drainTicks(c, SIM_DT * 1000 * 0.5);
    const a = renderAlpha(c);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });
});
