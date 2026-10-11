/**
 * トンネル(`[v7.7]` ロードマップ B-4 混成型の編成)。
 *
 * 混成型の防御側の中隊長が、立案のときに**拠点の建物と後方の建物**(および拠点の建物どうし)を
 * 地下で結ぶ(`planTunnels`)。攻撃側には見えない(陣地と同じ、P1)。
 *
 * 使い方は「誰が操っていても同じ規則」(P4): 自軍の兵が、いま居る建物と目指す建物がトンネルで
 * 結ばれていて、目指す先が `TUNNEL.MIN_GAIN` m 以上離れているなら、地下を通る。
 * 目指す先は、FTの隊員なら FT の目標(後退・潰走中は集結地点)、それ以外は命令の目的地。
 * だから AI の防御側は、拠点が押されれば後方へ地下で下がり、奪われた拠点への逆襲では
 * 地下から拠点の建物の中へ出てくる。人間・LLM が同じ建物を指せば同じように通る。
 *
 * 地下にいる間は盤上にいない扱い(`isOffField`)— 見えず、撃たれず、撃てず、拠点にも数えない。
 * `length / TUNNEL.SPEED` 秒で出口(建物の中)に出る。乱数は引かない(P3)。陣営で分岐しない(P2)。
 */

import { SIM_HZ, TUNNEL } from "../constants.ts";
import { buildingAt, insideBounds } from "../cqb.ts";
import { activateBuildingNav } from "../world.ts";
import type { Building, CompanyState, Soldier, Tunnel, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function centerOf(b: Building): Vec2 {
  return { x: (b.bounds.minX + b.bounds.maxX) / 2, z: (b.bounds.minZ + b.bounds.maxZ) / 2 };
}

/** 建物の中の出入口: いちばん広い部屋の中心 */
function entranceOf(b: Building): Vec2 {
  let best = b.rooms[0];
  let bestA = -1;
  for (const r of b.rooms) {
    const a = (r.bounds.maxX - r.bounds.minX) * (r.bounds.maxZ - r.bounds.minZ);
    if (a > bestA + 1e-9) {
      best = r;
      bestA = a;
    }
  }
  if (!best) return centerOf(b);
  return { x: (best.bounds.minX + best.bounds.maxX) / 2, z: (best.bounds.minZ + best.bounds.maxZ) / 2 };
}

/** 拠点の建物(拠点が建物の外なら、そばの建物) */
function objectiveBuilding(world: World, at: Vec2): Building | null {
  const inside = world.buildings.find((b) => insideBounds(b.bounds, at));
  if (inside) return inside;
  let best: Building | null = null;
  let bestD: number = TUNNEL.NEAR_BUILDING;
  for (const b of world.buildings) {
    const d = dist(centerOf(b), at);
    if (d < bestD - 1e-9) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * 混成型の防御側の中隊長が掘るトンネル(立案のとき、陣地のあとに呼ぶ)。
 *   1. 作戦で受け持つ拠点の建物ごとに、後方(自陣の側)の `REAR_MIN`〜`REAR_MAX` m の建物のうち最も近いものと結ぶ
 *   2. 拠点の建物どうしを、`LINK_MAX` m 以内なら近い順に結ぶ(主陣地から)
 * 本数は `MAX_PER_SIDE` まで。材料は地形と作戦だけ(敵情は見ない、P1)
 */
export function planTunnels(world: World, co: CompanyState): Tunnel[] {
  const out: Tunnel[] = [];
  if (!co.plan || world.template[co.side] !== "hybrid") return out;
  const fwdLen = Math.hypot(co.advanceDir.x, co.advanceDir.z) || 1;
  const fwd = { x: co.advanceDir.x / fwdLen, z: co.advanceDir.z / fwdLen };
  const objs: Building[] = [];
  for (const t of co.plan.tasks) {
    if (t.objectiveId === null) continue;
    const o = world.objectives.find((x) => x.id === t.objectiveId);
    const b = o ? objectiveBuilding(world, o.pos) : null;
    if (b && !objs.includes(b)) objs.push(b);
  }
  const add = (a: Building, b: Building): void => {
    if (out.length >= TUNNEL.MAX_PER_SIDE) return;
    if (out.some((t) => (t.a.buildingId === a.id && t.b.buildingId === b.id) || (t.a.buildingId === b.id && t.b.buildingId === a.id))) return;
    const pa = entranceOf(a);
    const pb = entranceOf(b);
    out.push({
      id: 0,
      side: co.side,
      a: { buildingId: a.id, pos: pa },
      b: { buildingId: b.id, pos: pb },
      length: dist(pa, pb),
    });
  };
  // 1. 後方の建物と
  for (const ob of objs) {
    const c = centerOf(ob);
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of world.buildings) {
      if (b.id === ob.id || objs.includes(b)) continue;
      const bc = centerOf(b);
      const back = -((bc.x - c.x) * fwd.x + (bc.z - c.z) * fwd.z);
      const d = dist(bc, c);
      if (back < TUNNEL.REAR_MIN || d > TUNNEL.REAR_MAX) continue;
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && b.id < best.id)) {
        best = b;
        bestD = d;
      }
    }
    if (best) add(ob, best);
  }
  // 2. 拠点の建物どうし
  for (let i = 0; i < objs.length; i++) {
    for (let j = i + 1; j < objs.length; j++) {
      if (dist(centerOf(objs[i]!), centerOf(objs[j]!)) <= TUNNEL.LINK_MAX) add(objs[i]!, objs[j]!);
    }
  }
  return out;
}

