import { describe, it, expect } from "vitest";
import { buildNavGrid, findPath, nearestNavNode } from "../src/sim/navgrid.ts";
import { advanceAlongPath } from "../src/sim/pathfollow.ts";
import { hasLineOfSight } from "../src/sim/geometry.ts";
import type { AABB, Bounds } from "../src/sim/types.ts";

const bounds: Bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

describe("buildNavGrid", () => {
  it("excludes nodes inside walls", () => {
    const walls: AABB[] = [{ cx: 0, cz: 0, hw: 2, hd: 2 }];
    const grid = buildNavGrid(walls, bounds, 1, 0.4);
    for (const node of grid.nodes) {
      expect(Math.abs(node.x) > 2.3 || Math.abs(node.z) > 2.3).toBe(true);
    }
  });

  it("drops edges that cross a wall", () => {
    const walls: AABB[] = [{ cx: 0, cz: 0, hw: 5, hd: 0.3 }]; // long thin east-west wall
    const grid = buildNavGrid(walls, bounds, 1, 0.4);
    for (let i = 0; i < grid.nodes.length; i++) {
      const a = grid.nodes[i]!;
      for (const [j] of grid.adj[i]!) {
        const b = grid.nodes[j]!;
        expect(hasLineOfSight(walls, a.x, a.z, b.x, b.z)).toBe(true);
      }
    }
  });
});

describe("findPath", () => {
  it("finds a straight path in open space", () => {
    const grid = buildNavGrid([], bounds, 1, 0.4);
    const path = findPath(grid, -8, 0, 8, 0);
    expect(path).not.toBeNull();
    expect(path!.at(-1)).toEqual({ x: 8, z: 0 });
    // no waypoint should stray far from the z=0 line
    for (const wp of path!) expect(Math.abs(wp.z)).toBeLessThan(1.5);
  });

  it("routes around a blocking wall with a gap on one side", () => {
    // wall spans x:-10..6, leaving a ~4m gap at the east end
    const walls: AABB[] = [{ cx: -2, cz: 0, hw: 8, hd: 0.3 }];
    const grid = buildNavGrid(walls, bounds, 1, 0.4);
    const path = findPath(grid, 0, -8, 0, 8);
    expect(path).not.toBeNull();
    // it must detour east of the wall's end (x ~ 6+)
    expect(Math.max(...path!.map((p) => p.x))).toBeGreaterThan(5);
  });

  it("returns null when the target is walled off", () => {
    const walls: AABB[] = [
      { cx: 0, cz: 3, hw: 3, hd: 0.3 },
      { cx: 0, cz: -3, hw: 3, hd: 0.3 },
      { cx: 3, cz: 0, hw: 0.3, hd: 3 },
      { cx: -3, cz: 0, hw: 0.3, hd: 3 },
    ];
    const grid = buildNavGrid(walls, bounds, 0.5, 0.35);
    const path = findPath(grid, 0, 0, 9, 9); // from inside the sealed box to outside
    expect(path).toBeNull();
  });
});

describe("nearestNavNode", () => {
  it("snaps a point inside a wall to a nearby free node", () => {
    const walls: AABB[] = [{ cx: 0, cz: 0, hw: 2, hd: 2 }];
    const grid = buildNavGrid(walls, bounds, 1, 0.4);
    const idx = nearestNavNode(grid, 0, 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    const n = grid.nodes[idx]!;
    expect(Math.hypot(n.x, n.z)).toBeLessThan(4.5);
  });
});

describe("advanceAlongPath", () => {
  const path = [
    { x: 0, z: 0 },
    { x: 10, z: 0 },
  ];

  it("moves along the segment by the budget", () => {
    const s = advanceAlongPath({ x: 0, z: 0 }, path, 1, 3);
    expect(s.pos.x).toBeCloseTo(3, 6);
    expect(s.arrived).toBe(false);
    expect(s.dir).toEqual({ x: 1, z: 0 });
  });

  it("arrives and clamps at the final waypoint", () => {
    const s = advanceAlongPath({ x: 9, z: 0 }, path, 1, 5);
    expect(s.pos.x).toBeCloseTo(10, 6);
    expect(s.arrived).toBe(true);
  });

  it("reports arrived immediately for an empty path", () => {
    const s = advanceAlongPath({ x: 1, z: 2 }, [], 0, 5);
    expect(s.arrived).toBe(true);
    expect(s.pos).toEqual({ x: 1, z: 2 });
  });
});
