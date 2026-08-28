/**
 * Core simulation types. Pure data — no behaviour, no three.js, no DOM.
 *
 * Coordinate convention (unchanged from the prototype mocks):
 *   X / Z ground plane, Y is up, units are metres.
 *   Walls are axis-aligned boxes { cx, cz, hw, hd } (centre + half-extents).
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** Axis-aligned wall/obstacle box on the ground plane. */
export interface AABB {
  cx: number;
  cz: number;
  /** half-width along X */
  hw: number;
  /** half-depth along Z */
  hd: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Which force a unit belongs to. Both sides are mechanically identical (spec §2, §13). */
export type Side = "blue" | "red";

/** The five command echelons (spec §2). */
export type Echelon = "company" | "platoon" | "squad" | "fireteam" | "soldier";

/** Per-soldier order verbs emitted by the fireteam-leader AI (spec §1 [v5], §6). */
export type SoldierOrderKind =
  | "move"
  | "hold"
  | "suppress"
  | "maneuver"
  | "retreat"
  | "evade";

/** Fireteam-leader state machine modes (spec §1 [v5] — this *is* the "command system"). */
export type FireteamMode = "ADVANCE" | "CONTACT" | "SEARCH" | "FALLBACK";

/** Outdoor movement techniques a squad/platoon leader selects (spec §6). */
export type MovementTechnique = "traveling" | "traveling_overwatch" | "bounding_overwatch";

export type SoldierStatus = "ok" | "suppressed" | "wia" | "kia";

export interface SoldierOrder {
  kind: SoldierOrderKind;
  /** destination for move/maneuver/retreat/evade */
  target?: Vec2;
  /** aim/observe direction for hold/suppress (unit vector) */
  facing?: Vec2;
  /** sim tick this order was issued (for staleness / debugging) */
  issuedTick: number;
}

/**
 * One soldier. The atomic simulated entity. Everything above soldier level is a
 * *controller* (see c2/) that reads reports and emits orders — it is not an entity
 * with a body, except the leader soldier who physically occupies the unit.
 */
export interface Soldier {
  id: number;
  side: Side;
  /** squad id this soldier belongs to */
  squadId: number;
  /** fireteam id (0 or 1 within the squad; -1 for the squad leader slot) */
  fireteamId: number;
  /** true for the soldier who is this fireteam's leader */
  isFireteamLeader: boolean;
  /** true for the soldier who is this squad's leader */
  isSquadLeader: boolean;

  pos: Vec2;
  /** facing as a unit vector on the ground plane */
  facing: Vec2;
  status: SoldierStatus;

  /** sim tick until which this soldier is suppressed (0 = not suppressed) */
  suppressedUntilTick: number;
  /** sim tick at which a WIA soldier bleeds out to KIA (0 = n/a) */
  bleedOutTick: number;

  order: SoldierOrder;
  /** current path as a list of waypoints; consumed front-to-back */
  path: Vec2[];
  pathIdx: number;

  /** individual-variance parameters (spec §14); 0..1 each */
  traits: SoldierTraits;
}

export interface SoldierTraits {
  aggressiveness: number;
  boldness: number;
  caution: number;
}

/**
 * A contact in some echelon's belief (spec §5). Never a direct reference to a
 * Soldier — it is a decaying, possibly-stale observation.
 */
export interface Contact {
  /** stable key so repeated observations update rather than duplicate */
  key: string;
  side: Side;
  /** last observed position */
  pos: Vec2;
  /** rough position-error radius in metres, grows as the contact ages */
  posError: number;
  /** sim tick of the most recent observation feeding this contact */
  lastSeenTick: number;
  /** 0..1, decayed every tick against lastSeenTick (spec §5: 30s→.8 / 90s→.5 / 180s→0) */
  confidence: number;
  /** how many soldiers were seen, if known */
  count?: number;
}

/** An echelon controller's private world picture, built only from reports (spec §5). */
export interface Belief {
  contacts: Map<string, Contact>;
}

/** A radio report travelling up the chain (spec §5). Delivery is delayed. */
export interface Report {
  fromEchelon: Echelon;
  fromUnitId: number;
  toUnitId: number;
  /** sim tick the report was generated */
  sentTick: number;
  /** sim tick the report becomes readable by the recipient (sentTick + latency) */
  deliverTick: number;
  contacts: Contact[];
  /** sender's own strength / status summary */
  ownStatus: {
    effective: number;
    total: number;
    posCentroid: Vec2;
  };
}

export interface Scenario {
  name: string;
  seed: number;
  bounds: Bounds;
  walls: AABB[];
  /** starting soldiers, fully specified */
  soldiers: Soldier[];
  /** control measures for reference/rendering (spec §6): checkpoints, phase lines, objectives */
  controlMeasures?: ControlMeasure[];
}

export interface ControlMeasure {
  kind: "CP" | "PL" | "OBJ";
  label: string;
  /** point for CP/OBJ, polyline for PL */
  points: Vec2[];
}
