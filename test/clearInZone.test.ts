import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { buildingCleared, nextBuildingToClear } from "../src/sim/c2/clearInZone.ts";

/**
 * 担当区域内の建物掃討(ATP 3-06.11 / 仕様 §7)。`[v6.3]`
 * 3回目のテストプレイ指摘「建物をクリアリングせずどんどん進んでいます」への回帰。
 */
describe("clear in zone(ATP 3-06.11 / `[v6.3]`)", () => {
  it("前進軸上の未掃討の建物を、手前から選ぶ", () => {
    const w = createWorld(companyClashScenario(1));
    const from = { x: 0, z: -60 };
    const aim = { x: 0, z: 60 };
    const b = nextBuildingToClear(w, "blue", from, aim, 40, new Set());
    expect(b).not.toBeNull();
    // 選ばれた建物より手前(from寄り)に、担当区域内の未掃討の建物は無いこと
    const chosenAlong = (b!.bounds.minZ + b!.bounds.maxZ) / 2 - from.z;
    for (const other of w.buildings) {
      if (other.id === b!.id) continue;
      const cz = (other.bounds.minZ + other.bounds.maxZ) / 2;
      const cx = (other.bounds.minX + other.bounds.maxX) / 2;
      const along = cz - from.z;
      if (along < 0 || along > 120 || Math.abs(cx) > 40) continue;
      expect(along).toBeGreaterThanOrEqual(chosenAlong - 1e-6);
    }
  });

  it("既に割り当て済みの建物は他の分隊へ重複して振らない", () => {
    const w = createWorld(companyClashScenario(1));
    const from = { x: 0, z: -60 };
    const aim = { x: 0, z: 60 };
    const first = nextBuildingToClear(w, "blue", from, aim, 40, new Set())!;
    const second = nextBuildingToClear(w, "blue", from, aim, 40, new Set([first.id]));
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
  });

  it("掃討完了は全ての扉が掃討済みであること", () => {
    const w = createWorld(companyClashScenario(1));
    const b = w.buildings[0]!;
    expect(buildingCleared(w, "blue", b)).toBe(false);
    const sq = w.squads.find((s) => s.side === "blue")!;
    // 一部の扉だけではまだ完了ではない
    sq.clearedDoorIds.push(b.doors[0]!.id);
    expect(buildingCleared(w, "blue", b)).toBe(b.doors.length === 1);
    for (const d of b.doors) if (!sq.clearedDoorIds.includes(d.id)) sq.clearedDoorIds.push(d.id);
    expect(buildingCleared(w, "blue", b)).toBe(true);
    // 掃討は陣営ごと。青が掃討しても赤にとっては未掃討
    expect(buildingCleared(w, "red", b)).toBe(false);
  });

  it("実戦で建物が実際に掃討される(素通りしない)", () => {
    const w = createWorld(companyClashScenario(1));
    for (let i = 0; i < 60 && !w.victory; i++) runTicks(w, 150);
    const cleared = w.buildings.filter(
      (b) => buildingCleared(w, "blue", b) || buildingCleared(w, "red", b),
    ).length;
    expect(cleared).toBeGreaterThan(0);
  }, 300000);
});
