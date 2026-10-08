import { describe, it, expect } from "vitest";
import { castRay, collidesWall, hasLineOfSight } from "../src/sim/geometry.ts";
import {
  buildWallIndex,
  castRayIndexed,
  collidesWallIndexed,
  hasLineOfSightIndexed,
} from "../src/sim/wallIndex.ts";
import { companyClashScenario, urbanAssaultScenario } from "../src/sim/scenario.ts";
import { createRng, next } from "../src/sim/rng.ts";
import type { Bounds, Scenario } from "../src/sim/types.ts";

/**
 * 壁の空間索引(`[v6.2]`)は**性能のためだけ**の仕組みであり、答えを変えてはならない。
 * 全数走査と1ビットでも違えば、決定性(README の不変条件)と戦力対称性(仕様 §2/§13)が
 * 静かに壊れる。市街地マップの実データに対して総当たりで突き合わせる。
 */
describe("壁の空間索引は全数走査と厳密に一致する(`[v6.2]`)", () => {
  const cases: Array<[string, Scenario]> = [
    ["中隊市街地", companyClashScenario(1)],
    ["小隊市街地", urbanAssaultScenario(1)],
  ];

  for (const [name, sc] of cases) {
    const idx = buildWallIndex(sc.walls, sc.bounds);

    it(`${name}: castRay が一致する`, () => {
      const rng = createRng(12345);
      const b: Bounds = sc.bounds;
      for (let i = 0; i < 4000; i++) {
        const ox = b.minX + next(rng) * (b.maxX - b.minX);
        const oz = b.minZ + next(rng) * (b.maxZ - b.minZ);
        const a = next(rng) * Math.PI * 2;
        const dx = Math.sin(a);
        const dz = Math.cos(a);
        // 近距離(索敵)と長距離(選抜射手)の両方を踏む
        const maxDist = i % 8 === 0 ? 300 : 20;
        expect(castRayIndexed(idx, ox, oz, dx, dz, maxDist)).toBe(
          castRay(sc.walls, ox, oz, dx, dz, maxDist),
        );
      }
    });

    it(`${name}: hasLineOfSight が一致する`, () => {
      const rng = createRng(999);
      const b: Bounds = sc.bounds;
      for (let i = 0; i < 3000; i++) {
        const ox = b.minX + next(rng) * (b.maxX - b.minX);
        const oz = b.minZ + next(rng) * (b.maxZ - b.minZ);
        const a = next(rng) * Math.PI * 2;
        const d = next(rng) * 40;
        const ex = ox + Math.sin(a) * d;
        const ez = oz + Math.cos(a) * d;
        expect(hasLineOfSightIndexed(idx, ox, oz, ex, ez)).toBe(
          hasLineOfSight(sc.walls, ox, oz, ex, ez),
        );
      }
    });

    it(`${name}: collidesWall が一致する`, () => {
      const rng = createRng(777);
      const b: Bounds = sc.bounds;
      for (let i = 0; i < 8000; i++) {
        const x = b.minX + next(rng) * (b.maxX - b.minX);
        const z = b.minZ + next(rng) * (b.maxZ - b.minZ);
        const r = 0.2 + next(rng) * 0.6;
        expect(collidesWallIndexed(idx, x, z, r)).toBe(collidesWall(sc.walls, x, z, r));
      }
    });
  }

  it("盤外の問い合わせでも一致する(視線原点が境界にかかる場合)", () => {
    const sc = companyClashScenario(1);
    const idx = buildWallIndex(sc.walls, sc.bounds);
    const outside = [
      [sc.bounds.minX - 30, 0],
      [sc.bounds.maxX + 30, 0],
      [0, sc.bounds.minZ - 30],
      [0, sc.bounds.maxZ + 30],
    ] as const;
    for (const [ox, oz] of outside) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        expect(castRayIndexed(idx, ox, oz, Math.sin(a), Math.cos(a), 300)).toBe(
          castRay(sc.walls, ox, oz, Math.sin(a), Math.cos(a), 300),
        );
      }
      expect(collidesWallIndexed(idx, ox, oz, 0.35)).toBe(collidesWall(sc.walls, ox, oz, 0.35));
    }
  });
});
