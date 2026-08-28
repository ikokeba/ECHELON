/**
 * Scenario builders. For now: default soldier construction plus a symmetric
 * "crossing" scenario used by the renderer bring-up and the determinism /
 * force-symmetry tests. Real scenarios become JSON files under src/scenarios/
 * (design §2, AD-10); this stays as the programmatic fixture.
 */

import type { AABB, Bounds, Scenario, Side, Soldier, Vec2 } from "./types.ts";

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}

export interface SoldierSeed {
  side: Side;
  squadId: number;
  fireteamId: number;
  isFireteamLeader?: boolean;
  isSquadLeader?: boolean;
  pos: Vec2;
  facing?: Vec2;
  moveTo?: Vec2;
  traits?: Partial<Soldier["traits"]>;
}

export function makeSoldier(seed: SoldierSeed): Soldier {
  const facing = seed.facing ?? { x: 0, z: seed.side === "blue" ? 1 : -1 };
  return {
    id: nextId++,
    side: seed.side,
    squadId: seed.squadId,
    fireteamId: seed.fireteamId,
    isFireteamLeader: seed.isFireteamLeader ?? false,
    isSquadLeader: seed.isSquadLeader ?? false,
    pos: { ...seed.pos },
    facing: { ...facing },
    status: "ok",
    suppressedUntilTick: 0,
    bleedOutTick: 0,
    order: seed.moveTo
      ? { kind: "move", target: { ...seed.moveTo }, issuedTick: 0 }
      : { kind: "hold", facing: { ...facing }, issuedTick: 0 },
    path: [],
    pathIdx: 0,
    traits: {
      aggressiveness: seed.traits?.aggressiveness ?? 0.5,
      boldness: seed.traits?.boldness ?? 0.5,
      caution: seed.traits?.caution ?? 0.5,
    },
  };
}

/** 9-soldier squad: SL + 2 fireteams of 4, laid out in a row facing `dir`. */
function makeSquad(
  side: Side,
  squadId: number,
  anchor: Vec2,
  dir: Vec2,
  objective: Vec2,
): Soldier[] {
  const right = { x: -dir.z, z: dir.x };
  const soldiers: Soldier[] = [];

  soldiers.push(
    makeSoldier({
      side,
      squadId,
      fireteamId: -1,
      isSquadLeader: true,
      pos: { x: anchor.x, z: anchor.z },
      facing: dir,
      moveTo: objective,
    }),
  );

  for (let ft = 0; ft < 2; ft++) {
    for (let m = 0; m < 4; m++) {
      const lateral = (ft === 0 ? -1 : 1) * 3 + (m - 1.5) * 1.6;
      const back = (m % 2) * -1.6 - ft * 0.4;
      soldiers.push(
        makeSoldier({
          side,
          squadId,
          fireteamId: ft,
          isFireteamLeader: m === 0,
          pos: {
            x: anchor.x + right.x * lateral + dir.x * back,
            z: anchor.z + right.z * lateral + dir.z * back,
          },
          facing: dir,
          moveTo: {
            x: objective.x + right.x * lateral,
            z: objective.z + right.z * lateral,
          },
        }),
      );
    }
  }
  return soldiers;
}

/** Mirror a quarter-map wall list across both axes. */
function mirror(base: AABB[]): AABB[] {
  const out: AABB[] = [];
  for (const w of base) {
    out.push({ ...w });
    out.push({ ...w, cx: -w.cx });
    out.push({ ...w, cz: -w.cz });
    out.push({ ...w, cx: -w.cx, cz: -w.cz });
  }
  return out;
}

export function demoCrossingScenario(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -32, maxX: 32, minZ: -22, maxZ: 22 };

  const walls = mirror([
    { cx: 10, cz: 4, hw: 4, hd: 0.4 },
    { cx: 18, cz: 10, hw: 0.4, hd: 3 },
    { cx: 6, cz: 12, hw: 2.5, hd: 0.4 },
    { cx: 24, cz: 3, hw: 0.4, hd: 2.5 },
    { cx: 3, cz: 3, hw: 0.6, hd: 0.6 },
  ]);
  // central compound — a pinwheel that is symmetric under 180° rotation about the
  // origin, so the two forces face a genuinely fair board (spec §2/§13).
  walls.push(
    { cx: 1.4, cz: 3, hw: 1.6, hd: 0.4 },
    { cx: -1.4, cz: -3, hw: 1.6, hd: 0.4 },
    { cx: 3, cz: -1.4, hw: 0.4, hd: 1.6 },
    { cx: -3, cz: 1.4, hw: 0.4, hd: 1.6 },
  );

  const soldiers = [
    ...makeSquad("blue", 0, { x: 0, z: -17 }, { x: 0, z: 1 }, { x: 0, z: 17 }),
    ...makeSquad("red", 1, { x: 0, z: 17 }, { x: 0, z: -1 }, { x: 0, z: -17 }),
  ];

  return {
    name: "demo-crossing",
    seed,
    bounds,
    walls,
    soldiers,
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ x: 0, z: 0 }] }],
  };
}
