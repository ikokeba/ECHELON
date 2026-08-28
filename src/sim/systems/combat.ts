/**
 * Combat resolution (spec §8) — the single place hits and suppression are
 * decided. `rollShot` is pure so the balance harness (src/balance/) runs the
 * exact same maths as the live sim.
 *
 * Abstractions held simple per spec §8:
 *   - no ammo (grenades excepted, later);
 *   - no friendly fire — a friendly on the line of fire blocks the shot (§8.2);
 *   - suppression is a flat −40% accuracy (−10% for the marksman) with NO
 *     residue: it lapses within a tick of the suppressor ceasing fire (§8.6),
 *     and it only comes from a soldier in the "制圧役" (suppressor) role.
 */

import { chance, ratePerTick, type Rng } from "../rng.ts";
import {
  BLEED_OUT_SEC,
  FIRE_ALIGN_RAD,
  HIT_RATE_PER_SEC,
  KIA_ON_HIT_CHANCE,
  SIM_DT,
  SUPPRESSION_ACC_PENALTY,
  SUPPRESSION_ACC_PENALTY_MARKSMAN,
  SUPPRESSION_GRACE_TICKS,
  SOLDIER_RADIUS,
  TURN_RATE,
} from "../constants.ts";
import type { World } from "../world.ts";
import type { Soldier, Vec2 } from "../types.ts";

export function isSuppressed(s: Soldier, tick: number): boolean {
  return s.suppressedUntilTick > tick;
}

export interface ShotContext {
  /** shooter is currently under suppression (its own accuracy is degraded) */
  shooterSuppressed: boolean;
  /** shooter is the squad's selected marksman (lighter suppression penalty) */
  shooterIsMarksman: boolean;
}

export type ShotOutcome = { hit: false } | { hit: true; lethal: boolean };

/** Pure per-tick shot roll against a valid, in-LOS, aligned target. */
export function rollShot(rng: Rng, ctx: ShotContext): ShotOutcome {
  let accMul = 1;
  if (ctx.shooterSuppressed) {
    accMul = 1 - (ctx.shooterIsMarksman ? SUPPRESSION_ACC_PENALTY_MARKSMAN : SUPPRESSION_ACC_PENALTY);
  }
  const hitP = ratePerTick(HIT_RATE_PER_SEC * accMul, SIM_DT);
  if (!chance(rng, hitP)) return { hit: false };
  return { hit: true, lethal: chance(rng, KIA_ON_HIT_CHANCE) };
}

function angleBetween(a: Vec2, b: Vec2): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
  return Math.acos(dot);
}

/** A friendly body sitting on the shooter→target segment blocks the shot (§8.2). */
function friendlyBlocksFire(world: World, shooter: Soldier, target: Soldier): boolean {
  const sx = shooter.pos.x;
  const sz = shooter.pos.z;
  const dx = target.pos.x - sx;
  const dz = target.pos.z - sz;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const clearance = SOLDIER_RADIUS * 1.6;

  for (const f of world.soldiers) {
    if (f.side !== shooter.side || f.id === shooter.id || f.status === "kia") continue;
    const t = (f.pos.x - sx) * ux + (f.pos.z - sz) * uz;
    if (t <= 0.4 || t >= len - 0.4) continue;
    const perp = Math.hypot(f.pos.x - sx - ux * t, f.pos.z - sz - uz * t);
    if (perp < clearance) return true;
  }
  return false;
}

function nearestVisibleTarget(world: World, shooter: Soldier): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of shooter.sees) {
    const t = world.soldierById.get(id);
    if (!t || t.status !== "ok") continue;
    const d = Math.hypot(t.pos.x - shooter.pos.x, t.pos.z - shooter.pos.z);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

interface PendingShot {
  shooter: Soldier;
  target: Soldier;
  outcome: ShotOutcome;
  suppressing: boolean;
}

/**
 * Combat is resolved in two phases — every shooter rolls against the state at
 * the START of the tick, then all effects are applied. Sequential resolution
 * would give whichever force iterates first a free kill (the "first-mover bias"
 * the mos-balance prototype hit during verification) and would silently break
 * force symmetry (spec §2/§13).
 */
export function combatSystem(world: World): void {
  const maxTurn = TURN_RATE * SIM_DT;
  const pending: PendingShot[] = [];

  for (const s of world.soldiers) {
    s.suppressor = s.order.kind === "suppress";
    if (s.status !== "ok") continue;

    const target = nearestVisibleTarget(world, s);
    if (!target) continue;

    const tx = target.pos.x - s.pos.x;
    const tz = target.pos.z - s.pos.z;
    const tlen = Math.hypot(tx, tz) || 1;
    const toTarget = { x: tx / tlen, z: tz / tlen };
    const moving = s.pathIdx < s.path.length;

    // reflex aim: a stationary soldier turns onto the target before firing
    if (!moving && angleBetween(s.facing, toTarget) > FIRE_ALIGN_RAD) {
      const cur = Math.atan2(s.facing.x, s.facing.z);
      const want = Math.atan2(toTarget.x, toTarget.z);
      let diff = want - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const na = Math.abs(diff) <= maxTurn ? want : cur + Math.sign(diff) * maxTurn;
      s.facing = { x: Math.sin(na), z: Math.cos(na) };
      continue; // aiming this tick, not firing
    }

    if (angleBetween(s.facing, toTarget) > FIRE_ALIGN_RAD) continue; // moving & off-aim
    if (friendlyBlocksFire(world, s, target)) continue;

    // firing — draw from the shooter's own force stream so mirrored situations
    // roll identically on both sides (spec §2/§13 force symmetry)
    const outcome = rollShot(world.rngBySide[s.side], {
      shooterSuppressed: isSuppressed(s, world.tick),
      shooterIsMarksman: false, // set once the marksman slot exists (spec §14)
    });
    pending.push({ shooter: s, target, outcome, suppressing: s.suppressor });
  }

  // ── apply phase ──
  for (const { target, outcome, suppressing } of pending) {
    if (outcome.hit) {
      if (outcome.lethal) {
        target.status = "kia";
        target.path = [];
        target.pathIdx = 0;
        target.bleedOutTick = 0;
      } else if (target.status === "ok") {
        target.status = "wia";
        target.path = [];
        target.pathIdx = 0;
        target.bleedOutTick = world.tick + Math.round(BLEED_OUT_SEC / SIM_DT);
      }
    }
    // suppression persists only while a suppressor keeps fire on the target (§8.6)
    if (suppressing && target.status === "ok") {
      target.suppressedUntilTick = world.tick + 1 + SUPPRESSION_GRACE_TICKS;
    }
  }
}
