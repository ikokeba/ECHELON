/**
 * 市街地の生成部品(`[v6.11]` 仕様 §7/§10)。
 *
 * `scenario.ts` の `symmetricCity` は「同じ大きさの建物を等間隔の格子に並べる」もので、
 * 盤面としては機能するが**実在の市街地には見えない**。実際の中東の旧市街・住宅区は、
 * 衛星写真で見ると次の特徴を持つ:
 *
 *   - 街区の大きさがばらついている(同じ矩形が並ぶことはない)
 *   - 十字路が少なく、**食い違いのT字路**が多い(通りが一直線に抜けない)
 *   - 街区の内側へ**袋小路**が刺さっている
 *   - モスクや廟は**塀で囲われた敷地**を持ち、その中に空地がある
 *   - ところどころに空地・中庭・小さな広場がある
 *
 * ここはその5つを作る道具だけを持つ。**地形だけ**を返し、部隊の配置は `scenario.ts`
 * の責務のままにしてある(盤面と部隊は別物、という `[v6.9]` の切り分けを守る)。
 *
 * 壁は軸並行の矩形(`AABB`)しか持てないので、斜めの通りは**階段状の食い違い**で
 * 近似する。真上から見るぶんには、等間隔の格子よりはるかに実物に近い形になる。
 *
 * **決定性**: `Math.random` は使えない(仕様 §2/§13 と決定論テスト)。ばらつきは
 * すべて座標から決まる整数ハッシュから引く。同じ盤面は何度作っても同一になる。
 */

import { makeCorridorBuilding, makeSimpleBuilding, type DoorSide } from "./cqb.ts";
import type { AABB, Bounds, Building, Vec2 } from "./types.ts";

/**
 * 座標から決まる 0..1 の擬似乱数。`Math.random` の代わり。
 * mulberry32 と同じ混ぜ方を1回だけ回した形で、入力が1違えば出力は無関係になる。
 */
