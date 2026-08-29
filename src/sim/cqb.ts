/**
 * CQB(市街地戦・屋内戦闘、仕様 §7)の幾何計算。
 *
 * `cqb-minimal-prototype.jsx` で検証済みの3段階(スタック形成 → ブリーチ → 室内
 * クリアリング)を、任意の部屋・扉に対して一般化したもの。プロトタイプは
 * 1部屋+1扉の座標を直書きしていたので、その定数を扉の位置と法線から導く形に置き換えた。
 *
 * ドクトリン上の担当階層(仕様 §7.2): 建物単位の一連の流れ(孤立化→支援射撃→突撃→
 * 突入→掃討→再編成)は**分隊長が一貫して担当**し、小隊長は介在しない。突入と室内
 * 掃討の実行だけがFTリーダー以下の担当になる。
 */

import { CQB } from "./constants.ts";
import { collidesWall } from "./geometry.ts";
import type { AABB, Bounds, Building, Door, Room, Vec2 } from "./types.ts";

/** スタック時の隊員間隔 m。兵士分離の直径(SOLDIER_RADIUS×2 = 0.7m)より広く取る。 */
const STACK_SPACING = 0.9;

function perp(v: Vec2): Vec2 {
  return { x: -v.z, z: v.x };
}

function centerOf(b: Bounds): Vec2 {
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
}

export function insideBounds(b: Bounds, p: Vec2): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
}

/** この地点を含む建物。なければ null。 */
export function buildingAt(buildings: readonly Building[], p: Vec2): Building | null {
  return buildings.find((b) => insideBounds(b.bounds, p)) ?? null;
}

/** この地点を含む部屋。なければ null。 */
export function roomAt(buildings: readonly Building[], p: Vec2): Room | null {
  for (const b of buildings) {
    const r = b.rooms.find((rm) => insideBounds(rm.bounds, p));
    if (r) return r;
  }
  return null;
}

export function doorById(buildings: readonly Building[], id: number): Door | null {
  for (const b of buildings) {
    const d = b.doors.find((x) => x.id === id);
    if (d) return d;
  }
  return null;
}

export function roomOfDoor(buildings: readonly Building[], door: Door): Room | null {
  const b = buildings.find((x) => x.id === door.buildingId);
  return b?.rooms.find((r) => r.id === door.roomId) ?? null;
}

/**
 * スタック位置(仕様 §7.3 ①「指定扉から1.5m以内に集合、壁沿いに縦列で待機隊形」)。
 *
 * 扉の外側 STACK_DIST の地点を起点に、壁沿いへ縦列で並ぶ。突入順はこの並び順
 * そのもので、先頭2名が突入要員になる。
 */
export function stackPositions(door: Door, count: number): Vec2[] {
  const outward = { x: -door.normal.x, z: -door.normal.z };
  const along = perp(door.normal);
  const base = {
    x: door.pos.x + outward.x * CQB.STACK_DIST,
    z: door.pos.z + outward.z * CQB.STACK_DIST,
  };
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    // 扉の片側へ寄せて縦列を作る(扉の正面に立ちっぱなしにしない = 危険地帯を空ける)。
    // 間隔は兵士分離の直径(0.7m)より広く取る — 狭いと押し合って誰も所定位置に
    // 収まらず、スタック完了が永久に成立しない(実装して確認した)。
    const lateral = door.width / 2 + 0.5 + i * STACK_SPACING;
    out.push({ x: base.x + along.x * lateral, z: base.z + along.z * lateral });
  }
  return out;
}

export interface CornerAssignment {
  pos: Vec2;
  /** 進入直後に担当する索敵扇形の中心方向(仕様 §7.3: 各隊員90°) */
  facing: Vec2;
  label: string;
}

/**
 * 室内クリアリングの担当コーナー(仕様 §7.3 ③)。
 *
 * 進入方向を基準に「近方左 → 遠方右 → 近方右 → 遠方左」の順で割り当てる。
 * ボタンフック/クリスクロスで先頭2名が近傍コーナーを取り、後続が奥を取る形。
 *
 * 積み残し課題(仕様 §7.3 に明記): 到達順はスタック順に固定している。実際の
 * ドクトリンでは点者の判断で可変だが、その検証は別途。
 */
export function cornerAssignments(room: Room, door: Door): CornerAssignment[] {
  const into = door.normal;
  const right = perp(into);
  const c = CQB.CORNER_INSET;
  const b = room.bounds;
  const center = centerOf(b);

  const corners: Vec2[] = [
    { x: b.minX + c, z: b.minZ + c },
    { x: b.maxX - c, z: b.minZ + c },
    { x: b.minX + c, z: b.maxZ - c },
    { x: b.maxX - c, z: b.maxZ - c },
  ];

  // 扉から見た「奥行き」と「左右」に分解する
  const scored = corners.map((p) => {
    const dx = p.x - door.pos.x;
    const dz = p.z - door.pos.z;
    return { p, depth: dx * into.x + dz * into.z, lateral: dx * right.x + dz * right.z };
  });

  const nearLeft = pick(scored, (s) => -s.depth - s.lateral * 2);
  const farRight = pick(scored, (s) => s.depth + s.lateral * 2, [nearLeft]);
  const nearRight = pick(scored, (s) => -s.depth + s.lateral * 2, [nearLeft, farRight]);
  const farLeft = pick(scored, (s) => s.depth - s.lateral * 2, [nearLeft, farRight, nearRight]);

  const ordered = [nearLeft, farRight, nearRight, farLeft];
  const labels = ["近方左", "遠方右", "近方右", "遠方左"];
  return ordered.map((s, i) => {
    const dx = center.x - s.p.x;
    const dz = center.z - s.p.z;
    const d = Math.hypot(dx, dz) || 1;
    return { pos: { ...s.p }, facing: { x: dx / d, z: dz / d }, label: labels[i]! };
  });
}

