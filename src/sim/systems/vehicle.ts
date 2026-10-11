/**
 * 装甲車(IFV、`[v7.8]` ロードマップ B-1)。
 *
 * **中隊長が投入する資源で、プレイヤーは直接操作しない**(行き先を決めるだけ)。ロードマップの4段階を
 * まとめて入れた:
 *
 *   ① **道路を走る、動く火力支援**。車両用の航行グリッド(壁から `NAV_MARGIN` m 離れた屋外だけ —
 *      通るのに幅が要る)の上を走り、見えている敵を機関砲で撃つ。損傷は「動けない」「撃てない」の2種と撃破
 *   ② **歩兵が車体の陰に隠れて進み、ハッチを閉めた車両の目になる**。車体は視線を遮る(陰にいる兵は
 *      撃たれない)。脅威があればハッチを閉め、見えるのは砲塔の正面の狭い範囲だけになる — そのとき
 *      車両が撃てるのは、`INFANTRY_LINK` m 以内の味方の歩兵が見ている敵(車外電話で伝える、P1)
 *   ③ **路地や建物の上からの攻撃に弱い**。対戦車火器(A-3)の当たりは、正面より側面・後面、さらに
 *      上面(建物の中から撃ち下ろす・路地の脇から近く)で重くなる
 *   ④ **乗り降り**。小隊の1個分隊を乗せて始まり、目的地の手前・敵が近い・損傷したときに後ろへ降ろす。
 *      撃破されれば乗っている兵も巻き込まれる
 *
 * 行き先は、AI の中隊長(`aiVehicles`、既定は自分の小隊の後ろに付く護衛)・人間・LLM がすべて
 * `taskVehicle` を通る(P4)。乱数は陣営ごとの乱数列(P3)。陣営で分岐しない(P2)。
 * 敵の車両が見えるのは、兵士が自分の目で捉えたとき(`seesVehicles`、P1)だけ。
 */

import {
  BLEED_OUT_SEC,
  CQB,
  KIA_ON_HIT_CHANCE,
  SIM_DT,
  SIM_HZ,
  SUPPRESSION_GRACE_TICKS,
  VEHICLE,
} from "../constants.ts";
import { chance, ratePerTick } from "../rng.ts";
import { buildNavSet, findPathSet, nearestNodeIn, type NavSet } from "../navgrid.ts";
import { buildingAt } from "../cqb.ts";
import { collidesWallIndexed, hasLineOfSightIndexed } from "../wallIndex.ts";
import { isOffField } from "./litter.ts";
import { smokeBlocks } from "./smoke.ts";
import type { CompanyState, Side, Soldier, Vec2, Vehicle } from "../types.ts";
import type { World } from "../world.ts";

const STEP = VEHICLE.SPEED / SIM_HZ;
const TURN = VEHICLE.TURN_RATE / SIM_HZ;
const TURRET_TURN = VEHICLE.TURRET_RATE / SIM_HZ;
const HATCH_TICKS = Math.round(VEHICLE.HATCH_CLOSE_SEC * SIM_HZ);
const SUPPRESS_TICKS = Math.round(1.2 * SIM_HZ) + SUPPRESSION_GRACE_TICKS;
/** 撃っている見た目の間引き(機関砲の連射の弾道を出すティック間隔) */
const TRACER_EVERY = 6;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function unit(v: Vec2): Vec2 {
  const d = Math.hypot(v.x, v.z);
  return d < 1e-9 ? { x: 0, z: 1 } : { x: v.x / d, z: v.z / d };
}

/** 向き a を向き b へ、最大 step rad だけ回す */
function turnToward(a: Vec2, b: Vec2, step: number): Vec2 {
  const aa = Math.atan2(a.z, a.x);
  const bb = Math.atan2(b.z, b.x);
  let d = bb - aa;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const n = aa + Math.max(-step, Math.min(step, d));
  return { x: Math.cos(n), z: Math.sin(n) };
}

function angleBetween(a: Vec2, b: Vec2): number {
  const c = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
  return Math.acos(c);
}

// ── 編成と配置 ──────────────────────────────────────────────────────────────

