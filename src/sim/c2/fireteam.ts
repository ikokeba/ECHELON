/**
 * Fireteam-leader AI — the command system (spec §1 [v5] correction: this state
 * machine *is* what the spec calls the 命令システム).
 *
 * Ported from squad-12v12-3ft-autobattle-mock.jsx `updateSquadOrders`, which the
 * v5 pass verified. Structure preserved:
 *   mode select (with dwell hysteresis) → per-mode order emission
 *   ADVANCE / SEARCH : bounding overwatch (one buddy pair moves, one overwatches)
 *   CONTACT          : base-of-fire element suppresses, maneuver element flanks
 *   FALLBACK         : withdraw to the rally point
 * Destination caches are held until reached (the mock's anti-dither rule).
 *
 * Force symmetry (spec §2/§13): this runs identically for both sides. Nothing
 * here reads `side` to branch behaviour.
 */

import { hasLineOfSight } from "../geometry.ts";
import {
  bestCoverPoint,
  bestFlankPoint,
  pickSupportedBoundTarget,
} from "../cover.ts";
import { CONFIDENCE_CUTOFF, SIM_HZ } from "../constants.ts";
import { decayedConfidence } from "../belief.ts";
import type { Contact, FireteamMode, FireteamState, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

// ── tuning (mock-derived; see squad-12v12 TEAM_DEFS). Individual variance from
//    spec §14 modulates these per fireteam rather than per team "personality".
const ENGAGE_MIN = 8;
const ENGAGE_MAX = 15;
const BOUND_MIN_ADV = 3;
const BOUND_MAX_ADV = 7;
/** minimum ticks in a mode before switching away (mock: 1.2s) — FALLBACK exempt */
const MODE_DWELL_TICKS = Math.round(1.2 * SIM_HZ);
/** re-pick a reached destination only after this long (mock: 1.5s) */
const DEST_HOLD_TICKS = Math.round(1.5 * SIM_HZ);
/** how close counts as "arrived" for a bound leg / destination (mock: 1.8 / 1.5m) */
const BOUND_ARRIVE = 1.8;
const DEST_ARRIVE = 1.5;
/** how far below enemy strength before withdrawing (mock: fallbackDeficit) */
const FALLBACK_DEFICIT = 1;
/** the FT leader re-decides at this cadence, not every tick */
const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);

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

function rotate(dir: Vec2, theta: number): Vec2 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: dir.x * c + dir.z * s, z: dir.z * c - dir.x * s };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Lateral offset so members of a moving element don't stack on one point. */
function offsetPerp(i: number, n: number, spacing: number, dir: Vec2): Vec2 {
  const perp = { x: -dir.z, z: dir.x };
  const k = i - (n - 1) / 2;
  return { x: perp.x * k * spacing, z: perp.z * k * spacing };
}

function issue(
  world: World,
  u: Soldier,
  kind: Soldier["order"]["kind"],
  target: Vec2 | null,
  look: Vec2,
): void {
  const prev = u.order;
  const movingKind = kind === "move" || kind === "maneuver" || kind === "retreat" || kind === "evade";
  const changedTarget =
    movingKind && (!prev.target || !target || dist(prev.target, target) > 0.35);

  u.order = {
    kind,
    ...(target ? { target: { ...target } } : {}),
    facing: { ...look },
    issuedTick: world.tick,
  };
  // a genuinely new destination invalidates the cached path
  if (changedTarget) {
    u.path = [];
    u.pathIdx = 0;
  }
}

/** Merge everything the fireteam's members can see into the leader's picture. */
function updateMemory(world: World, ft: FireteamState, members: readonly Soldier[]): void {
  for (const m of members) {
    for (const id of m.sees) {
      const enemy = world.soldierById.get(id);
      if (!enemy || enemy.status === "kia") continue;
      const key = `s${id}`;
      const existing = ft.memory.get(key);
      const contact: Contact = {
        key,
        side: enemy.side,
        pos: { x: enemy.pos.x, z: enemy.pos.z },
        posError: 0,
        lastSeenTick: world.tick,
        confidence: 1,
        count: 1,
      };
      if (existing) {
        existing.pos = contact.pos;
        existing.lastSeenTick = world.tick;
        existing.confidence = 1;
        existing.posError = 0;
      } else {
        ft.memory.set(key, contact);
      }
    }
  }

  // decay + drop, and forget anyone confirmed dead (spec §9: KIA leaves the picture at once)
  for (const [key, c] of ft.memory) {
    const enemy = world.soldierById.get(Number(key.slice(1)));
    if (enemy && enemy.status === "kia") {
      ft.memory.delete(key);
      continue;
    }
    const age = (world.tick - c.lastSeenTick) / SIM_HZ;
    c.confidence = decayedConfidence(age);
    c.posError = age * 0.15;
    if (c.confidence < CONFIDENCE_CUTOFF) ft.memory.delete(key);
  }
}

