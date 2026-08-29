import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { SCENARIOS, type ScenarioKey } from "../src/sim/scenario.ts";
import { findPathSet } from "../src/sim/navgrid.ts";
import type { Side } from "../src/sim/types.ts";

/**
 * シナリオの構造的な健全性。
 *
 * ここで見るのは戦術ではなく「盤面が壊れていないか」。実際に、中隊シナリオのCCPを
 * マップ境界の外に置いてしまい、ナビグリッドに存在しないため担架班が永久に
 * たどり着けない、という不具合を描画で発見した。以後は検証で捕まえる。
 */
describe("シナリオの健全性", () => {
  const keys = Object.keys(SCENARIOS) as ScenarioKey[];

  for (const key of keys) {
    describe(SCENARIOS[key].label, () => {
      it("CCPと指揮所がマップ境界の内側にある", () => {
        const w = createWorld(SCENARIOS[key].make(1));
        const inside = (p: { x: number; z: number }) =>
          p.x >= w.bounds.minX &&
          p.x <= w.bounds.maxX &&
          p.z >= w.bounds.minZ &&
          p.z <= w.bounds.maxZ;

        for (const side of ["blue", "red"] as Side[]) {
          expect(inside(w.ccp[side])).toBe(true);
        }
        for (const co of w.companies) expect(inside(co.cp)).toBe(true);
      });

      it("全兵士が自陣のCCPまで経路を持つ(担架搬送が成立する)", () => {
        const w = createWorld(SCENARIOS[key].make(1));
        for (const s of w.soldiers) {
          const ccp = w.ccp[s.side];
          const path = findPathSet(w.nav, s.pos.x, s.pos.z, ccp.x, ccp.z);
          expect(path, `soldier ${s.id} (${s.side}) はCCPへ到達できない`).not.toBeNull();
        }
      });

      it("両陣営の編成が完全に同一(仕様 §2/§13)", () => {
        const w = createWorld(SCENARIOS[key].make(1));
        const profile = (side: Side) =>
          w.soldiers
            .filter((s) => s.side === side)
            .map(
              (s) =>
                `${s.role}:${s.hqRole ?? "-"}:${s.isSquadLeader}:${s.isFireteamLeader}:` +
                `${s.quals.medicalCrossTrained}:${s.quals.designatedMarksman}`,
            )
            .sort()
            .join("|");
        expect(profile("blue")).toBe(profile("red"));
      });

      it("両陣営が同数の指揮ノードを持つ", () => {
        const w = createWorld(SCENARIOS[key].make(1));
        for (const [nodes, name] of [
          [w.companies, "companies"],
          [w.platoons, "platoons"],
          [w.squads, "squads"],
          [w.fireteams, "fireteams"],
        ] as const) {
          const blue = nodes.filter((n) => n.side === "blue").length;
          const red = nodes.filter((n) => n.side === "red").length;
          expect(blue, name).toBe(red);
        }
      });
    });
  }
});
