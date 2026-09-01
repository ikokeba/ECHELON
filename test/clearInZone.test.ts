import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import {
  buildingCleared,
  buildingClearedIn,
  buildingStarted,
  clearedDoorSet,
  nextBuildingToClear,
  unfinishedBuildingOf,
} from "../src/sim/c2/clearInZone.ts";

/**
 * 担当区域内の建物掃討(ATP 3-06.11 / 仕様 §7)。`[v6.3]`
 * 3回目のテストプレイ指摘「建物をクリアリングせずどんどん進んでいます」への回帰。
 */
describe("clear in zone(ATP 3-06.11 / `[v6.3]`)", () => {
  it("前進軸上の未掃討の建物を、手前から選ぶ", () => {
    const w = createWorld(companyClashScenario(1));
    const from = { x: 0, z: -60 };
    const aim = { x: 0, z: 60 };
    const b = nextBuildingToClear(w, "blue", from, aim, 40, new Set(), clearedDoorSet(w, "blue"));
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
    const first = nextBuildingToClear(w, "blue", from, aim, 40, new Set(), clearedDoorSet(w, "blue"))!;
    const second = nextBuildingToClear(w, "blue", from, aim, 40, new Set([first.id]), clearedDoorSet(w, "blue"));
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
  }, 420000);

  /**
   * 「取り付いた建物は終わらせる」(`[v6.4]` 4回目のテストプレイ指摘③)。
   *
   * ATP 3-06.11: 建物は全室を掃討して初めて cleared。途中で離れるのは bypass であって、
   * bypass は指揮官の判断と監視の残置・報告を伴う。破孔だけ開けて未確認の部屋を
   * 側背に残して進むのは、どちらでもない。
   */
  it("取り付いて未完の建物を、手つかずの建物より先に割り当てる", () => {
    const w = createWorld(companyClashScenario(1));
    const from = { x: 0, z: -60 };
    const aim = { x: 0, z: 60 };
    const cleared = clearedDoorSet(w, "blue");
    const first = nextBuildingToClear(w, "blue", from, aim, 40, new Set(), cleared)!;

    // 別の(より奥の)建物に破孔だけ開いている状態を作る
    const started = w.buildings.find((b) => {
      if (b.id === first.id || b.doors.length < 2) return false;
      const cz = (b.bounds.minZ + b.bounds.maxZ) / 2;
      const cx = (b.bounds.minX + b.bounds.maxX) / 2;
      return cz > from.z && cz < aim.z && Math.abs(cx) <= 40;
    })!;
    const withStarted = new Set([...cleared, started.doors[0]!.id]);

    expect(buildingStarted(withStarted, started)).toBe(true);
    const pick = nextBuildingToClear(w, "blue", from, aim, 40, new Set(), withStarted);
    expect(pick!.id).toBe(started.id);
  });

  it("自分が破った未完の建物を、その分隊自身の担当として引ける", () => {
    const w = createWorld(companyClashScenario(1));
    const sq = w.squads.find((s) => s.side === "blue")!;
    const b = w.buildings.find((x) => x.doors.length >= 2)!;
    expect(unfinishedBuildingOf(w, clearedDoorSet(w, "blue"), sq.clearedDoorIds)).toBeNull();

    sq.clearedDoorIds.push(b.doors[0]!.id);
    const cleared = clearedDoorSet(w, "blue");
    expect(unfinishedBuildingOf(w, cleared, sq.clearedDoorIds)!.id).toBe(b.id);

    // 全部屋を終えたら、もう「未完」ではない
    for (const d of b.doors) if (!sq.clearedDoorIds.includes(d.id)) sq.clearedDoorIds.push(d.id);
    expect(
      unfinishedBuildingOf(w, clearedDoorSet(w, "blue"), sq.clearedDoorIds),
    ).toBeNull();
  });

  it("実戦で、進入した建物の大半を最後まで掃討する", () => {
    // 修正前は、進入した建物の8割が「外扉だけ掃討して立ち去る」で終わっていた
    // (中廊下を取ったところで分隊重心が建物の外に落ち、内扉が候補から消えるため)。
    const w = createWorld(companyClashScenario(1));
    for (let i = 0; i < 60 && !w.victory; i++) runTicks(w, 150);

    let full = 0;
    let partial = 0;
    for (const side of ["blue", "red"] as const) {
      const cleared = clearedDoorSet(w, side);
      for (const b of w.buildings) {
        if (!b.doors.some((d) => cleared.has(d.id))) continue;
        if (buildingClearedIn(cleared, b)) full++;
        else partial++;
      }
    }
    expect(full).toBeGreaterThan(partial);
  }, 420000);
});