type Scored = { p: Vec2; depth: number; lateral: number };

function pick(items: Scored[], score: (s: Scored) => number, exclude: Scored[] = []): Scored {
  let best = items[0]!;
  let bestScore = -Infinity;
  for (const s of items) {
    if (exclude.includes(s)) continue;
    const v = score(s);
    if (v > bestScore) {
      bestScore = v;
      best = s;
    }
  }
  return best;
}

/**
 * 分隊がいま突入すべき扉。目標地点または把握している脅威が建物の中にあり、
 * かつ扉が十分近い場合にだけ返す(仕様 §7.2 の「孤立化→支援射撃→突撃」の入口)。
 */
export function selectAssaultDoor(
  buildings: readonly Building[],
  from: Vec2,
  aim: Vec2,
): Door | null {
  const target = buildingAt(buildings, aim);
  if (!target) return null;

  let best: Door | null = null;
  let bestD = Infinity;
  for (const d of target.doors) {
    const dist = Math.hypot(d.pos.x - from.x, d.pos.z - from.z);
    if (dist > CQB.ASSAULT_TRIGGER_DIST) continue;
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/**
 * 建物1棟を矩形1部屋+扉1つで組み立てる補助。壁は扉の開口部を空けて生成する。
 * `doorSide` は扉を開ける面。
 */
export function makeSimpleBuilding(
  id: number,
  bounds: Bounds,
  doorSide: "north" | "south" | "east" | "west",
  opts?: { wallThickness?: number; doorWidth?: number },
): { building: Building; walls: AABB[] } {
  const t = opts?.wallThickness ?? 0.25;
  const dw = opts?.doorWidth ?? 1.2;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const hw = (bounds.maxX - bounds.minX) / 2;
  const hd = (bounds.maxZ - bounds.minZ) / 2;

  const walls: AABB[] = [];
  /** 面を、開口部を挟んだ2枚の壁として作る */
  const face = (
    side: "north" | "south" | "east" | "west",
  ): { pos: Vec2; normal: Vec2 } | null => {
    const horizontal = side === "north" || side === "south";
    const sign = side === "north" || side === "east" ? 1 : -1;
    const openHere = doorSide === side;
    if (horizontal) {
      const z = cz + sign * hd;
      if (!openHere) {
        walls.push({ cx, cz: z, hw, hd: t });
        return null;
      }
      const seg = (hw * 2 - dw) / 4;
      walls.push({ cx: cx - dw / 2 - seg, cz: z, hw: seg, hd: t });
      walls.push({ cx: cx + dw / 2 + seg, cz: z, hw: seg, hd: t });
      return { pos: { x: cx, z }, normal: { x: 0, z: -sign } };
    }
    const x = cx + sign * hw;
    if (!openHere) {
      walls.push({ cx: x, cz, hw: t, hd });
      return null;
    }
    const seg = (hd * 2 - dw) / 4;
    walls.push({ cx: x, cz: cz - dw / 2 - seg, hw: t, hd: seg });
    walls.push({ cx: x, cz: cz + dw / 2 + seg, hw: t, hd: seg });
    return { pos: { x, z: cz }, normal: { x: -sign, z: 0 } };
  };

  let opening: { pos: Vec2; normal: Vec2 } | null = null;
  for (const side of ["north", "south", "east", "west"] as const) {
    const o = face(side);
    if (o) opening = o;
  }
  if (!opening) throw new Error("makeSimpleBuilding: 扉の面が作られなかった");

  const inset = t + 0.05;
  const room: Room = {
    id: id * 10,
    buildingId: id,
    bounds: {
      minX: bounds.minX + inset,
      maxX: bounds.maxX - inset,
      minZ: bounds.minZ + inset,
      maxZ: bounds.maxZ - inset,
    },
  };
  const door: Door = {
    id: id * 10,
    buildingId: id,
    roomId: room.id,
    pos: opening.pos,
    normal: opening.normal,
    width: dw,
    open: false,
  };

  return { building: { id, bounds, rooms: [room], doors: [door] }, walls };
}

/** 地点が壁に食い込んでいれば、部屋の中心側へ寄せて通行可能にする。 */
export function nudgeInside(walls: readonly AABB[], p: Vec2, room: Room): Vec2 {
  if (!collidesWall(walls, p.x, p.z, 0.35)) return p;
  const c = centerOf(room.bounds);
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    const q = { x: p.x + (c.x - p.x) * t, z: p.z + (c.z - p.z) * t };
    if (!collidesWall(walls, q.x, q.z, 0.35)) return q;
  }
  return c;
}