/** 小隊の健在な兵(盤上にいる者)の重心 */
function platoonCentroid(world: World, side: Side, platoonId: number): Vec2 | null {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const s of world.soldiers) {
    if (s.side !== side || s.platoonId !== platoonId || s.status !== "ok" || isOffField(s)) continue;
    x += s.pos.x;
    z += s.pos.z;
    n++;
  }
  return n === 0 ? null : { x: x / n, z: z / n };
}

/**
 * 編成から作る(世界を作るときに呼ぶ)。装甲車を持つ陣営の、小隊本部を持つ小隊ごとに1両。
 * その小隊の最初の小銃分隊(機関銃を持たない分隊のうち squadId の最小)を乗せる(④)
 */
export function buildVehicles(world: World, enabled: Partial<Record<Side, boolean>>): Vehicle[] {
  const out: Vehicle[] = [];
  let id = 1;
  for (const pl of world.platoons) {
    if (!enabled[pl.side]) continue;
    if (!world.soldiers.some((s) => s.side === pl.side && s.platoonId === pl.platoonId && s.hqRole === "pl")) continue;
    const squads = world.squads
      .filter((q) => q.side === pl.side && q.platoonId === pl.platoonId)
      .filter((q) => !world.soldiers.some((s) => s.side === q.side && s.squadId === q.squadId && s.role === "mg"))
      .sort((a, b) => a.squadId - b.squadId);
    const v: Vehicle = {
      id: id++,
      side: pl.side,
      companyId: pl.companyId,
      platoonId: pl.platoonId,
      pos: { x: 0, z: 0 },
      facing: unit(pl.advanceDir),
      turret: unit(pl.advanceDir),
      damage: { mobility: false, firepower: false },
      destroyed: false,
      hatch: "open",
      hatchThreatTick: -1_000_000,
      task: { kind: "escort", target: null },
      route: [],
      routeIdx: 0,
      routeGoal: null,
      mounted: [],
      lastFireTick: -1_000_000,
      sees: [],
    };
    const first = squads[0];
    if (first) {
      for (const s of world.soldiers) {
        if (s.side === v.side && s.squadId === first.squadId) {
          s.mountedIn = v.id;
          v.mounted.push(s.id);
        }
      }
    }
    out.push(v);
  }
  world.vehicles = out;
  placeVehicles(world);
  return out;
}

/**
 * 車両を小隊の後ろに置き直す(作戦立案で部隊が集結地へ動いたあとにも呼ぶ)。
 * 車両の航行グリッドの上の、小隊の重心から前進方向の逆へ `ESCORT_TRAIL` m 付近
 */
export function placeVehicles(world: World): void {
  for (const v of world.vehicles) {
    const pl = world.platoons.find((p) => p.side === v.side && p.platoonId === v.platoonId);
    const c = platoonCentroid(world, v.side, v.platoonId);
    if (!pl || !c) continue;
    const dir = unit(pl.advanceDir);
    const want = { x: c.x - dir.x * VEHICLE.ESCORT_TRAIL, z: c.z - dir.z * VEHICLE.ESCORT_TRAIL };
    const nav = vehicleNav(world);
    v.pos = snapToNav(nav, want) ?? want;
    v.facing = dir;
    v.turret = dir;
    v.route = [];
    v.routeIdx = 0;
    v.routeGoal = null;
    syncMounted(world, v);
  }
}

/** 車両用の航行グリッド(初めて要るときに張る)。屋外だけ、壁から `NAV_MARGIN` m 離れたところ */
export function vehicleNav(world: World): NavSet {
  if (!world.vehicleNav) {
    world.vehicleNav = buildNavSet(
      world.navWalls,
      world.bounds,
      VEHICLE.NAV_STEP,
      VEHICLE.NAV_MARGIN,
      world.buildings,
      [],
      CQB.NAV_STEP,
      CQB.NAV_MARGIN,
    );
  }
  return world.vehicleNav;
}

/** 車両の航行グリッドの最寄りのノード(無ければ null) */
function snapToNav(nav: NavSet, p: Vec2): Vec2 | null {
  const i = nearestNodeIn(nav, p.x, p.z);
  if (i === -1) return null;
  const n = nav.nodes[i]!;
  return { x: n.x, z: n.z };
}

