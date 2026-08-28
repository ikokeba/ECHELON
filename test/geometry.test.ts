import { describe, it, expect } from "vitest";
import {
  rayAABB,
  castRay,
  hasLineOfSight,
  collidesWall,
  edgeIsClear,
  nearestWallDist,
  normalize,
} from "../src/sim/geometry.ts";
import type { AABB } from "../src/sim/types.ts";

// A single 2m-wide, 0.6m-thick wall centred at the origin.
const wall: AABB = { cx: 0, cz: 0, hw: 1, hd: 0.3 };
const walls = [wall];

describe("rayAABB", () => {
  it("hits a wall straight ahead at the expected distance", () => {
    // origin 5m south of the wall, aiming north (+z)
    const t = rayAABB(0, -5, 0, 1, wall, 100);
    expect(t).not.toBeNull();
    expect(t).toBeCloseTo(4.7, 5); // 5 - hd(0.3)
  });

  it("misses when the ray points away from the wall", () => {
    expect(rayAABB(0, -5, 0, -1, wall, 100)).toBeNull();
  });

  it("respects maxDist", () => {
    expect(rayAABB(0, -5, 0, 1, wall, 3)).toBeNull();
  });
});

describe("castRay", () => {
  it("returns the nearest hit, capped at maxDist", () => {
    expect(castRay(walls, 0, -5, 0, 1, 100)).toBeCloseTo(4.7, 5);
    expect(castRay(walls, 0, -5, 0, 1, 2)).toBe(2);
    expect(castRay([], 0, -5, 0, 1, 100)).toBe(100);
  });
});

describe("hasLineOfSight", () => {
  it("is blocked when a wall sits between the endpoints", () => {
    expect(hasLineOfSight(walls, 0, -5, 0, 5)).toBe(false);
  });

  it("is clear when the path goes around the wall", () => {
    expect(hasLineOfSight(walls, 5, -5, 5, 5)).toBe(true);
  });

  it("is clear with no walls at all", () => {
    expect(hasLineOfSight([], 0, -5, 0, 5)).toBe(true);
  });

  it("is trivially clear for coincident points", () => {
    expect(hasLineOfSight(walls, 0, 0, 0, 0)).toBe(true);
  });
});

describe("collidesWall", () => {
  it("detects a disc overlapping the wall box + radius", () => {
    expect(collidesWall(walls, 0, 0, 0.35)).toBe(true);
    expect(collidesWall(walls, 1.2, 0, 0.35)).toBe(true); // within hw(1)+r(0.35)
  });

  it("is false when the disc clears the inflated box", () => {
    expect(collidesWall(walls, 2, 2, 0.35)).toBe(false);
  });
});

describe("edgeIsClear", () => {
  it("rejects an edge that grazes a wall corner within the margin", () => {
    // an edge running just past the wall's east end at z=0
    expect(edgeIsClear(walls, 1.05, -1, 1.05, 1, 0.18)).toBe(false);
  });

  it("accepts an edge well clear of the wall", () => {
    expect(edgeIsClear(walls, 5, -1, 5, 1, 0.18)).toBe(true);
  });
});

describe("nearestWallDist", () => {
  it("is 0 inside a wall and positive outside", () => {
    expect(nearestWallDist(walls, 0, 0)).toBe(0);
    expect(nearestWallDist(walls, 0, -2)).toBeCloseTo(1.7, 5);
  });
});

describe("normalize", () => {
  it("returns a unit vector", () => {
    const n = normalize({ x: 3, z: 4 });
    expect(Math.hypot(n.x, n.z)).toBeCloseTo(1, 10);
  });
});
