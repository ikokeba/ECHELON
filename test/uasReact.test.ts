import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { aiReactToUas, reactToUas } from "../src/sim/c2/uasReact.ts";
import { orderUasReact } from "../src/sim/playerOrders.ts";
import { insideBounds } from "../src/sim/cqb.ts";
import { collidesWall } from "../src/sim/geometry.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { SIM_HZ, SMOKE, UAS_REACT } from "../src/sim/constants.ts";
import type { Soldier, SquadState, Vec2 } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 対ドローンの隠蔽行動(`[v7.5]` ロードマップ S-7、設計メモ §6.3)。
 * ドローンに気づいた分隊が、建物へ入る・伏せる・煙を焚いて渡る。代償は前進が止まること。
 */

const world = (): World => createWorld(companyClashScenario(1));

/** 青の最初の小銃分隊 */
function blueSquad(w: World): SquadState {
  return w.squads.find(
    (s) =>
      s.side === "blue" &&
      w.soldiers.some((m) => m.squadId === s.squadId && m.role === "grenadier"),
  )!;
}

const menOf = (w: World, sq: SquadState): Soldier[] =>
  w.soldiers.filter((s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok");

function centroid(men: readonly Soldier[]): Vec2 {
  return {
    x: men.reduce((a, m) => a + m.pos.x, 0) / men.length,
    z: men.reduce((a, m) => a + m.pos.z, 0) / men.length,
  };
}

/** 分隊を地点のまわりへ置き直す(止まった状態で) */
function placeSquad(w: World, sq: SquadState, at: Vec2): void {
  menOf(w, sq).forEach((m, i) => {
    m.pos = { x: at.x + (i % 3) * 2 - 2, z: at.z + Math.floor(i / 3) * 2 - 2 };
    m.path = [];
    m.pathIdx = 0;
  });
}

/** 分隊の像に、すぐ上の新しいドローンの接触を入れる(S-6 で気づいたのと同じ形) */
function spotDrone(w: World, sq: SquadState, at: Vec2): void {
  sq.uas.set("u99", {
    key: "u99",
    side: "red",
    pos: { ...at },
    posError: 0,
    hopError: 0,
    lastSeenTick: w.tick,
    confidence: 1,
  });
}

/** 近くに外扉の無い、壁から離れた開けた地点 */
function openGround(w: World): Vec2 {
  const b = w.bounds;
  for (let z = b.minZ + 30; z < b.maxZ - 30; z += 10) {
    for (let x = b.minX + 30; x < b.maxX - 30; x += 10) {
      const p = { x, z };
      const nearDoor = w.buildings.some((bd) =>
        bd.doors.some((d) => Math.hypot(d.pos.x - x, d.pos.z - z) < UAS_REACT.SHELTER_DIST + 15),
      );
      const nearBuilding = w.buildings.some((bd) =>
        insideBounds(
          {
            minX: bd.bounds.minX - 8,
            maxX: bd.bounds.maxX + 8,
            minZ: bd.bounds.minZ - 8,
            maxZ: bd.bounds.maxZ + 8,
          },
          p,
        ),
      );
      if (!nearDoor && !nearBuilding && !collidesWall(w.walls, x, z, 6)) return p;
    }
  }
  throw new Error("開けた地点が無い");
}

describe("隠蔽行動の選び方(`[v7.5]` S-7)", () => {
  it("近くに建物があれば、扉を開けて入り、中で待つ(前進は止まる)", () => {
    const w = world();
    const sq = blueSquad(w);
    // 外側 12m が屋外の開けた場所になる外扉
    const outside = (d: { pos: Vec2; normal: Vec2 }): Vec2 => ({
      x: d.pos.x - d.normal.x * 12,
      z: d.pos.z - d.normal.z * 12,
    });
    const door = w.buildings
      .flatMap((x) => x.doors)
      .find(
        (d) =>
          d.exterior &&
          !w.buildings.some((bd) => insideBounds(bd.bounds, outside(d))) &&
          !collidesWall(w.walls, outside(d).x, outside(d).z, 3),
      )!;
    // 扉の外側 12m に分隊を置く
    placeSquad(w, sq, outside(door));
    spotDrone(w, sq, door.pos);
    expect(aiReactToUas(w, sq)).toBe(true);
    expect(sq.uasReact!.kind).toBe("shelter");
    // 入るのは範囲内でいちばん近い外扉の建物(置いた扉とは限らない)
    expect(sq.uasReact!.buildingId).toBeDefined();
    for (let t = 0; t < 15 * SIM_HZ; t++) {
      spotDrone(w, sq, door.pos);
      stepWorld(w);
    }
    const target = w.buildings.find((x) => x.id === sq.uasReact!.buildingId)!;
    const d = target.doors.find((x) => x.id === sq.uasReact!.doorId)!;
    expect(d.open).toBe(true);
    const men = menOf(w, sq);
    const inside = men.filter((m) => insideBounds(target.bounds, m.pos)).length;
    expect(inside).toBeGreaterThanOrEqual(Math.ceil(men.length * 0.7));
  }, 60000);

  it("建物が無く止まっていれば、その場で伏せて動かない。ドローンが去れば立って前進に戻る", () => {
    const w = world();
    const sq = blueSquad(w);
    const at = openGround(w);
    placeSquad(w, sq, at);
    spotDrone(w, sq, at);
    expect(reactToUas(w, sq)!.kind).toBe("prone");
    const before = centroid(menOf(w, sq));
    for (let t = 0; t < 6 * SIM_HZ; t++) {
      spotDrone(w, sq, at);
      stepWorld(w);
    }
    const men = menOf(w, sq);
    expect(Math.hypot(centroid(men).x - before.x, centroid(men).z - before.z)).toBeLessThan(1.5);
    expect(men.filter((m) => m.prone).length).toBeGreaterThanOrEqual(men.length - 1);

    // 新しい接触が入らなくなって RELEASE_SEC 経てば終わる
    runTicks(w, (UAS_REACT.RELEASE_SEC + 1) * SIM_HZ);
    expect(sq.uasReact).toBeNull();
    expect(menOf(w, sq).some((m) => m.prone)).toBe(false);
  }, 60000);

  it("開けた場所を移動中なら、行く手に煙を焚いて足を止めない", () => {
    const w = world();
    const sq = blueSquad(w);
    const at = openGround(w);
    placeSquad(w, sq, at);
    for (const m of menOf(w, sq)) {
      m.path = [{ x: m.pos.x, z: m.pos.z + 20 }];
      m.pathIdx = 0;
    }
    spotDrone(w, sq, at);
    expect(reactToUas(w, sq)!.kind).toBe("smoke");
    expect(sq.smokes).toBe(SMOKE.PER_SQUAD - 1);
    expect(w.smokes).toHaveLength(1);
  });

  it("突撃・突入・撃ち合いの最中、陣地に就いているときは続ける(AIの分隊長)", () => {
    const w = world();
    const sq = blueSquad(w);
    const at = openGround(w);
    placeSquad(w, sq, at);
    spotDrone(w, sq, at);
    const ft = w.fireteams.find((f) => f.side === sq.side && f.squadId === sq.squadId)!;
    ft.mode = "CONTACT";
    expect(aiReactToUas(w, sq)).toBe(false);
    ft.mode = "ADVANCE";
    sq.assaultDoorId = 1;
    expect(aiReactToUas(w, sq)).toBe(false);
    sq.assaultDoorId = null;
    // 遠い・古い接触にも反応しない
    sq.uas.get("u99")!.pos = { x: at.x + UAS_REACT.TRIGGER_DIST + 20, z: at.z };
    expect(aiReactToUas(w, sq)).toBe(false);
    spotDrone(w, sq, at);
    sq.uas.get("u99")!.lastSeenTick = w.tick - (UAS_REACT.TRIGGER_FRESH_SEC + 1) * SIM_HZ;
    expect(aiReactToUas(w, sq)).toBe(false);
    spotDrone(w, sq, at);
    expect(aiReactToUas(w, sq)).toBe(true);
  });
});

describe("命じる人(`[v7.5]` S-7、P4)", () => {
  it("人間の分隊長は AI と同じ関数で命じ、取り消せる。分隊長でない座席は命じられない", () => {
    const a = world();
    const b = world();
    const sqA = blueSquad(a);
    const sqB = blueSquad(b);
    const at = openGround(a);
    placeSquad(a, sqA, at);
    placeSquad(b, sqB, at);
    const seat = { side: "blue" as const, echelon: "squad" as const, unitId: sqB.squadId };
    // ドローンが見えていなくても命じられる
    expect(orderUasReact(b, true, seat)!.kind).toBe(reactToUas(a, sqA)!.kind);
    expect(orderUasReact(b, false, seat)).toBeNull();
    expect(sqB.uasReact).toBeNull();
    const pl = { side: "blue" as const, echelon: "platoon" as const, unitId: sqB.platoonId };
    expect(orderUasReact(b, true, pl)).toBeUndefined();
  });

  it("LLM は uas_cover で命じ、観測の uasCover で状態を見る", () => {
    const w = world();
    const sq = blueSquad(w);
    placeSquad(w, sq, openGround(w));
    const seat = { side: "blue" as const, echelon: "squad" as const, unitId: sq.squadId };
    const obs0 = buildObservation(w, seat)!;
    expect(obs0.uasCover).toBeNull();
    expect(obs0.commands.map((c) => c.type)).toContain("uas_cover");
    const go = parseResponse({ commands: [{ type: "uas_cover" }] });
    expect(applyResponse(w, seat, go.response!)[0]).toContain("伏せる");
    expect(buildObservation(w, seat)!.uasCover!.kind).toBe("prone");
    const stop = parseResponse({ commands: [{ type: "uas_cover", cancel: true }] });
    expect(applyResponse(w, seat, stop.response!)[0]).toContain("取り消し");
    expect(sq.uasReact).toBeNull();
  });
});

describe("戦闘の中で(`[v7.5]` S-6 → S-7)", () => {
  it("飛んできたドローンに気づいた分隊が、自分で隠れる", () => {
    const spec = { ...DEFAULT_FORCE, drone: true };
    const w = createWorld(companyClashScenario(1, { blue: spec, red: { ...spec } }));
    let reacted = false;
    for (let t = 0; t < 90 && !reacted; t++) {
      runTicks(w, SIM_HZ);
      reacted = w.squads.some((s) => s.uasReact !== null);
    }
    expect(reacted).toBe(true);
  }, 180000);
});