/** 乗っている兵の位置を車両に合わせる */
function syncMounted(world: World, v: Vehicle): void {
  for (const id of v.mounted) {
    const s = world.soldierById.get(id);
    if (!s) continue;
    s.pos = { ...v.pos };
    s.eye = { ...v.pos };
    s.path = [];
    s.pathIdx = 0;
  }
}

// ── 当たり判定・視線 ────────────────────────────────────────────────────────

/** 点を車両の局所座標(右 = x、前 = z)へ */
function local(v: Vehicle, p: Vec2): Vec2 {
  const dx = p.x - v.pos.x;
  const dz = p.z - v.pos.z;
  const right = { x: -v.facing.z, z: v.facing.x };
  return { x: dx * right.x + dz * right.z, z: dx * v.facing.x + dz * v.facing.z };
}

/** 点が車体の中か(余裕 pad m) */
export function insideHull(v: Vehicle, p: Vec2, pad = 0): boolean {
  const l = local(v, p);
  return Math.abs(l.x) <= VEHICLE.HALF_W + pad && Math.abs(l.z) <= VEHICLE.HALF_L + pad;
}

/** 線分 a→b が車体を横切るか(slab 法)。端点が車体の中にある場合は数えない(乗っている・接している) */
function segmentHitsHull(v: Vehicle, a: Vec2, b: Vec2): boolean {
  const la = local(v, a);
  const lb = local(v, b);
  if (Math.abs(la.x) <= VEHICLE.HALF_W && Math.abs(la.z) <= VEHICLE.HALF_L) return false;
  if (Math.abs(lb.x) <= VEHICLE.HALF_W && Math.abs(lb.z) <= VEHICLE.HALF_L) return false;
  let t0 = 0;
  let t1 = 1;
  const d = { x: lb.x - la.x, z: lb.z - la.z };
  for (const [p, dd, h] of [
    [la.x, d.x, VEHICLE.HALF_W],
    [la.z, d.z, VEHICLE.HALF_L],
  ] as const) {
    if (Math.abs(dd) < 1e-9) {
      if (p < -h || p > h) return false;
      continue;
    }
    let ta = (-h - p) / dd;
    let tb = (h - p) / dd;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * 車体が視線を遮るか(`[v7.8]` B-1 ②)。撃破された車両の残骸も遮る。索敵(perception)が
 * 兵士どうしの視線ごとに呼ぶ — 車両が無ければ何もしない
 */
export function vehicleBlocks(world: World, a: Vec2, b: Vec2): boolean {
  for (const v of world.vehicles) if (segmentHitsHull(v, a, b)) return true;
  return false;
}

// ── 毎ティック: 視界・ハッチ・移動・乗り降り ─────────────────────────────────

/** 車両が自分の目で見られる敵兵か(ハッチの開閉で範囲が変わる) */
function vehicleSeesSoldier(world: World, v: Vehicle, t: Soldier): boolean {
  const d = dist(v.pos, t.pos);
  if (v.hatch === "open") {
    if (d > VEHICLE.SIGHT_OPEN) return false;
  } else {
    if (d > VEHICLE.SIGHT_CLOSED) return false;
    const to = unit({ x: t.pos.x - v.pos.x, z: t.pos.z - v.pos.z });
    if (angleBetween(v.turret, to) > VEHICLE.SIGHT_CLOSED_HALF_RAD) return false;
  }
  if (!hasLineOfSightIndexed(world.wallIndex, v.pos.x, v.pos.z, t.eye.x, t.eye.z)) return false;
  return !smokeBlocks(world, v.pos.x, v.pos.z, t.eye.x, t.eye.z);
}

/** 兵士が見ている敵の車両(索敵のあとに呼ぶ)。車両は大きく音も大きいので、視界扇形を問わない */
function soldiersSeeVehicles(world: World): void {
  for (const s of world.soldiers) {
    if (s.seesVehicles && s.seesVehicles.length > 0) s.seesVehicles = [];
  }
  if (world.vehicles.length === 0) return;
  for (const s of world.soldiers) {
    if (s.status !== "ok" || isOffField(s)) continue;
    for (const v of world.vehicles) {
      if (v.side === s.side || v.destroyed) continue;
      if (dist(s.pos, v.pos) > world.tuning.detectRange) continue;
      if (!hasLineOfSightIndexed(world.wallIndex, s.eye.x, s.eye.z, v.pos.x, v.pos.z)) continue;
      if (smokeBlocks(world, s.eye.x, s.eye.z, v.pos.x, v.pos.z)) continue;
      (s.seesVehicles ??= []).push(v.id);
    }
  }
}

/** 車両が捉えている敵兵: 自分の目 + まわりの味方の歩兵の目(②、P1) */
function updateSight(world: World, v: Vehicle): void {
  const seen = new Set<number>();
  for (const t of world.soldiers) {
    if (t.side === v.side || t.status !== "ok" || isOffField(t)) continue;
    if (vehicleSeesSoldier(world, v, t)) seen.add(t.id);
  }
  for (const s of world.soldiers) {
    if (s.side !== v.side || s.status !== "ok" || isOffField(s)) continue;
    if (dist(s.pos, v.pos) > VEHICLE.INFANTRY_LINK) continue;
    for (const id of s.sees) seen.add(id);
  }
  v.sees = [...seen].sort((a, b) => a - b);
}

/** 行き先(護衛なら自分の小隊の先頭の後ろ)。行き先が無ければ null(止まる) */
function goalOf(world: World, v: Vehicle): Vec2 | null {
  if (v.task.kind === "hold") return null;
  if (v.task.kind === "move") return v.task.target;
  const pl = world.platoons.find((p) => p.side === v.side && p.platoonId === v.platoonId);
  if (!pl) return null;
  const dir = unit(pl.advanceDir);
  let lead: Soldier | null = null;
  let leadF = -Infinity;
  for (const s of world.soldiers) {
    if (s.side !== v.side || s.platoonId !== v.platoonId || s.status !== "ok" || isOffField(s)) continue;
    const f = s.pos.x * dir.x + s.pos.z * dir.z;
    if (f > leadF + 1e-9) {
      leadF = f;
      lead = s;
    }
  }
  // 歩兵が全員乗っている・倒れているなら、小隊の目標へ(降車の判断はそこで)
  if (!lead) return { ...pl.objective };
  // 先頭の後ろへ。ただし目標を越えては出ない
  return { x: lead.pos.x - dir.x * VEHICLE.ESCORT_TRAIL, z: lead.pos.z - dir.z * VEHICLE.ESCORT_TRAIL };
}

function move(world: World, v: Vehicle): void {
  if (v.damage.mobility || v.destroyed) return;
  const goal = goalOf(world, v);
  if (!goal) return;
  if (v.task.kind === "move" && dist(v.pos, goal) < 4) {
    v.task = { kind: "hold", target: null };
    return;
  }
  if (!v.routeGoal || dist(v.routeGoal, goal) > VEHICLE.REPATH_DIST || v.routeIdx >= v.route.length) {
    if (dist(v.pos, goal) < 3) return;
    const path = findPathSet(vehicleNav(world), v.pos.x, v.pos.z, goal.x, goal.z);
    v.routeGoal = { ...goal };
    v.route = path ?? [];
    v.routeIdx = 0;
    if (!path) return;
  }
  const wp = v.route[v.routeIdx];
  if (!wp) return;
  const to = { x: wp.x - v.pos.x, z: wp.z - v.pos.z };
  const d = Math.hypot(to.x, to.z);
  if (d < 1.0) {
    v.routeIdx++;
    return;
  }
  const want = unit(to);
  v.facing = turnToward(v.facing, want, TURN);
  // 向きが合っていないうちはその場で旋回する(曲がり角で車体を建物へ振り込まない)
  if (angleBetween(v.facing, want) > Math.PI / 8) return;
  const step = Math.min(d, STEP);
  // 経路の点へまっすぐ進む(向きの誤差で角を削らない)。車体の幅で壁に当たるなら進まない
  const np = { x: v.pos.x + want.x * step, z: v.pos.z + want.z * step };
  if (hullHitsWall(world, np)) {
    v.routeGoal = null; // 経路を引き直す
    return;
  }
  v.pos = np;
}

/** その位置に車体を置くと壁(建物)に当たるか。車体の幅の円で見る(向きによらない控えめな判定) */
function hullHitsWall(world: World, p: Vec2): boolean {
  return collidesWallIndexed(world.moveIndex, p.x, p.z, VEHICLE.HALF_W) || buildingAt(world.buildings, p) !== null;
}

/** 車体の中にいる兵を横へ押し出す(車体は人を通さない) */
function pushOut(world: World, v: Vehicle): void {
  for (const s of world.soldiers) {
    if (s.status === "kia" || isOffField(s) || !insideHull(v, s.pos, 0.4)) continue;
    const l = local(v, s.pos);
    const right = { x: -v.facing.z, z: v.facing.x };
    const side = l.x >= 0 ? 1 : -1;
    const out = (VEHICLE.HALF_W + 0.6 - Math.abs(l.x)) * side;
    const np = { x: s.pos.x + right.x * out, z: s.pos.z + right.z * out };
    if (!collidesWallIndexed(world.moveIndex, np.x, np.z, 0.35)) s.pos = np;
  }
}

/** 乗っている兵を車両の後ろへ降ろす(④) */
export function dismount(world: World, v: Vehicle): void {
  if (v.mounted.length === 0) return;
  const back = { x: -v.facing.x, z: -v.facing.z };
  const right = { x: -v.facing.z, z: v.facing.x };
  v.mounted.forEach((id, i) => {
    const s = world.soldierById.get(id);
    if (!s) return;
    const lat = ((i % 3) - 1) * 1.4;
    const row = VEHICLE.HALF_L + 1.5 + Math.floor(i / 3) * 1.4;
    let p = {
      x: v.pos.x + back.x * row + right.x * lat,
      z: v.pos.z + back.z * row + right.z * lat,
    };
    if (collidesWallIndexed(world.moveIndex, p.x, p.z, 0.35)) p = { ...v.pos };
    s.mountedIn = null;
    s.pos = p;
    s.eye = { ...p };
    s.path = [];
    s.pathIdx = 0;
    s.facing = { ...v.facing };
    s.order = { kind: "hold", facing: { ...v.facing }, issuedTick: world.tick };
  });
  v.mounted = [];
}

function maybeDismount(world: World, v: Vehicle): void {
  if (v.mounted.length === 0) return;
  const pl = world.platoons.find((p) => p.side === v.side && p.platoonId === v.platoonId);
  const goal = v.task.kind === "move" && v.task.target ? v.task.target : pl?.objective;
  const nearGoal = goal ? dist(v.pos, goal) <= VEHICLE.DISMOUNT_GOAL : false;
  const threat = v.sees.some((id) => {
    const t = world.soldierById.get(id);
    return t ? dist(t.pos, v.pos) <= VEHICLE.DISMOUNT_THREAT : false;
  });
  const hurt = v.damage.mobility || v.damage.firepower || v.destroyed;
  if (nearGoal || threat || hurt) dismount(world, v);
}

/** 毎ティック: 兵士の移動のあと、分離の前に呼ぶ(押し出しは分離が仕上げる) */
export function vehicleSystem(world: World): void {
  soldiersSeeVehicles(world);
  if (world.vehicles.length === 0) return;
  for (const v of world.vehicles) {
    if (v.destroyed) continue;
    updateSight(world, v);
    // ハッチ: 見える敵がいる・撃たれた直後は閉める(②)
    const ownThreat = v.sees.some((id) => {
      const t = world.soldierById.get(id);
      return t !== undefined && vehicleSeesSoldier(world, { ...v, hatch: "open" }, t);
    });
    if (ownThreat) v.hatchThreatTick = world.tick;
    v.hatch = world.tick - v.hatchThreatTick < HATCH_TICKS ? "closed" : "open";
    move(world, v);
    syncMounted(world, v);
    maybeDismount(world, v);
    pushOut(world, v);
  }
}

// ── 射撃 ────────────────────────────────────────────────────────────────────

/**
 * 毎秒の命中率。距離で落ち、遮蔽(窓・射撃壕・建物の中)・伏せで下がる。歩兵の射撃と同じく
 * 遮蔽に就いた者には当たりにくい(機関砲は壁ごと撃てるので、小銃ほどは下がらない)
 */
function hitRate(world: World, d: number, t: Soldier): number {
  const k = Math.min(1, Math.max(0, (d - VEHICLE.GUN_NEAR) / (VEHICLE.GUN_RANGE - VEHICLE.GUN_NEAR)));
  let r = VEHICLE.HIT_RATE_NEAR + (VEHICLE.HIT_RATE_FAR - VEHICLE.HIT_RATE_NEAR) * k;
  if (t.atWindow || buildingAt(world.buildings, t.pos)) r *= VEHICLE.COVER_MUL;
  else if (t.prone) r *= VEHICLE.PRONE_MUL;
  return r;
}

/**
 * 毎ティック: 捉えている敵兵を機関砲で撃つ。戦闘の判定の前に呼ぶ(当たった者はそのティックに撃てない)。
 * 撃つのは最寄りの敵。砲塔を向けてから撃つ。当たれば負傷(または戦死)、まわりは制圧
 */
export function vehicleFireSystem(world: World): void {
  for (const v of world.vehicles) {
    if (v.destroyed || v.damage.firepower) continue;
    let target: Soldier | null = null;
    let bestD = Infinity;
    for (const id of v.sees) {
      const t = world.soldierById.get(id);
      if (!t || t.status !== "ok" || isOffField(t)) continue;
      const d = dist(v.pos, t.pos);
      if (d > VEHICLE.GUN_RANGE || d >= bestD) continue;
      // 車体のすぐ陰の味方越しには撃たない(射線上に味方 — §8.2 の作法)
      target = t;
      bestD = d;
    }
    if (!target) continue;
    const to = unit({ x: target.pos.x - v.pos.x, z: target.pos.z - v.pos.z });
    v.turret = turnToward(v.turret, to, TURRET_TURN);
    if (angleBetween(v.turret, to) > VEHICLE.ALIGN_RAD) continue;
    const rng = world.rngBySide[v.side];
    const hit = chance(rng, ratePerTick(hitRate(world, bestD, target), SIM_DT));
    // 制圧: 撃っている間、標的のまわりの敵は頭を下げる
    for (const s of world.soldiers) {
      if (s.side === v.side || s.status !== "ok" || isOffField(s)) continue;
      if (dist(s.pos, target.pos) <= VEHICLE.SUPPRESS_RADIUS) {
        s.suppressedUntilTick = Math.max(s.suppressedUntilTick, world.tick + SUPPRESS_TICKS);
      }
    }
    target.alertFrom = { ...v.pos };
    target.alertUntilTick = world.tick + Math.round(4 * SIM_HZ);
    if (hit) {
      if (chance(rng, KIA_ON_HIT_CHANCE)) {
        target.status = "kia";
        target.bleedOutTick = 0;
        target.assignedAider = null;
      } else {
        target.status = "wia";
        target.bleedOutTick = world.tick + Math.round(BLEED_OUT_SEC * SIM_HZ);
      }
      target.path = [];
      target.pathIdx = 0;
    }
    if (hit || world.tick - v.lastFireTick >= TRACER_EVERY) {
      v.lastFireTick = world.tick;
      world.fx.push({
        kind: "shot",
        from: { ...v.pos },
        to: { ...target.pos },
        side: v.side,
        hit,
        shooterId: -1,
        targetId: target.id,
        weapon: "vehicle",
      });
    }
    world.gunshots.push({ sourceId: -1, side: v.side, pos: { ...v.pos }, range: VEHICLE.HEARING_RANGE });
  }
}

// ── 損傷(③)───────────────────────────────────────────────────────────────

export type VehicleHitAspect = "front" | "side" | "top";

/** 当たった向き。撃った者が建物の中(撃ち下ろし)か、路地の脇から近くなら上面 */
export function hitAspect(world: World, v: Vehicle, from: Vec2): VehicleHitAspect {
  if (buildingAt(world.buildings, from) || dist(from, v.pos) <= VEHICLE.CLOSE_TOP) return "top";
  const to = unit({ x: from.x - v.pos.x, z: from.z - v.pos.z });
  return angleBetween(v.facing, to) <= VEHICLE.FRONT_HALF_RAD ? "front" : "side";
}

/**
 * 対戦車火器が車体に当たった(systems/antiArmor.ts から)。向きで損傷の確率が変わる。
 * 撃破なら乗っている兵は `MOUNTED_CASUALTY` で倒れ、残りは降りる。乱数は撃った側の陣営の列(P3)
 */
export function applyVehicleHit(world: World, v: Vehicle, from: Vec2, shooterSide: Side): VehicleHitAspect {
  const aspect = hitAspect(world, v, from);
  const [pm, pf, pk] =
    aspect === "front" ? VEHICLE.DAMAGE_FRONT : aspect === "side" ? VEHICLE.DAMAGE_SIDE : VEHICLE.DAMAGE_TOP;
  const rng = world.rngBySide[shooterSide];
  v.hatchThreatTick = world.tick;
  if (chance(rng, pk)) {
    v.destroyed = true;
    v.damage = { mobility: true, firepower: true };
    for (const id of v.mounted) {
      const s = world.soldierById.get(id);
      if (s && chance(rng, VEHICLE.MOUNTED_CASUALTY)) {
        s.status = "wia";
        s.bleedOutTick = world.tick + Math.round(BLEED_OUT_SEC * SIM_HZ);
      }
    }
    dismount(world, v);
  } else {
    if (chance(rng, pm)) v.damage.mobility = true;
    if (chance(rng, pf)) v.damage.firepower = true;
  }
  world.fx.push({
    kind: "vehicle",
    at: { ...v.pos },
    side: v.side,
    radius: v.destroyed ? 5 : 2.5,
    damage: v.destroyed ? "destroyed" : v.damage.mobility && v.damage.firepower ? "both" : v.damage.mobility ? "mobility" : v.damage.firepower ? "firepower" : "none",
  });
  return aspect;
}

// ── 誰が行き先を決めるか(P4)───────────────────────────────────────────────

export type VehicleBlock = "no_vehicle" | "destroyed" | "immobile" | "no_route";

export const VEHICLE_BLOCK_TEXT: Record<VehicleBlock, string> = {
  no_vehicle: "その装甲車はこの中隊のものではない",
  destroyed: "撃破されている",
  immobile: "足回りをやられて動けない",
  no_route: "車両が通れる道が無い(屋内・狭い路地)",
};

export type VehicleResult = { ok: true } | { ok: false; reason: VehicleBlock };

/** その中隊の装甲車 */
export function vehiclesOf(world: World, co: CompanyState): Vehicle[] {
  return world.vehicles.filter((v) => v.side === co.side && v.companyId === co.companyId);
}

/**
 * 装甲車の行き先を決める(AI・人間・LLM 共通、P4)。`target` が null なら護衛(自分の小隊に付く)へ戻す
 */
export function taskVehicle(world: World, co: CompanyState, vehicleId: number, target: Vec2 | null): VehicleResult {
  const v = vehiclesOf(world, co).find((x) => x.id === vehicleId);
  if (!v) return { ok: false, reason: "no_vehicle" };
  if (v.destroyed) return { ok: false, reason: "destroyed" };
  if (v.damage.mobility) return { ok: false, reason: "immobile" };
  if (target === null) {
    v.task = { kind: "escort", target: null };
    return { ok: true };
  }
  if (!findPathSet(vehicleNav(world), v.pos.x, v.pos.z, target.x, target.z)) return { ok: false, reason: "no_route" };
  v.task = { kind: "move", target: { ...target } };
  v.routeGoal = null;
  return { ok: true };
}

/**
 * AI の中隊長(`[v7.8]`)。装甲車は自分の小隊に付く護衛のまま使う(歩兵と離れた車両は路地で狩られる、③)。
 * 人間・LLM が行き先を決めた車両は、着くまでその行き先を守る(着けば止まり、次の判断で護衛へ戻す)
 */
export function aiVehicles(world: World, co: CompanyState): void {
  for (const v of vehiclesOf(world, co)) {
    if (v.destroyed || v.damage.mobility) continue;
    if (v.task.kind === "hold") taskVehicle(world, co, v.id, null);
  }
}

