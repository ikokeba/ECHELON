/**
 * 対ドローンの隠蔽行動(React to UAS、`[v7.5]` ロードマップ S-7、設計メモ §6.3)。
 *
 * S-6 でドローンに気づけるようになった分隊が、見つかる前に身を隠す。米陸軍 ATP 3-01.81 の
 * 受動的な対策(隠蔽・移動の抑制)にあたる。分隊長の判断で、次のどれか1つを取る:
 *
 *   1. shelter : 近く(`UAS_REACT.SHELTER_DIST`)に建物があれば、扉を開けて入り、ドローンが去るまで待つ
 *   2. smoke   : 建物が無く、開けた場所を移動中なら、行く手に煙を焚いてその中を渡り切る
 *   3. prone   : どちらでもなければ、その場で止まって伏せる
 *
 * **代償は前進が止まること。** さらに、入るところをドローンに見られていれば、その建物の
 * 前に接触が残る(像の仕組み — 最後に見た位置に接触が残る — でそのまま起きる)。屋内は
 * 迫撃砲に強い(`[v7.4]`)が、対構造物火器と突入には弱い。隠れ場所が次の戦闘の場所になる。
 *
 * 続ける例外(AIの分隊長): 突撃・突入の最中、撃ち合いの最中、陣地(機関銃陣地・前進陣地・
 * 待ち伏せ)に就いているとき。どれも、隠れに動くほうが危ない。
 *
 * 判断の材料は分隊長の像(`sq.uas` と `sq.belief`)と自分の分隊の状態だけ(ロードマップ P1)。
 * 始めるのはAIの分隊長も人間・LLM も同じ `reactToUas`(P4)。乱数は引かない(P3)。
 */

import { SIM_HZ, SMOKE, UAS_REACT } from "../constants.ts";
import { buildingAt, doorById, insideBounds, roomAt, roomOfDoor } from "../cqb.ts";
import { collidesWall } from "../geometry.ts";
import { activateBuildingNav, refreshBlockers } from "../world.ts";
import { isSquadPost } from "./defense.ts";
import { issue } from "./fireteam.ts";
import { isOffField } from "../systems/litter.ts";
import { smokeCooldownLeft, smokeThrower, throwSmoke } from "../systems/smoke.ts";
import type {
  Building,
  Contact,
  Door,
  FireteamState,
  Soldier,
  SquadState,
  UasReaction,
  Vec2,
} from "../types.ts";
import type { World } from "../world.ts";

