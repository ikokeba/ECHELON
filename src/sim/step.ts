/**
 * stepWorld: advance the simulation by exactly one fixed tick.
 *
 * Systems run in a fixed order every tick. The order is the contract — changing
 * it changes outcomes. As slices land, more systems slot in here (perception →
 * belief/radio → c2 controllers → combat → casualties → movement).
 */

import { pathingSystem } from "./systems/pathing.ts";
import { movementSystem } from "./systems/movement.ts";
import type { World } from "./world.ts";

export function stepWorld(world: World): void {
  // 1. path requests — turn moving orders into waypoint lists
  pathingSystem(world);
  // 2. movement — consume paths / order-facing
  movementSystem(world);

  // (perception, radio, c2, combat, casualties … land in later slices)

  world.tick += 1;
}

/** Convenience for headless runs and tests. */
export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world);
}