/**
 * Mode selection. The strength comparison weighs the **squad's** effective
 * strength — not just this fireteam's — against the threat this fireteam knows
 * about. A fireteam is half a squad by design and fights supported by the other
 * half (spec §6 fire and movement), so judging a 4-man team against every enemy
 * it can see makes both sides withdraw on first contact and no fight happens.
 */
function selectMode(
  ft: FireteamState,
  squadStrength: number,
  memberCount: number,
  contacts: Contact[],
): FireteamMode {
  const known = contacts.length;
  if (memberCount > 0 && squadStrength < known - FALLBACK_DEFICIT) return "FALLBACK";
  if (contacts.some((c) => c.confidence > 0.85)) return "CONTACT";
  if (ft.memory.size > 0 || ft.searchPoint) return "SEARCH";
  return "ADVANCE";
}

/**
 * Bounding overwatch: one buddy pair moves to a covered position inside the
 * other pair's supporting fire; the pairs then swap roles (spec §6).
 */
function runBoundingOverwatch(
  world: World,
  ft: FireteamState,
  alpha: Soldier[],
  bravo: Soldier[],
  forward: Vec2,
): void {
  const members = [...alpha, ...bravo];
  if (members.length === 0) return;

  // A pair wiped out can't bound — move as one body instead of freezing.
  if (alpha.length === 0 || bravo.length === 0) {
    const mc = centroid(members);
    if (!ft.boundTarget || dist(mc, ft.boundTarget) < BOUND_ARRIVE) {
      ft.boundTarget = pickSupportedBoundTarget(
        world.walls,
        world.coverPoints,
        mc,
        forward,
        BOUND_MIN_ADV,
        BOUND_MAX_ADV,
      );
    }
    const dest = ft.boundTarget;
    members.forEach((u, i) => {
      const off = offsetPerp(i, members.length, 1.3, forward);
      const look = rotate(forward, ((i % 2 === 0 ? -30 : 30) * Math.PI) / 180);
      if (dest) issue(world, u, "move", { x: dest.x + off.x, z: dest.z + off.z }, look);
      else issue(world, u, "hold", null, look);
    });
    return;
  }

  const moving = ft.boundingLeg === "alpha" ? alpha : bravo;
  const overwatch = ft.boundingLeg === "alpha" ? bravo : alpha;

  if (!ft.boundTarget) {
    ft.boundTarget = pickSupportedBoundTarget(
      world.walls,
      world.coverPoints,
      centroid(moving),
      forward,
      BOUND_MIN_ADV,
      BOUND_MAX_ADV,
      centroid(overwatch),
    );
  }
  const dest = ft.boundTarget;

  moving.forEach((u, i) => {
    const off = offsetPerp(i, moving.length, 1.6, forward);
    const look = rotate(forward, ((moving.length === 2 ? (i === 0 ? -25 : 25) : 0) * Math.PI) / 180);
    if (dest) issue(world, u, "move", { x: dest.x + off.x, z: dest.z + off.z }, look);
    else issue(world, u, "hold", null, look);
  });

  if (dest && moving.every((u) => dist(u.pos, dest) < BOUND_ARRIVE + 1.6)) {
    ft.boundingLeg = ft.boundingLeg === "alpha" ? "bravo" : "alpha";
    ft.boundTarget = null; // recompute for the next leg
  }

  // At least one overwatcher covers the direction of movement; a second splits rearward.
  overwatch.forEach((u, i) => {
    const look = i === 0 ? forward : rotate(forward, (140 * Math.PI) / 180);
    issue(world, u, "hold", null, look);
  });
}

/** Pick the destination for a soldier, honouring the anti-dither hold. */
function cachedDest(
  world: World,
  ft: FireteamState,
  u: Soldier,
  compute: () => Vec2 | null,
): Vec2 | null {
  const cur = ft.unitDest.get(u.id);
  const since = ft.unitDestSince.get(u.id) ?? -Infinity;
  const stale = world.tick - since >= DEST_HOLD_TICKS;
  if (!cur || (dist(u.pos, cur) < DEST_ARRIVE && stale)) {
    const p = compute();
    if (p) {
      ft.unitDest.set(u.id, p);
      ft.unitDestSince.set(u.id, world.tick);
      return p;
    }
  }
  return cur ?? null;
}