const FRESH_TICKS = Math.round(UAS_REACT.TRIGGER_FRESH_SEC * SIM_HZ);
const RELEASE_TICKS = Math.round(UAS_REACT.RELEASE_SEC * SIM_HZ);
const MAX_TICKS = Math.round(UAS_REACT.MAX_SEC * SIM_HZ);
const COOLDOWN_TICKS = Math.round(UAS_REACT.COOLDOWN_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function centroid(units: readonly Soldier[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const u of units) {
    x += u.pos.x;
    z += u.pos.z;
  }
  return { x: x / units.length, z: z / units.length };
}

/** 分隊の戦える隊員(分隊長を含む)。並びは編成上の通し番号(P2) */
function squadMen(world: World, sq: SquadState): Soldier[] {
  return world.soldiers
    .filter(
      (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok" && !isOffField(s),
    )
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** 分隊の像の中で、近く・新しいドローンの接触(きっかけ)。無ければ null */
export function nearUasThreat(world: World, sq: SquadState, at: Vec2): Contact | null {
  let best: Contact | null = null;
  for (const c of sq.uas.values()) {
    if (world.tick - c.lastSeenTick > FRESH_TICKS) continue;
    if (dist(c.pos, at) > UAS_REACT.TRIGGER_DIST) continue;
    if (!best || c.lastSeenTick > best.lastSeenTick) best = c;
  }
  return best;
}

/** 分隊は陣地に就いているか(機関銃陣地の班・前進陣地・待ち伏せ) */
export function onPost(world: World, sq: SquadState): boolean {
  return world.defense.some(
    (p) =>
      p.side === sq.side &&
      p.crew !== null &&
      p.crew.squadId === sq.squadId &&
      (p.kind === "mg" || (isSquadPost(p) && p.stage !== "released")),
  );
}

/** 突撃・突入の最中か */
function assaulting(world: World, sq: SquadState, men: readonly Soldier[]): boolean {
  if (sq.assaultDoorId !== null || sq.flankAssault) return true;
  if (
    world.fireteams.some((f) => f.side === sq.side && f.squadId === sq.squadId && f.mode === "CQB")
  ) {
    return true;
  }
  return men.some((m) => m.assaultingUntilTick > world.tick);
}

/** 建物の中に、分隊長の像で敵がいるか(いる建物には逃げ込まない) */
function enemyBelievedInside(sq: SquadState, b: Building): boolean {
  for (const c of sq.belief.values()) {
    if (c.confidence > 0 && !c.heard && insideBounds(b.bounds, c.pos)) return true;
  }
  return false;
}

/** 分隊の重心から近い外扉(建物の外にいる分隊が入れる扉)。範囲内に無ければ null */
function nearestShelterDoor(world: World, sq: SquadState, at: Vec2): Door | null {
  let best: Door | null = null;
  let bestD: number = UAS_REACT.SHELTER_DIST;
  for (const b of world.buildings) {
    if (enemyBelievedInside(sq, b)) continue;
    for (const d of b.doors) {
      if (!d.exterior) continue;
      const r = dist(d.pos, at);
      if (r <= bestD) {
        bestD = r;
        best = d;
      }
    }
  }
  return best;
}

/** 部屋の中の持ち場を、壁から余白をとって格子に並べる(先頭は部屋の中心に近い順) */
function roomSpots(
  world: World,
  room: { bounds: { minX: number; maxX: number; minZ: number; maxZ: number } },
): Vec2[] {
  const b = room.bounds;
  const m = UAS_REACT.SPOT_MARGIN;
  const step = UAS_REACT.SPOT_SPACING;
  const c = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  const out: Vec2[] = [];
  for (let x = b.minX + m; x <= b.maxX - m + 1e-6; x += step) {
    for (let z = b.minZ + m; z <= b.maxZ - m + 1e-6; z += step) {
      if (!collidesWall(world.walls, x, z, 0.35)) out.push({ x, z });
    }
  }
  if (out.length === 0) out.push(c);
  out.sort((p, q) => dist(p, c) - dist(q, c) || p.x - q.x || p.z - q.z);
  return out;
}

/**
 * 隠蔽行動を選んで始める(`[v7.5]` S-7)。**AIの分隊長・人間・LLM が全員この関数を通る。**
 * 例外の判断(突撃中・撃ち合い中・陣地)は呼ぶ側(AI)が行う — 人間・LLM はいつでも命じられる。
 * 始められなければ null(分隊に戦える者がいない)。
 */
export function reactToUas(world: World, sq: SquadState): UasReaction | null {
  const men = squadMen(world, sq);
  if (men.length === 0 || sq.commanderId === null) return null;
  const c = centroid(men);
  const since = world.tick;

  // 1. すでに過半数が屋内にいるなら、その建物で止まる
  const host = buildingAt(world.buildings, c);
  const insideN = host ? men.filter((m) => insideBounds(host.bounds, m.pos)).length : 0;
  if (host && insideN * 2 >= men.length) {
    const room = roomAt(world.buildings, c);
    return start(world, sq, {
      kind: "shelter",
      sinceTick: since,
      buildingId: host.id,
      doorId: null,
      spot: room
        ? {
            x: (room.bounds.minX + room.bounds.maxX) / 2,
            z: (room.bounds.minZ + room.bounds.maxZ) / 2,
          }
        : c,
    });
  }

  // 2. 近くの建物へ入る
  const door = nearestShelterDoor(world, sq, c);
  if (door) {
    const room = roomOfDoor(world.buildings, door);
    const spot = room
      ? roomSpots(world, room)[0]!
      : { x: door.pos.x + door.normal.x * 3, z: door.pos.z + door.normal.z * 3 };
    activateBuildingNav(world, door.buildingId);
    return start(world, sq, {
      kind: "shelter",
      sinceTick: since,
      buildingId: door.buildingId,
      doorId: door.id,
      spot,
    });
  }

  // 3. 開けた場所を移動中なら、行く手に煙を焚いて渡り切る
  const moving = men.filter((m) => m.pathIdx < m.path.length).length;
  const thrower = smokeThrower(world, sq);
  if (moving * 2 >= men.length && sq.smokes > 0 && thrower && smokeCooldownLeft(world, sq) === 0) {
    const toObj = dist(c, sq.objective);
    const dir =
      toObj > 5
        ? { x: (sq.objective.x - c.x) / toObj, z: (sq.objective.z - c.z) / toObj }
        : { ...sq.advanceDir };
    let target = { x: c.x + dir.x * UAS_REACT.SMOKE_AHEAD, z: c.z + dir.z * UAS_REACT.SMOKE_AHEAD };
    const td = dist(thrower.pos, target);
    if (td > SMOKE.THROW_RANGE) {
      const k = (SMOKE.THROW_RANGE - 0.01) / td;
      target = {
        x: thrower.pos.x + (target.x - thrower.pos.x) * k,
        z: thrower.pos.z + (target.z - thrower.pos.z) * k,
      };
    }
    if (throwSmoke(world, sq, target).ok)
      return start(world, sq, { kind: "smoke", sinceTick: since });
  }

  // 4. その場で止まって伏せる
  return start(world, sq, { kind: "prone", sinceTick: since });
}

function start(world: World, sq: SquadState, r: UasReaction): UasReaction {
  // 前の行動の名残(伏せ)を消してから始める
  if (sq.uasReact) standUp(world, sq);
  sq.uasReact = r;
  return r;
}

function standUp(world: World, sq: SquadState): void {
  for (const s of world.soldiers)
    if (s.side === sq.side && s.squadId === sq.squadId && s.prone) s.prone = false;
}

/** 隠蔽行動を終える(`[v7.5]`)。人間・LLM の取り消しもここを通る */
export function releaseUasReaction(world: World, sq: SquadState): void {
  if (!sq.uasReact) return;
  standUp(world, sq);
  sq.uasReact = null;
  sq.uasReactEndTick = world.tick;
}

/**
 * 毎ティック(分隊長の座席に誰が座っていても): ドローンが去ったら終える。分隊の像の中で最も新しい
 * ドローンの接触が `RELEASE_SEC` より古くなるか、`MAX_SEC` 続いたら
 */
export function updateUasReaction(world: World, sq: SquadState): void {
  const r = sq.uasReact;
  if (!r) return;
  let newest = -Infinity;
  for (const c of sq.uas.values()) newest = Math.max(newest, c.lastSeenTick);
  const quiet = world.tick - Math.max(newest, r.sinceTick) > RELEASE_TICKS;
  if (quiet || world.tick - r.sinceTick > MAX_TICKS) releaseUasReaction(world, sq);
}

/**
 * AIの分隊長の判断(`[v7.5]`)。近く・新しいドローンの接触があり、例外に当たらなければ始める。
 * 始めたら true
 */
export function aiReactToUas(world: World, sq: SquadState): boolean {
  if (sq.uasReact || sq.uas.size === 0) return false;
  if (world.tick - sq.uasReactEndTick < COOLDOWN_TICKS) return false;
  const men = squadMen(world, sq);
  if (men.length === 0) return false;
  if (!nearUasThreat(world, sq, centroid(men))) return false;
  if (onPost(world, sq) || assaulting(world, sq, men)) return false;
  // `[v7.5]` 対ドローン装備(A-10)を持つ者が戦えるなら、隠れずに撃ち落としにかかる
  if (men.some((m) => m.quals.counterUas === true && !m.routed)) return false;
  const fts = world.fireteams.filter((f) => f.side === sq.side && f.squadId === sq.squadId);
  if (fts.some((f) => f.mode === "CONTACT" || f.mode === "FALLBACK" || f.mode === "ROUT"))
    return false;
  return reactToUas(world, sq) !== null;
}

/** 分隊が隠れて止まっているか(建物で待つ・伏せる)。煙は足を止めないので含めない */
export function hiding(sq: SquadState): boolean {
  return sq.uasReact !== null && sq.uasReact.kind !== "smoke";
}

/** 屋内の持ち場の、隊員ごとの割り当て(分隊の中での通し番号で配る) */
function shelterSpotFor(world: World, r: UasReaction, index: number): Vec2 {
  const room =
    r.doorId != null
      ? (() => {
          const d = doorById(world.buildings, r.doorId);
          return d ? roomOfDoor(world.buildings, d) : null;
        })()
      : r.spot
        ? roomAt(world.buildings, r.spot)
        : null;
  if (!room) {
    // 部屋の分からない屋内(塹壕・区画の無い建物)では、集合点のまわりに格子で散る
    const c = r.spot ?? { x: 0, z: 0 };
    const s = UAS_REACT.SPOT_SPACING;
    return { x: c.x + ((index % 3) - 1) * s, z: c.z + (Math.floor(index / 3) - 1) * s };
  }
  const spots = roomSpots(world, room);
  return spots[index % spots.length]!;
}

/** 隠れている隊員1人の命令。建物へ向かう(着いたら止まる)か、その場で伏せる */
function hideOne(world: World, r: UasReaction, u: Soldier, index: number): void {
  if (r.kind === "prone") {
    if (stop(world, u)) u.prone = true;
    return;
  }
  const spot = shelterSpotFor(world, r, index);
  if (dist(u.pos, spot) < 0.6) stop(world, u);
  else issue(world, u, "move", spot, { ...u.facing });
}

/**
 * その場で止める。保持の命令は経路を捨てないので、ここで捨てる(分隊長の位置取りと同じ)。
 * 命令が届いたら true(手当・担架に拘束されている者、人間が座っている者には届かない)
 */
function stop(world: World, u: Soldier): boolean {
  issue(world, u, "hold", null, { ...u.facing });
  if (u.order.kind !== "hold" || u.order.issuedTick !== world.tick) return false;
  u.path = [];
  u.pathIdx = 0;
  return true;
}

/** 通る扉が閉じていれば、扉の前まで来た隊員が開ける */
function openShelterDoor(world: World, r: UasReaction, men: readonly Soldier[]): void {
  if (r.doorId == null) return;
  const d = doorById(world.buildings, r.doorId);
  if (!d || d.open) return;
  if (men.some((m) => dist(m.pos, d.pos) <= UAS_REACT.DOOR_OPEN_DIST)) {
    d.open = true;
    refreshBlockers(world);
  }
}

/**
 * FTの命令(`fireteamAI` から、モードを決めたあとに呼ぶ)。分隊が隠れていて、FTが前進・掃討の
 * 最中なら隠れる命令を出して true。撃ち合い・後退・潰走・突入はそちらが優先(false)
 */
export function runUasHide(world: World, ft: FireteamState, living: readonly Soldier[]): boolean {
  if (ft.mode !== "ADVANCE" && ft.mode !== "SEARCH") return false;
  const sq = world.squads.find((s) => s.side === ft.side && s.squadId === ft.squadId);
  if (!sq || !hiding(sq)) return false;
  const r = sq.uasReact!;
  const men = squadMen(world, sq);
  if (r.kind === "shelter") openShelterDoor(world, r, living);
  for (const u of living) hideOne(world, r, u, men.indexOf(u));
  return true;
}

/** 分隊長本人の位置取り(`squadAI` から)。隠れているなら隊員と同じく隠れて true */
export function hideSquadLeader(world: World, sq: SquadState, sl: Soldier): boolean {
  if (!hiding(sq)) return false;
  const r = sq.uasReact!;
  if (r.kind === "shelter") openShelterDoor(world, r, [sl]);
  hideOne(world, r, sl, squadMen(world, sq).indexOf(sl));
  return true;
}
