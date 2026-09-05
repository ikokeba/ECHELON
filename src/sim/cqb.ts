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
  /** すでに掃討済みの扉。次の部屋へ進むため候補から外す。`[v6.2]` */
  exclude: readonly number[] = [],
  /**
   * 分隊の各隊員の位置。`[v6.4]`
   *
   * 「屋内にいるか」の判定を**重心ひとつ**で行っていたのが、部屋を残したまま
   * 建物を離れる原因だった。突入FTが室内にいても、支援FTが扉の外で射撃位置に
   * ついていれば重心は建物の外に落ちる。すると内扉が候補から消え、外扉は掃討済み
   * なので候補が無くなり、分隊は**廊下だけ掃討して立ち去る**(実測: 進入した建物の
   * 8割が扉1/3のまま放棄。4回目のテストプレイ指摘「全部屋探索せず終わっています」)。
   * ATP 3-06.11 では建物は全室を掃討して初めて cleared なので、
   * **1名でも中にいれば屋内**として扱い、次の部屋へ進ませる。
   */
  occupants: readonly Vec2[] = [],
): Door | null {
  const target = buildingAt(buildings, aim);
  if (!target) return null;

  // `[v6.2]` 中廊下+区画の建物では、外にいる分隊は**外扉からしか入れない**。
  // 内扉は建物内部にあり、そこへのスタック位置は壁の向こう側になってしまう。
  // 建物に入ってから初めて内扉が候補になり、部屋を1つずつ潰す動きになる(仕様 §7.2)。
  const inside =
    insideBounds(target.bounds, from) ||
    occupants.some((p) => insideBounds(target.bounds, p));

  // 扉までの距離は「分隊の重心」と「各隊員」のうち最も近いもので測る。重心だけで
  // 測ると、室内にいる突入FTのすぐ隣の内扉が発動距離の外に出てしまうことがある。
  const nearestTo = (p: Vec2): number => {
    let d = Math.hypot(p.x - from.x, p.z - from.z);
    for (const o of occupants) d = Math.min(d, Math.hypot(p.x - o.x, p.z - o.z));
    return d;
  };

  // `[v6.9]` **順序は目標に近い扉から。** 従来は分隊に近い扉から潰していたので、
  // 拠点がこの建物の一室にあっても、ドリルは手前の部屋から順に片付けるだけで
  // 拠点の部屋へ収束しなかった(F-9: 建物の12m以内には154秒いるのに、判定円の中は5秒)。
  // ATP 3-06.11 の掃討は全室が対象であることに変わりはなく、**どの順に潰すか**だけを
  // 目標側から決める。発動距離の判定は従来どおり分隊からの距離で行う
  // (遠すぎる扉へスタックを組ませないため)。
  let best: Door | null = null;
  let bestKey = Infinity;
  for (const d of target.doors) {
    if (exclude.includes(d.id)) continue;
    if (!inside && !d.exterior) continue;
    if (nearestTo(d.pos) > CQB.ASSAULT_TRIGGER_DIST) continue;
    const key = Math.hypot(d.pos.x - aim.x, d.pos.z - aim.z);
    if (key < bestKey) {
      bestKey = key;
      best = d;
    }
  }
  return best;
}

export type DoorSide = "north" | "south" | "east" | "west";

/** 矩形領域を壁AABBへ。 */
function aabbOf(b: Bounds): AABB {
  return {
    cx: (b.minX + b.maxX) / 2,
    cz: (b.minZ + b.maxZ) / 2,
    hw: (b.maxX - b.minX) / 2,
    hd: (b.maxZ - b.minZ) / 2,
  };
}

/**
 * 建物の外周4面を作る。`doorSide` の面だけ開口部を空け、その中心と法線(室内向き)を返す。
 * `makeSimpleBuilding` と `makeCorridorBuilding` の共通部分。
 */
