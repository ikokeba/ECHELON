/**
 * Perception system: fills each living soldier's `sees` with the ids of enemy
 * soldiers it can personally detect this tick — inside the forward view cone
 * (spec §5: 角度+距離), within DETECT_RANGE, with a clear line of sight. KIA
 * bodies are not detected (spec §9: removed from the picture immediately).
 *
 * Fireteam / squad aggregation (union of members' vision, spec §5) is derived on
 * demand by the c2 layer from these per-soldier sets — it is not stored here.
 */

import { hasLineOfSight } from "../geometry.ts";
import { DETECT_RANGE, FOV_HALF_RAD } from "../constants.ts";
import type { World } from "../world.ts";
import type { Soldier } from "../types.ts";

const COS_FOV = Math.cos(FOV_HALF_RAD);
const DETECT_RANGE_SQ = DETECT_RANGE * DETECT_RANGE;

export function canSee(walls: World["walls"], viewer: Soldier, target: Soldier): boolean {
  const dx = target.pos.x - viewer.pos.x;
  const dz = target.pos.z - viewer.pos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > DETECT_RANGE_SQ || d2 < 1e-6) return false;
  const inv = 1 / Math.sqrt(d2);
  // dot(viewDir, toTarget) vs cos(halfFov)
  if (viewer.facing.x * dx * inv + viewer.facing.z * dz * inv < COS_FOV) return false;
  return hasLineOfSight(walls, viewer.pos.x, viewer.pos.z, target.pos.x, target.pos.z);
}

export function perceptionSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "kia") {
      if (s.sees.length) s.sees = [];
      continue;
    }
    const seen: number[] = [];
    for (const other of world.soldiers) {
      if (other.side === s.side || other.status === "kia") continue;
      if (canSee(world.walls, s, other)) seen.push(other.id);
    }
    s.sees = seen;
  }
}