export function hash01(a: number, b: number, salt = 0): number {
  let h = (Math.round(a * 8) | 0) * 374761393 + (Math.round(b * 8) | 0) * 668265263 + salt * 1442695041;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** `lo`〜`hi` の値をハッシュから引く。 */
export function hashRange(a: number, b: number, salt: number, lo: number, hi: number): number {
  return lo + hash01(a, b, salt) * (hi - lo);
}

/** 建物の集合と、それが持ち込む壁。 */
export interface Structures {
  buildings: Building[];
  walls: AABB[];
  windowPlugs: AABB[];
}

export function emptyStructures(): Structures {
  return { buildings: [], walls: [], windowPlugs: [] };
}


/**
 * 扉を向ける面。**点対称((x,z)→(-x,-z))で面も反転する**規則にしてある。
 * これにより、ある建物とその点対称の双子は互いに厳密な鏡像の壁集合になる(仕様 §2/§13)。
 */
export function doorTowardCentre(b: Bounds): DoorSide {
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  // 長辺の側に扉を開ける。細長い建物の短辺に扉を付けると廊下が作れない
  if (b.maxX - b.minX >= b.maxZ - b.minZ) return cz < 0 ? "north" : "south";
  return cx < 0 ? "east" : "west";
}

/** 矩形1つを建物にして `out` へ積む。小さすぎるものは単室になる(`makeSimpleBuilding`)。 */
export function addBuilding(out: Structures, id: number, rect: Bounds, door?: DoorSide): void {
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  const side = door ?? doorTowardCentre(rect);
  const b =
    Math.min(w, d) >= 9 && Math.max(w, d) >= 14
      ? makeCorridorBuilding(id, rect, side)
      : makeSimpleBuilding(id, rect, side);
  out.buildings.push(b.building);
  out.walls.push(...b.walls);
  out.windowPlugs.push(...b.windowPlugs);
}

/**
 * 街区1つを、大きさのばらついた棟へ細分する。
 *
 * 実物の街区は「1棟が街区を丸ごと占める」ことも「同じ家が等間隔に並ぶ」こともなく、
 * **不揃いな棟が路地を挟んで詰まっている**。長辺方向に不均等な切れ目を入れ、
 * 一部の切れ目を路地として空ける。
 *
 * @param alley 路地の幅 m。0 にすると棟が接して1つの塊に見える
 * @param maxRun 1棟の長辺の上限 m。これを超える街区は必ず割る
 */
export function subdivideBlock(
  rect: Bounds,
  salt: number,
  opts?: { alley?: number; maxRun?: number; minRun?: number },
): Bounds[] {
  const alley = opts?.alley ?? 3;
  const maxRun = opts?.maxRun ?? 26;
  const minRun = opts?.minRun ?? 11;
  const horizontal = rect.maxX - rect.minX >= rect.maxZ - rect.minZ;
  const span = horizontal ? rect.maxX - rect.minX : rect.maxZ - rect.minZ;
  if (span <= maxRun) return [rect];

  // 不揃いな幅で切る。切れ目のたびに路地を1本抜く
  const out: Bounds[] = [];
  let at = horizontal ? rect.minX : rect.minZ;
  const end = horizontal ? rect.maxX : rect.maxZ;
  let k = 0;
  while (end - at > minRun) {
    const remain = end - at;
    // 残りが2棟に足りないなら残り全部を1棟にする(切れ端を作らない)
    const run =
      remain <= maxRun + minRun + alley
        ? remain
        : hashRange(rect.minX, rect.minZ, salt + k, minRun, maxRun);
    const to = Math.min(end, at + run);
    out.push(
      horizontal
        ? { minX: at, maxX: to, minZ: rect.minZ, maxZ: rect.maxZ }
        : { minX: rect.minX, maxX: rect.maxX, minZ: at, maxZ: to },
    );
    at = to + alley;
    k++;
  }
  return out;
}

/**
 * 袋小路。街区の縁から内側へ切り込む短い路地で、突き当りは行き止まり。
 *
 * 実装は「切り込みの左右に塀を立てる」だけ。通り抜けられないのは、切り込みの奥に
 * 街区の建物が控えているから。**通路そのものは作らない** — 建物と建物の隙間が
 * そのまま路地になる、という実際の街の成り立ちに合わせる。
 */
export function culDeSac(
  from: Vec2,
  dir: Vec2,
  length: number,
  halfWidth: number,
  thickness = 0.4,
): AABB[] {
  const right = { x: -dir.z, z: dir.x };
  const midX = from.x + (dir.x * length) / 2;
  const midZ = from.z + (dir.z * length) / 2;
  const along = Math.abs(dir.x) > Math.abs(dir.z);
  const side = (sign: number): AABB => ({
    cx: midX + right.x * halfWidth * sign,
    cz: midZ + right.z * halfWidth * sign,
    hw: along ? length / 2 : thickness,
    hd: along ? thickness : length / 2,
  });
  return [side(1), side(-1)];
}

/**
 * 塀で囲われた敷地(モスク・廟・学校)。中は空地なので、そのまま屋外の拠点になる。
 *
 * 屋外の拠点は室内の拠点より確保が成立しやすい(`[v6.10]` F-9: 室内拠点は最良22%)。
 * 敷地の塀が射線を切るので、開豁地の真ん中に拠点を置くのとも違う戦いになる。
 *
 * @param gate 門を開ける面。ここだけ塀が途切れる
 */
export function walledCompound(
  rect: Bounds,
  gate: DoorSide,
  opts?: { thickness?: number; gateWidth?: number },
): AABB[] {
  const t = opts?.thickness ?? 0.5;
  const gw = opts?.gateWidth ?? 4;
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const hw = (rect.maxX - rect.minX) / 2;
  const hd = (rect.maxZ - rect.minZ) / 2;
  const out: AABB[] = [];
  const face = (side: DoorSide): void => {
    const horizontal = side === "north" || side === "south";
    const sign = side === "north" || side === "east" ? 1 : -1;
    if (side !== gate) {
      out.push(
        horizontal ? { cx, cz: cz + sign * hd, hw, hd: t } : { cx: cx + sign * hw, cz, hw: t, hd },
      );
      return;
    }
    // 門の面は開口を挟んだ2枚
    const seg = (horizontal ? hw * 2 - gw : hd * 2 - gw) / 4;
    if (seg <= 0) return;
    if (horizontal) {
      const z = cz + sign * hd;
      out.push({ cx: cx - gw / 2 - seg, cz: z, hw: seg, hd: t });
      out.push({ cx: cx + gw / 2 + seg, cz: z, hw: seg, hd: t });
    } else {
      const x = cx + sign * hw;
      out.push({ cx: x, cz: cz - gw / 2 - seg, hw: t, hd: seg });
      out.push({ cx: x, cz: cz + gw / 2 + seg, hw: t, hd: seg });
    }
  };
  for (const s of ["north", "south", "east", "west"] as const) face(s);
  return out;
}


/** 壁の一覧を原点まわりの点対称へ複製する(仕様 §2/§13)。 */
export function mirrorAll(walls: readonly AABB[]): AABB[] {
  const out: AABB[] = [];
  for (const w of walls) {
    out.push({ ...w });
    out.push({ cx: -w.cx, cz: -w.cz, hw: w.hw, hd: w.hd });
  }
  return out;
}

/** 矩形を原点まわりに点対称へ写す。 */
export function mirrorRect(b: Bounds): Bounds {
  return { minX: -b.maxX, maxX: -b.minX, minZ: -b.maxZ, maxZ: -b.minZ };
}

/** 矩形の中心。 */
export function centreOf(b: Bounds): Vec2 {
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
}