/** 窓の開口の半幅 m。人ひとりが銃を出せるだけの幅(`[v6.10]`) */
const WINDOW_HALF_W = 0.55;
/** 窓を入れる壁断片の最小の長さ m。これ未満は扉脇の袖壁とみなして入れない */
const WINDOW_MIN_SPAN = 4;
/**
 * 窓どうしのおおよその間隔 m。**盤面の見通しを決める数字なので、下げるときは
 * 拠点の確保が成立するかを必ず測り直すこと。**
 *
 * 5m(1棟あたり10.4個)にしたら拠点の確保が完全に止まった — 建物が視線を切らなく
 * なり、判定円へ寄る部隊がどこからでも撃たれて円の中に留まれない
 * (確保保持 178→0秒、最良進捗 100→74%)。窓の配置AIを切っても再現したので、
 * 原因は挙動ではなく**壁に空けた穴の量**そのもの。10m(6.2個)に戻して回復した
 * (確保保持 142/0/125秒)。仕様 §10 の「市街地の見通し距離が交戦距離を制限する」は
 * 壁が壁として働いていて初めて成り立つ。
 */
const WINDOW_SPACING = 15;
/** 角から窓までの最小距離 m。角に窓があると射界が壁に潰される */
const WINDOW_EDGE_MARGIN = 1.6;

