/**
 * The World: the single mutable simulation state container. Everything needed to
 * advance the sim by one tick lives here or is derived from here. It holds no
 * three.js and no DOM handles, and it is fully serialisable so replays and
 * headless tests can snapshot it.
 */

import { buildNavGrid, type NavGrid } from "./navgrid.ts";
import { buildCoverPoints } from "./cover.ts";
import { createRng, type Rng } from "./rng.ts";
import { NAV_MARGIN_OUTDOOR, NAV_STEP_OUTDOOR } from "./constants.ts";
import type {
  AABB,
  Bounds,
  ControlMeasure,
  FireteamState,
  Report,
  Scenario,
  Side,
  Soldier,
  Vec2,
} from "./types.ts";

export interface World {
  tick: number;
  bounds: Bounds;
  walls: AABB[];
  /** outdoor coarse nav grid; per-building fine grids are added later (design §4.2) */
  navOutdoor: NavGrid;
  /** candidate cover lattice used by the C2 layer for bound/fire/flank positions */
  coverPoints: Vec2[];
  /** general-purpose stream for anything not attributable to one force */
  rng: Rng;
  /**
   * One RNG stream PER FORCE, both seeded identically from the scenario seed.
   * This makes force symmetry a hard guarantee (spec §2/§13): in a mirrored
   * situation each side draws the same rolls, so outcomes mirror. In a real
   * (asymmetric) fight the streams diverge naturally because the inputs differ.
   */
  rngBySide: Record<Side, Rng>;
  /** stable insertion order — iterate this, not a Map, so stepping is deterministic */
  soldiers: Soldier[];
  soldierById: Map<number, Soldier>;
  /** fireteam controllers — the lowest C2 node (spec §1 [v5]) */
  fireteams: FireteamState[];
  /** radio reports in flight, delivered when world.tick >= report.deliverTick */
  reports: Report[];
  controlMeasures: ControlMeasure[];
}

/** Deep-clone a soldier so the World owns its state independently of the scenario. */
function cloneSoldier(s: Soldier): Soldier {
  return {
    ...s,
    pos: { ...s.pos },
    facing: { ...s.facing },
    order: {
      ...s.order,
      ...(s.order.target ? { target: { ...s.order.target } } : {}),
      ...(s.order.facing ? { facing: { ...s.order.facing } } : {}),
    },
    path: s.path.map((p) => ({ ...p })),
    sees: [...s.sees],
    traits: { ...s.traits },
  };
}

/** Build one controller per (side, squad, fireteam) present in the roster. */
function buildFireteams(scenario: Scenario, soldiers: Soldier[]): FireteamState[] {
  const seen = new Map<string, FireteamState>();
  let id = 0;
  for (const s of soldiers) {
    if (s.fireteamId < 0) continue; // squad-leader slot has no fireteam of its own
    const key = `${s.side}:${s.squadId}:${s.fireteamId}`;
    if (seen.has(key)) continue;
    const spec = scenario.fireteamPlans?.find(
      (p) => p.side === s.side && p.squadId === s.squadId && p.ftIndex === s.fireteamId,
    );
    const objective = spec?.objective ?? { x: 0, z: 0 };
    const rallyPoint = spec?.rallyPoint ?? { x: s.pos.x, z: s.pos.z };
    const advanceDir = spec?.advanceDir ?? { ...s.facing };
    seen.set(key, {
      id: id++,
      side: s.side,
      squadId: s.squadId,
      ftIndex: s.fireteamId,
      mode: "ADVANCE",
      modeSince: 0,
      boundingLeg: "alpha",
      boundTarget: null,
      baseElement: "alpha",
      unitDest: new Map(),
      unitDestSince: new Map(),
      memory: new Map(),
      searchPoint: null,
      objective: { ...objective },
      advanceDir: { ...advanceDir },
      rallyPoint: { ...rallyPoint },
    });
  }
  return [...seen.values()];
}

export function createWorld(scenario: Scenario): World {
  const walls = scenario.walls.map((w) => ({ ...w }));
  const navOutdoor = buildNavGrid(walls, scenario.bounds, NAV_STEP_OUTDOOR, NAV_MARGIN_OUTDOOR);
  const coverPoints = buildCoverPoints(walls, scenario.bounds);
  const soldiers = scenario.soldiers.map(cloneSoldier);
  const soldierById = new Map(soldiers.map((s) => [s.id, s]));

  return {
    tick: 0,
    bounds: { ...scenario.bounds },
    walls,
    navOutdoor,
    coverPoints,
    rng: createRng(scenario.seed),
    rngBySide: { blue: createRng(scenario.seed), red: createRng(scenario.seed) },
    soldiers,
    soldierById,
    fireteams: buildFireteams(scenario, soldiers),
    reports: [],
    controlMeasures: (scenario.controlMeasures ?? []).map((cm) => ({
      ...cm,
      points: cm.points.map((p) => ({ ...p })),
    })),
  };
}

export function soldiersOf(world: World, side: Side): Soldier[] {
  return world.soldiers.filter((s) => s.side === side);
}

export function livingOf(world: World, side: Side): Soldier[] {
  return world.soldiers.filter((s) => s.side === side && s.status !== "kia");
}

export function squadSoldiers(world: World, squadId: number): Soldier[] {
  return world.soldiers.filter((s) => s.squadId === squadId);
}