/** 立案のときに両軍ぶんを掘り直す(`setupDefense` から)。出入口の建物の屋内ナビを張る */
export function setupTunnels(world: World): void {
  world.tunnels = [];
  let id = 1;
  for (const co of world.companies) {
    for (const t of planTunnels(world, co)) {
      world.tunnels.push({ ...t, id: id++ });
      activateBuildingNav(world, t.a.buildingId);
      activateBuildingNav(world, t.b.buildingId);
    }
  }
}

/** その兵の目指す先。FTの隊員は FT の目標(後退・潰走中は集結地点)、それ以外は命令の目的地 */
function destinationOf(world: World, s: Soldier): Vec2 | null {
  if (s.fireteamId >= 0) {
    const ft = world.fireteams.find(
      (f) => f.side === s.side && f.squadId === s.squadId && f.ftIndex === s.fireteamId,
    );
    if (ft) return ft.mode === "FALLBACK" || ft.mode === "ROUT" ? ft.rallyPoint : ft.objective;
  }
  if (s.isSquadLeader) {
    return world.squads.find((q) => q.side === s.side && q.squadId === s.squadId)?.objective ?? null;
  }
  return s.order.target ?? null;
}

/** 目指す先の建物(建物の外なら、そばの建物) */
function destBuilding(world: World, p: Vec2): Building | null {
  return objectiveBuilding(world, p);
}

/**
 * 毎ティック: 地下を出る・入る。経路の要求のあと、移動の前に呼ぶ
 * (入った兵はこのティックから動かず、出た兵は次のティックから地上で動く)
 */
export function tunnelSystem(world: World): void {
  if (world.tunnels.length === 0) return;
  // ── 出る ──
  for (const s of world.soldiers) {
    if (!s.tunnel || world.tick < s.tunnel.arriveTick) continue;
    // 出口のまわりに少しずつずらして出る(重なると分離の処理で弾かれる)
    const a = ((s.ordinal % 8) / 8) * Math.PI * 2;
    s.pos = { x: s.tunnel.exit.x + Math.cos(a) * 0.8, z: s.tunnel.exit.z + Math.sin(a) * 0.8 };
    s.eye = { ...s.pos };
    s.path = [];
    s.pathIdx = 0;
    s.tunnel = null;
  }
  // ── 入る ──
  for (const s of world.soldiers) {
    if (s.tunnel || s.status !== "ok" || s.evac !== "none" || s.mountedIn != null) continue;
    if (s.bearing !== null || s.treating !== null) continue;
    const mine = world.tunnels.filter((t) => t.side === s.side);
    if (mine.length === 0) continue;
    const here = buildingAt(world.buildings, s.pos);
    if (!here) continue;
    const dest = destinationOf(world, s);
    if (!dest) continue;
    const there = destBuilding(world, dest);
    if (!there || there.id === here.id) continue;
    const t = mine.find(
      (x) =>
        (x.a.buildingId === here.id && x.b.buildingId === there.id) ||
        (x.b.buildingId === here.id && x.a.buildingId === there.id),
    );
    if (!t) continue;
    // 目指す先が目と鼻の先なら歩く(地下へ降りて出るより早い)
    if (dist(s.pos, dest) < TUNNEL.MIN_GAIN) continue;
    const exit = t.a.buildingId === here.id ? t.b.pos : t.a.pos;
    const entrance = t.a.buildingId === here.id ? t.a.pos : t.b.pos;
    s.pos = { ...entrance };
    s.eye = { ...entrance };
    s.path = [];
    s.pathIdx = 0;
    s.tunnel = { id: t.id, exit: { ...exit }, arriveTick: world.tick + Math.max(1, Math.round((t.length / TUNNEL.SPEED) * SIM_HZ)) };
  }
}
