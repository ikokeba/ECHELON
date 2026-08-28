/**
 * Casualty progression (spec §9): an untreated WIA soldier whose 45s bleed timer
 * expires becomes KIA.
 *
 * Buddy-aid / treatment is deliberately NOT here yet — the treatment-time model
 * is unresolved (OQ-1: squad 3-tier vs FT MOS 2-tier, spec §9 ⚠️ / CLAUDE.md).
 * The CASEVAC system lands after that is decided.
 */

import type { World } from "../world.ts";

export function casualtiesSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "wia" && s.bleedOutTick > 0 && world.tick >= s.bleedOutTick) {
      s.status = "kia";
      s.bleedOutTick = 0;
    }
  }
}