export function fireteamAI(world: World): void {
  for (const ft of world.fireteams) {
    const members = world.soldiers.filter(
      (s) => s.side === ft.side && s.squadId === ft.squadId && s.fireteamId === ft.ftIndex,
    );
    const living = members.filter((s) => s.status === "ok");

    updateMemory(world, ft, living);
    if (living.length === 0) continue;
    if (world.tick % DECIDE_EVERY_TICKS !== 0) continue;

    const contacts = [...ft.memory.values()];
    const squadStrength = world.soldiers.filter(
      (s) => s.side === ft.side && s.squadId === ft.squadId && s.status === "ok",
    ).length;
    const prevMode = ft.mode;
    const next = selectMode(ft, squadStrength, living.length, contacts);
    if (next !== ft.mode) {
      if (next === "FALLBACK" || world.tick - ft.modeSince >= MODE_DWELL_TICKS) {
        ft.mode = next;
        ft.modeSince = world.tick;
      }
    }
    if (prevMode !== ft.mode) {
      ft.boundTarget = null;
      ft.unitDest.clear();
      ft.unitDestSince.clear();
      if (ft.mode === "SEARCH") {
        const freshest = contacts.reduce<Contact | null>(
          (a, c) => (!a || c.lastSeenTick > a.lastSeenTick ? c : a),
          null,
        );
        ft.searchPoint = freshest ? { ...freshest.pos } : ft.objective;
      }
    }

    // buddy pairs within the fireteam (mock: i<2 = alpha, else bravo)
    const alpha = living.filter((_, i) => i < Math.ceil(living.length / 2));
    const bravo = living.filter((_, i) => i >= Math.ceil(living.length / 2));
    const mc = centroid(living);

    if (ft.mode === "CONTACT") {
      let primary = contacts[0];
      for (const c of contacts) {
        if (!primary) primary = c;
        else if (c.confidence > primary.confidence + 0.001) primary = c;
        else if (
          Math.abs(c.confidence - primary.confidence) <= 0.001 &&
          dist(mc, c.pos) < dist(mc, primary.pos)
        ) {
          primary = c;
        }
      }
      if (!primary) {
        runBoundingOverwatch(world, ft, alpha, bravo, dirTo(mc, ft.objective));
        continue;
      }
      const enemy = primary.pos;

      // whichever pair already has eyes on becomes the base of fire
      const alphaLOS = alpha.some((u) => hasLineOfSight(world.walls, u.pos.x, u.pos.z, enemy.x, enemy.z));
      const bravoLOS = bravo.some((u) => hasLineOfSight(world.walls, u.pos.x, u.pos.z, enemy.x, enemy.z));
      let base: Soldier[];
      let maneuver: Soldier[];
      if (alphaLOS && !bravoLOS) {
        base = alpha;
        maneuver = bravo;
      } else if (bravoLOS && !alphaLOS) {
        base = bravo;
        maneuver = alpha;
      } else {
        base = ft.baseElement === "bravo" ? bravo : alpha;
        maneuver = base === alpha ? bravo : alpha;
      }
      ft.baseElement = base === alpha ? "alpha" : "bravo";

      for (const u of base) {
        const d = dist(u.pos, enemy);
        const inPosition =
          hasLineOfSight(world.walls, u.pos.x, u.pos.z, enemy.x, enemy.z) &&
          d >= ENGAGE_MIN - 2 &&
          d <= ENGAGE_MAX + 2;
        if (inPosition) {
          ft.unitDest.delete(u.id);
          issue(world, u, "suppress", null, dirTo(u.pos, enemy));
        } else {
          const p = cachedDest(world, ft, u, () =>
            bestCoverPoint(world.walls, world.coverPoints, u.pos, enemy, ENGAGE_MIN, ENGAGE_MAX),
          );
          issue(world, u, "suppress", p ?? u.pos, dirTo(u.pos, enemy));
        }
      }

      const baseCentroid = centroid(base);
      for (const u of maneuver) {
        const p = cachedDest(world, ft, u, () =>
          bestFlankPoint(
            world.walls,
            world.coverPoints,
            u.pos,
            enemy,
            baseCentroid,
            ENGAGE_MIN,
            ENGAGE_MAX,
          ),
        );
        const fallback = { x: u.pos.x + (enemy.x - u.pos.x) * 0.2, z: u.pos.z + (enemy.z - u.pos.z) * 0.2 };
        issue(world, u, "maneuver", p ?? fallback, dirTo(u.pos, enemy));
      }
    } else if (ft.mode === "FALLBACK") {
      const freshest = contacts.reduce<Contact | null>(
        (a, c) => (!a || c.lastSeenTick > a.lastSeenTick ? c : a),
        null,
      );
      living.forEach((u, i) => {
        const p =
          ft.unitDest.get(u.id) ??
          (() => {
            const off = offsetPerp(i, living.length, 2, ft.advanceDir);
            const d = { x: ft.rallyPoint.x + off.x, z: ft.rallyPoint.z + off.z };
            ft.unitDest.set(u.id, d);
            ft.unitDestSince.set(u.id, world.tick);
            return d;
          })();
        const look = freshest ? dirTo(u.pos, freshest.pos) : ft.advanceDir;
        issue(world, u, "retreat", p, look);
      });
    } else {
      // ADVANCE / SEARCH — bounding overwatch toward the objective or last contact
      const aim = ft.mode === "SEARCH" && ft.searchPoint ? ft.searchPoint : ft.objective;
      if (ft.mode === "SEARCH" && ft.searchPoint && dist(mc, ft.searchPoint) < 3) {
        // swept the last-known point and found nothing — resume the advance
        ft.searchPoint = null;
        ft.memory.clear();
      }
      runBoundingOverwatch(world, ft, alpha, bravo, dirTo(mc, aim));
    }
  }
}
