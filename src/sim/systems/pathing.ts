/**
 * Path-request system: turns a moving order with a destination into a concrete
 * waypoint list via the outdoor nav grid. Runs before movement each tick.
 *
 * A fresh order arrives with `path: []` (issuers clear it), so a new destination
 * is picked up automatically. Attempts are throttled to a shared cadence so an
 * unreachable target doesn't re-search every tick (design §4.2: path requests
 * are budgeted, not per-tick). The cadence is deliberately NOT keyed to soldier
 * id — corresponding units on both forces must compute in lockstep for force
 * symmetry (spec §2/§13). A per-slot budget replaces this at scale.
 */

import { findPath } from "../navgrid.ts";
import { SIM_HZ } from "../constants.ts";
import type { World } from "../world.ts";

const MOVING_ORDERS = new Set(["move", "maneuver", "retreat", "evade"]);
/** re-attempt an unfulfilled path at most this often */
const PATH_RECHECK_TICKS = Math.round(SIM_HZ * 0.5);
/** close enough to the destination that no path is needed */
const ARRIVE_EPS = 0.4;

export function pathingSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "kia" || s.status === "wia") continue;
    if (!MOVING_ORDERS.has(s.order.kind)) continue;
    const goal = s.order.target;
    if (!goal) continue;
    if (s.pathIdx < s.path.length) continue; // already following a path

    const d = Math.hypot(goal.x - s.pos.x, goal.z - s.pos.z);
    if (d <= ARRIVE_EPS) continue;

    if (world.tick % PATH_RECHECK_TICKS !== 0) continue;

    const path = findPath(world.navOutdoor, s.pos.x, s.pos.z, goal.x, goal.z);
    if (path && path.length > 0) {
      s.path = path;
      s.pathIdx = 0;
    }
  }
}
