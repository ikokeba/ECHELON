/**
 * Squad-leader AI (spec §3 ③ — the FSW core layer).
 *
 * Current scope: the SL's own body. It sees the union of its two fireteams'
 * vision (spec §5) and positions itself where it can command — behind the
 * leading fireteam, oriented on the threat — rather than leading the assault.
 * On contact it takes cover and observes; it does not join the base of fire.
 *
 * NOT yet implemented (next slice): the SL *directing* its fireteams — choosing
 * the movement technique (spec §6 traveling / traveling overwatch / bounding
 * overwatch) and assigning base-of-fire vs maneuver roles between them. Today
 * each fireteam decides that for itself in c2/fireteam.ts.
 */

import { SIM_HZ } from "../constants.ts";
import type { Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/** How far behind the squad's leading edge the SL holds, m. */
const TRAIL_DIST = 4;
/** Re-decide at this cadence rather than every tick. */
const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);
/** Don't re-issue a destination this close to the current one, m. */
const DEST_EPS = 1.2;

function centroid(units: readonly Soldier[]): Vec2 {
  if (units.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const u of units) {
    x += u.pos.x;
    z += u.pos.z;
  }
  return { x: x / units.length, z: z / units.length };
}

function dirTo(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}

export function squadAI(world: World): void {
  if (world.tick % DECIDE_EVERY_TICKS !== 0) return;

  for (const sl of world.soldiers) {
    if (!sl.isSquadLeader || sl.status !== "ok") continue;

    const squad = world.soldiers.filter(
      (s) => s.side === sl.side && s.squadId === sl.squadId && s.fireteamId >= 0 && s.status === "ok",
    );
    if (squad.length === 0) continue;

    // the SL's picture: the union of its subordinate fireteams' vision (spec §5)
    const fireteams = world.fireteams.filter(
      (f) => f.side === sl.side && f.squadId === sl.squadId,
    );
    let threat: Vec2 | null = null;
    let bestConfidence = 0;
    for (const ft of fireteams) {
      for (const c of ft.memory.values()) {
        if (c.confidence > bestConfidence) {
          bestConfidence = c.confidence;
          threat = c.pos;
        }
      }
    }

    const mc = centroid(squad);
    const forward = threat ? dirTo(mc, threat) : { ...sl.facing };
    // hold back from the squad's leading edge, on the threat axis
    const post: Vec2 = { x: mc.x - forward.x * TRAIL_DIST, z: mc.z - forward.z * TRAIL_DIST };
    const look = threat ? dirTo(sl.pos, threat) : forward;

    const arrived = Math.hypot(sl.pos.x - post.x, sl.pos.z - post.z) < DEST_EPS;
    if (arrived) {
      sl.order = { kind: "hold", facing: { ...look }, issuedTick: world.tick };
      sl.path = [];
      sl.pathIdx = 0;
      continue;
    }

    const prev = sl.order.target;
    const sameDest = prev && Math.hypot(prev.x - post.x, prev.z - post.z) < DEST_EPS;
    sl.order = {
      kind: "move",
      target: { ...post },
      facing: { ...look },
      issuedTick: world.tick,
    };
    if (!sameDest) {
      sl.path = [];
      sl.pathIdx = 0;
    }
  }
}
