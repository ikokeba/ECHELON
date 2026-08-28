/**
 * stepWorld: advance the simulation by exactly one fixed tick.
 *
 * Systems run in a fixed order every tick. The order is the contract — changing
 * it changes outcomes. As slices land, more systems slot in here (c2 controllers
 * ahead of pathing/combat; radio/belief between perception and c2).
 */

import { pathingSystem } from "./systems/pathing.ts";
import { movementSystem } from "./systems/movement.ts";
import { perceptionSystem } from "./systems/perception.ts";
import { combatSystem } from "./systems/combat.ts";
import { casualtiesSystem } from "./systems/casualties.ts";
import { fireteamAI } from "./c2/fireteam.ts";
import { squadAI } from "./c2/squad.ts";
import type { World } from "./world.ts";

export function stepWorld(world: World): void {
  // 1. perception — who each soldier can personally see right now (spec §5)
  perceptionSystem(world);
  // 2. C2 — fireteam leaders update their picture and emit per-soldier orders,
  //    then squad leaders posture on the resulting picture.
  //    (platoon / company controllers slot in above this; radio delivery between
  //    echelons lands in the next slice)
  fireteamAI(world);
  squadAI(world);
  // 3. path requests — turn moving orders into waypoint lists
  pathingSystem(world);
  // 4. movement — consume paths / order-facing
  movementSystem(world);
  // 5. combat — engage, roll hits, apply suppression
  combatSystem(world);
  // 6. casualties — bleed-out progression
  casualtiesSystem(world);

  world.tick += 1;
}

/** Convenience for headless runs and tests. */
export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world);
}
