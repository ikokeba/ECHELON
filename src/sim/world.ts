/**
 * The World: the single mutable simulation state container. Everything needed to
 * advance the sim by one tick lives here or is derived from here. It holds no
 * three.js and no DOM handles, and it is fully serialisable so replays and
 * headless tests can snapshot it.
 */

import { buildNavGrid, type NavGrid } from "./navgrid.ts";
import { createRng, type Rng } from "./rng.ts";
import { NAV_MARGIN_OUTDOOR, NAV_STEP_OUTDOOR } from "./constants.ts";
import type { AABB, Bounds, ControlMeasure, Report, Scenario, Side, Soldier } from "./types.ts";

export interface World {
  tick: number;
  bounds: Bounds;
  walls: AABB[];
  /** outdoor coarse nav grid; per-building fine grids are added later (design §4.2) */
  navOutdoor: NavGrid;
  rng: Rng;
  /** stable insertion order — iterate this, not a Map, so stepping is deterministic */
  soldiers: Soldier[];
  soldierById: Map<number, Soldier>;
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
    traits: { ...s.traits },
  };
}

export function createWorld(scenario: Scenario): World {
  const walls = scenario.walls.map((w) => ({ ...w }));
  const navOutdoor = buildNavGrid(walls, scenario.bounds, NAV_STEP_OUTDOOR, NAV_MARGIN_OUTDOOR);
  const soldiers = scenario.soldiers.map(cloneSoldier);
  const soldierById = new Map(soldiers.map((s) => [s.id, s]));

  return {
    tick: 0,
    bounds: { ...scenario.bounds },
    walls,
    navOutdoor,
    rng: createRng(scenario.seed),
    soldiers,
    soldierById,
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