function outerShell(
  bounds: Bounds,
  /**
   * 扉を開ける面。**複数指定できる**(`[v6.14]`)。
   *
   * 入口が1つしかないと、両軍が同じ扉を使うことになり**屋内で出会えない** —
   * 実測で、両軍が同じ建物の中にいた時間は5枚の盤面すべてで **0秒**、
   * 同一建物内での発砲は 0% だった。CQBの機構は動いていたが、掃討しているのは
   * 空の部屋ばかりだった。対面する2つの扉を開ければ、青は南から赤は北から入り、
   * 中で当たる。
   *
   * **対になる面で指定すること**(北+南、東+西)。点対称のもとで集合が保たれるので、
   * 鏡像の建物は鏡像の扉配置になる(仕様 §2/§13)。
   */
  doorSides: readonly DoorSide[],
  t: number,
  dw: number,
): {
  /** 視線用の壁。窓の開口が空いている */
  walls: AABB[];
  /**
   * 窓の開口を塞ぐ栓(`[v6.10]`)。経路探索用の壁は
   * **「視線用の壁 + これ」** として導出する。
   *
   * 2本のリストを別々に組み立てる形にしていたら、街路の塀を片方へ積み忘れて
   * 経路探索が塀を素通りできると誤認し、担架班が900秒で5mしか進まなくなった。
   * 差分だけを返せば、どこにどれだけ壁を足しても取りこぼしようがない。
   */
  windowPlugs: AABB[];
  openings: Array<{ pos: Vec2; normal: Vec2 }>;
  windows: Array<{ pos: Vec2; normal: Vec2 }>;
} {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const hw = (bounds.maxX - bounds.minX) / 2;
  const hd = (bounds.maxZ - bounds.minZ) / 2;

  const walls: AABB[] = [];
  /** 面を、開口部を挟んだ2枚の壁として作る */
  const face = (side: DoorSide): { pos: Vec2; normal: Vec2 } | null => {
    const horizontal = side === "north" || side === "south";
    const sign = side === "north" || side === "east" ? 1 : -1;
    const openHere = doorSides.includes(side);
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

  const openings: Array<{ pos: Vec2; normal: Vec2 }> = [];
  for (const side of ["north", "south", "east", "west"] as const) {
    const o = face(side);
    if (o) openings.push(o);
  }
  if (openings.length === 0) throw new Error("outerShell: 扉の面が作られなかった");

  // ── 窓(`[v6.10]` 仕様 §7)──
  //
  // 窓は**視線だけを通し、移動は通さない**開口。扉との違いはそこだけで、
  // 実装も扉と同じ「壁に穴を空ける」形になる。ただし穴を空けるのは
  // **視線用の壁**(`walls`)だけで、経路探索用の壁(`navWalls`)は塞いだままにする。
  // 窓から出入りできてしまうと、突入ドリル(仕様 §7.2)が意味を失う。
  const windowPlugs: AABB[] = [];
  const windows: Array<{ pos: Vec2; normal: Vec2 }> = [];
  const punched: AABB[] = [];
  for (const w of walls) {
    const horizontal = w.hw > w.hd;
    const span = horizontal ? w.hw * 2 : w.hd * 2;
    // 短すぎる断片には窓を入れない(扉の脇の細い壁など)
    if (span < WINDOW_MIN_SPAN) {
      punched.push(w);
      continue;
    }
    // 間隔から本数を決め、断片の中で均等に配る。両端は角から離す
    const usable = span - WINDOW_EDGE_MARGIN * 2;
    const n = Math.max(1, Math.floor(usable / WINDOW_SPACING));
    const centre = horizontal ? w.cx : w.cz;
    const outward = { x: 0, z: 0 };
    // 面の外向き法線。建物の中心から見てどちら側の壁かで決まる
    if (horizontal) outward.z = w.cz > cz ? 1 : -1;
    else outward.x = w.cx > cx ? 1 : -1;

    const cuts: number[] = [];
    for (let i = 0; i < n; i++) {
      const t01 = n === 1 ? 0.5 : i / (n - 1);
      cuts.push(centre - usable / 2 + usable * t01);
    }
    // 断片を、窓の開口で分割していく
    let from = centre - span / 2;
    for (const c of cuts) {
      const a0 = c - WINDOW_HALF_W;
      const a1 = c + WINDOW_HALF_W;
      if (a0 > from) {
        const mid = (from + a0) / 2;
        const half = (a0 - from) / 2;
        punched.push(
          horizontal
            ? { cx: mid, cz: w.cz, hw: half, hd: w.hd }
            : { cx: w.cx, cz: mid, hw: w.hw, hd: half },
        );
      }
      from = a1;
      windows.push({
        pos: horizontal ? { x: c, z: w.cz } : { x: w.cx, z: c },
        normal: { ...outward },
      });
      // 開口をちょうど埋める栓。経路探索用の壁はこれを足して作る
      windowPlugs.push(
        horizontal
          ? { cx: c, cz: w.cz, hw: WINDOW_HALF_W, hd: w.hd }
          : { cx: w.cx, cz: c, hw: w.hw, hd: WINDOW_HALF_W },
      );
    }
    const end = centre + span / 2;
    if (end > from) {
      const mid = (from + end) / 2;
      const half = (end - from) / 2;
      punched.push(
        horizontal
          ? { cx: mid, cz: w.cz, hw: half, hd: w.hd }
          : { cx: w.cx, cz: mid, hw: w.hw, hd: half },
      );
    }
  }

  return { walls: punched, windowPlugs, openings, windows };
}

/**
 * 建物1棟を矩形1部屋+扉1つで組み立てる補助。壁は扉の開口部を空けて生成する。
 * `doorSide` は扉を開ける面。
 */
export function makeSimpleBuilding(
  id: number,
  bounds: Bounds,
  doorSide: DoorSide | readonly DoorSide[],
  opts?: { wallThickness?: number; doorWidth?: number },
): { building: Building; walls: AABB[]; windowPlugs: AABB[] } {
  const t = opts?.wallThickness ?? 0.25;
  const dw = opts?.doorWidth ?? 1.2;
  const sides = typeof doorSide === "string" ? [doorSide] : doorSide;
  const { walls, windowPlugs, openings, windows } = outerShell(bounds, sides, t, dw);

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
  // 開口ごとに扉を作る(`[v6.14]`)。単室なので行き先はすべて同じ部屋
  const doors: Door[] = openings.map((o, i) => ({
    id: id * 10 + i,
    buildingId: id,
    roomId: room.id,
    pos: o.pos,
    normal: o.normal,
    width: dw,
    open: false,
    exterior: true,
  }));

  return { building: { id, bounds, rooms: [room], doors, windows }, walls, windowPlugs };
}

/** 中廊下の幅 m。扉から1.5mのスタック位置が廊下に収まる幅を確保する。`[v6.2]` */
const CORRIDOR_WIDTH = 3.2;
/** 区画1つの目標幅 m。内寸をこれで割って区画数を決める。`[v6.2]` */
const BAY_TARGET_WIDTH = 11;
/** 区画を前後2室に割るのに要する奥行 m。これ未満なら1室のまま。`[v6.2]` */
const BAY_SPLIT_DEPTH = 13;

/**
 * 建物1棟を**中廊下+区画**で組み立てる(`[v6.2]` 初回テストプレイ指摘「建物の中は
 * 迷路や塹壕のような形状に」)。仕様 §7 の屋内戦闘を1棟のなかで反復させるのが狙い。
 *
 * 間取り:
 * ```
 *   ┌─────┬─────┬─────┐
 *   │ 奥1 │ 奥2 │ 奥3 │  ← 奥行があれば前後2室に割る(内扉は左右にずらす)
 *   ├──╴──┼──╴──┼──╴──┤
 *   │ 前1 │ 前2 │ 前3 │
 *   ├──╴──┴──╴──┴──╴──┤  ← 各区画は廊下へ内扉1つ
 *   │      中廊下      │
 *   └──────╴──────────┘
 *          ↑ 外扉(doorSide の面)
 * ```
 * 外扉から入ると廊下、そこから区画ごとに扉。分隊は
 * スタック→ブリーチ→掃討→再編成(仕様 §7.3)を部屋の数だけ繰り返すことになる。
 *
 * **点対称性**: 区画幅は割り切って一様にし、前後扉の横ずれも中心について反対称
 * (`k - (n-1)/2` に比例)にしてある。したがって原点対称に置いた双子の建物は、
 * この関数の出力どうしが厳密な鏡像になる(仕様 §2/§13)。
 */
export function makeCorridorBuilding(
  id: number,
  bounds: Bounds,
  doorSide: DoorSide | readonly DoorSide[],
  opts?: { wallThickness?: number; doorWidth?: number },
): { building: Building; walls: AABB[]; windowPlugs: AABB[] } {
  const t = opts?.wallThickness ?? 0.25;
  const dw = opts?.doorWidth ?? 1.2;
  const sides = typeof doorSide === "string" ? [doorSide] : doorSide;
  // 最初の面が**正面**。中廊下はこの面に沿って走り、間取りの向きを決める。
  // 残りの面の扉は、間取りができたあとで「その開口の内側にある部屋」へ付ける
  const primary = sides[0]!;
  const { walls, windowPlugs, openings, windows } = outerShell(bounds, sides, t, dw);
  const opening = openings[0]!;

  const inner: Bounds = {
    minX: bounds.minX + t,
    maxX: bounds.maxX - t,
    minZ: bounds.minZ + t,
    maxZ: bounds.maxZ - t,
  };

  // ── 局所座標: `a` = 扉面に沿う方向、`d` = 扉面から室内へ入る奥行き ──
  const horizontal = primary === "north" || primary === "south";
  const posSide = primary === "north" || primary === "east";
  const aMin = horizontal ? inner.minX : inner.minZ;
  const aMax = horizontal ? inner.maxX : inner.maxZ;
  const face = horizontal
    ? posSide
      ? inner.maxZ
      : inner.minZ
    : posSide
      ? inner.maxX
      : inner.minX;
  const inward = posSide ? -1 : 1;
  const depth = horizontal ? inner.maxZ - inner.minZ : inner.maxX - inner.minX;

  /** 局所矩形 → 世界座標の Bounds */
  const rect = (a0: number, a1: number, d0: number, d1: number): Bounds => {
    const p0 = face + inward * d0;
    const p1 = face + inward * d1;
    const pMin = Math.min(p0, p1);
    const pMax = Math.max(p0, p1);
    return horizontal
      ? { minX: a0, maxX: a1, minZ: pMin, maxZ: pMax }
      : { minX: pMin, maxX: pMax, minZ: a0, maxZ: a1 };
  };
  const point = (a: number, d: number): Vec2 =>
    horizontal ? { x: a, z: face + inward * d } : { x: face + inward * d, z: a };
  /** 奥へ進む向きの単位ベクトル(内扉の法線に使う) */
  const deeper: Vec2 = horizontal ? { x: 0, z: inward } : { x: inward, z: 0 };

  const corridorD = Math.min(CORRIDOR_WIDTH, depth * 0.45);
  const bayD0 = corridorD + t;
  // 区画が取れないほど浅い建物は単室でよい(その場合 makeSimpleBuilding と同じ形になる)
  if (depth - bayD0 < 4 || aMax - aMin < 6) {
    return makeSimpleBuilding(id, bounds, sides, opts);
  }

  const rooms: Room[] = [];
  const doors: Door[] = [];
  let nextRoom = id * 100;
  let nextDoor = id * 100;

  // ── 中廊下(部屋0。外扉はここへ通じる) ──
  const corridor: Room = {
    id: nextRoom++,
    buildingId: id,
    bounds: rect(aMin + 0.05, aMax - 0.05, 0.05, corridorD - 0.05),
  };
  rooms.push(corridor);
  doors.push({
    id: nextDoor++,
    buildingId: id,
    roomId: corridor.id,
    pos: opening.pos,
    normal: opening.normal,
    width: dw,
    open: false,
    exterior: true,
  });

  // ── 区画割り。幅は割り切って一様にする(点対称を保つため) ──
  const n = Math.max(2, Math.min(4, Math.round((aMax - aMin) / BAY_TARGET_WIDTH)));
  const bayW = (aMax - aMin) / n;
  const split = depth - bayD0 >= BAY_SPLIT_DEPTH;
  const mid = (bayD0 + depth) / 2;

  /** 開口部を避けながら、局所直線 `d=const` 上に壁を敷く */
  const wallAlong = (d: number, a0: number, a1: number, openings: number[]): void => {
    const cuts = [...openings].sort((p, q) => p - q);
    let cursor = a0;
    for (const c of cuts) {
      const s = c - dw / 2;
      if (s > cursor) walls.push(aabbOf(rect(cursor, s, d - t, d + t)));
      cursor = c + dw / 2;
    }
    if (a1 > cursor) walls.push(aabbOf(rect(cursor, a1, d - t, d + t)));
  };

  const corridorDoorAt: number[] = [];
  for (let k = 0; k < n; k++) {
    const a0 = aMin + k * bayW;
    const a1 = a0 + bayW;
    const aMidK = (a0 + a1) / 2;
    corridorDoorAt.push(aMidK);

    // 区画どうしを仕切る縦壁(最初の区画の左端は外壁なので張らない)
    if (k > 0) walls.push(aabbOf(rect(a0 - t, a0 + t, corridorD, depth)));

    if (!split) {
      const room: Room = {
        id: nextRoom++,
        buildingId: id,
        bounds: rect(a0 + t + 0.05, a1 - t - 0.05, bayD0 + 0.05, depth - 0.05),
      };
      rooms.push(room);
      doors.push({
        id: nextDoor++,
        buildingId: id,
        roomId: room.id,
        pos: point(aMidK, corridorD),
        normal: { ...deeper },
        width: dw,
        open: false,
        exterior: false,
      });
      continue;
    }

    // 前室 → 奥室。内扉は中心について反対称に横へずらし、部屋を横切らせる(迷路感)
    const front: Room = {
      id: nextRoom++,
      buildingId: id,
      bounds: rect(a0 + t + 0.05, a1 - t - 0.05, bayD0 + 0.05, mid - t - 0.05),
    };
    const back: Room = {
      id: nextRoom++,
      buildingId: id,
      bounds: rect(a0 + t + 0.05, a1 - t - 0.05, mid + t + 0.05, depth - 0.05),
    };
    rooms.push(front, back);
    doors.push({
      id: nextDoor++,
      buildingId: id,
      roomId: front.id,
      pos: point(aMidK, corridorD),
      normal: { ...deeper },
      width: dw,
      open: false,
      exterior: false,
    });
    const offset = (k - (n - 1) / 2) * bayW * 0.28;
    doors.push({
      id: nextDoor++,
      buildingId: id,
      roomId: back.id,
      pos: point(aMidK + offset, mid),
      normal: { ...deeper },
      width: dw,
      open: false,
      exterior: false,
    });
    // 前室と奥室を仕切る横壁(この区画の幅ぶんだけ)
    wallAlong(mid, a0, a1, [aMidK + offset]);
  }

  // 廊下と区画列を仕切る横壁。区画ごとの扉ぶんを開けておく
  wallAlong(corridorD, aMin, aMax, corridorDoorAt);

  // ── 正面以外の外扉(`[v6.14]`)──
  //
  // 間取りができてから、開口の**内側にある部屋**へ扉を付ける。裏口は中廊下ではなく
  // 奥の区画へ通じるので、青が正面から赤が裏から入れば**中で当たる**。
  // 入口が1つだと両軍が同じ扉を使うことになり、屋内で出会えなかった
  // (実測: 両軍が同じ建物にいた時間は5枚とも0秒、同一建物内の発砲0%)。
  for (const o of openings.slice(1)) {
    const inside = { x: o.pos.x + o.normal.x * 0.8, z: o.pos.z + o.normal.z * 0.8 };
    // **「内側の点を含む部屋」では駄目。** 開口の真裏は部屋の境界すれすれなので、
    // 丸めの向きひとつで入ったり入らなかったりする — 実際、24×12 の建物とその
    // 点対称の双子で外扉の数が 1 と 2 に割れた(仕様 §2/§13 が崩れる)。
    // 矩形までの距離で最も近い部屋を採れば、境界上でも必ず同じ答えになる。
    let room: Room | null = null;
    let bestD = Infinity;
    for (const r of rooms) {
      const dx = Math.max(r.bounds.minX - inside.x, 0, inside.x - r.bounds.maxX);
      const dz = Math.max(r.bounds.minZ - inside.z, 0, inside.z - r.bounds.maxZ);
      const d = Math.hypot(dx, dz);
      if (d < bestD - 1e-9) {
        bestD = d;
        room = r;
      }
    }
    // 1m以上離れているなら、その面の内側には部屋が無い(廊下の端など)
    if (!room || bestD > 1) continue;
    doors.push({
      id: nextDoor++,
      buildingId: id,
      roomId: room.id,
      pos: o.pos,
      normal: o.normal,
      width: dw,
      open: false,
      exterior: true,
    });
  }

  return { building: { id, bounds, rooms, doors, windows }, walls, windowPlugs };
}

/**
 * 建物の**最奥の部屋**の中心。外扉から最も遠い部屋を返す。`[v6.2]`
 *
 * 拠点(仕様 §12)を建物内の1室に置くときの座標に使う。最奥にすることで、確保するには
 * 廊下 → 前室 → 奥室と順に潰していく必要が生まれる(仕様 §7.2 の反復)。
 */
export function deepestRoomCenter(building: Building): Vec2 {
  const entry = building.doors.find((d) => d.exterior) ?? building.doors[0];
  const centers = building.rooms.map((r) => centerOf(r.bounds));
  if (!entry) return centers[0] ?? centerOf(building.bounds);
  let best = centers[0] ?? centerOf(building.bounds);
  let far = -Infinity;
  for (const c of centers) {
    const d = Math.hypot(c.x - entry.pos.x, c.z - entry.pos.z);
    if (d > far) {
      far = d;
      best = c;
    }
  }
  return best;
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
