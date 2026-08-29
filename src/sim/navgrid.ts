/**
 * 一様ナビゲーショングリッドと A* 経路探索。
 *
 * cqb-minimal-prototype.jsx の `NAV_GRID` + `findPath` からの移植だが、統合シム向けに
 * 2点を変更している:
 *   - グリッドをモジュール定数ではなく引数(壁/境界/刻み/マージン)から構築する。
 *     屋外(1m)と建物ごと(0.3m)のグリッドを共存させるため(docs/design/00 §4.2)。
 *   - 探索を全グラフ走査のダイクストラから、バイナリヒープ上の A* へ変更した。
 *     中隊規模のマップでも計算量が破綻しないようにするため。
 *
 * グリッドの意味論は変更なし: 8近傍で、壁を貫通する辺は接続しない
 * (AABB + 平行オフセットLOS を `edgeIsClear` で判定)。
 */

import { edgeIsClear, collidesWall } from "./geometry.ts";
import type { AABB, Bounds, Building, Vec2 } from "./types.ts";

export interface NavNode {
  x: number;
  z: number;
  gx: number;
  gz: number;
}

export interface NavGrid {
  nodes: NavNode[];
  /** 隣接リスト: adj[i] = [隣接ノードのindex, 辺のコスト][] */
  adj: [number, number][][];
  cols: number;
  rows: number;
  /** 長さ cols*rows。各要素はノードindex、通行不可なら -1 */
  idxMap: Int32Array;
  step: number;
  margin: number;
  bounds: Bounds;
}

const DIRS8: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * 同コストの経路が複数ある場合の決着に使う、ごく小さな決定論的コスト。
 *
 * これがないと、等コストの経路は探索順(DIRS8 の並び順とヒープの押し込み順)で
 * 決まる。DIRS8 は +X を −X より先に見るため、等コスト時は常に特定の方角が
 * 選ばれ続ける。**方角の選好は、対称な地形であっても開始位置によって有利不利を
 * 生む**(実際に、−z側から進む陣営が一貫して不利になる偏りを計測した)。
 *
 * ノード座標のハッシュで決着させることで、選好を「特定方角」から「任意だが決定論的」
 * へ変える。値はグリッド間隔(1m)に対して十分小さく、最短経路そのものは変えない。
 */
const TIE_EPS = 1e-4;

function tieJitter(gx: number, gz: number): number {
  // 32bit整数ハッシュ(乗算+シフト)。座標が近くても出力は散らばる。
  let h = (gx * 374761393 + gz * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967296) * TIE_EPS;
}

function inBounds(b: Bounds, x: number, z: number): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

export function buildNavGrid(
  walls: readonly AABB[],
  bounds: Bounds,
  step: number,
  margin: number,
  /** この領域の内側のセルは作らない。屋外の粗いグリッドから建物内部を除くために使う */
  exclude: readonly Bounds[] = [],
): NavGrid {
  const cols = Math.round((bounds.maxX - bounds.minX) / step) + 1;
  const rows = Math.round((bounds.maxZ - bounds.minZ) / step) + 1;
  const idxMap = new Int32Array(cols * rows).fill(-1);
  const nodes: NavNode[] = [];

  for (let gz = 0; gz < rows; gz++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = bounds.minX + gx * step;
      const z = bounds.minZ + gz * step;
      if (collidesWall(walls, x, z, margin)) continue;
      if (exclude.some((b) => inBounds(b, x, z))) continue;
      idxMap[gz * cols + gx] = nodes.length;
      nodes.push({ x, z, gx, gz });
    }
  }

  const adj: [number, number][][] = nodes.map(() => []);
  nodes.forEach((n, i) => {
    for (const [dx, dz] of DIRS8) {
      const ngx = n.gx + dx;
      const ngz = n.gz + dz;
      if (ngx < 0 || ngx >= cols || ngz < 0 || ngz >= rows) continue;
      const j = idxMap[ngz * cols + ngx]!;
      if (j === -1) continue;
      const m = nodes[j]!;
      if (!edgeIsClear(walls, n.x, n.z, m.x, m.z, margin * 0.6)) continue;
      // 進入先ノードのハッシュ由来の微小コストを加え、等コスト経路の決着から
      // 方角の選好を取り除く
      adj[i]!.push([j, Math.hypot(dx, dz) * step + tieJitter(m.gx, m.gz)]);
    }
  });

  return { nodes, adj, cols, rows, idxMap, step, margin, bounds };
}

/** 任意のワールド座標に最も近い通行可能ノード。グリッドが空なら -1。 */
export function nearestNavNode(grid: NavGrid, x: number, z: number): number {
  const { bounds, step, cols, rows, idxMap } = grid;
  const cgx = Math.round((x - bounds.minX) / step);
  const cgz = Math.round((z - bounds.minZ) / step);

  const at = (gx: number, gz: number): number => {
    if (gx < 0 || gx >= cols || gz < 0 || gz >= rows) return -1;
    return idxMap[gz * cols + gx]!;
  };

  const direct = at(cgx, cgz);
  if (direct !== -1) return direct;

  // 直上のセルが埋まっている場合は、外側へ渦巻き状に探して最も近い空きセルを取る
  const maxR = Math.max(cols, rows);
  let best = -1;
  let bestD = Infinity;
  for (let r = 1; r <= maxR; r++) {
    for (let gx = cgx - r; gx <= cgx + r; gx++) {
      for (let gz = cgz - r; gz <= cgz + r; gz++) {
        if (Math.max(Math.abs(gx - cgx), Math.abs(gz - cgz)) !== r) continue; // リング上のみ
        const idx = at(gx, gz);
        if (idx === -1) continue;
        const nd = Math.hypot(grid.nodes[idx]!.x - x, grid.nodes[idx]!.z - z);
        if (nd < bestD) {
          bestD = nd;
          best = idx;
        }
      }
    }
    if (best !== -1) return best;
  }
  return best;
}

/** fScore をキーとする最小ヒープ。ノードindexを格納する。 */
class MinHeap {
  private items: number[] = [];
  constructor(private readonly key: (n: number) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(n: number): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key(a[p]!) <= this.key(a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < a.length && this.key(a[l]!) < this.key(a[s]!)) s = l;
        if (r < a.length && this.key(a[r]!) < this.key(a[s]!)) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i]!, a[s]!];
        i = s;
      }
    }
    return top;
  }
}

/**
 * (sx,sz) から (tx,tz) への A*。ウェイポイント列を返し、末尾は厳密な目標点にする
 * (ノード中心とのズレを吸収。cqbモックと同じ処理)。到達不能なら null。
 */
export function findPath(
  grid: NavGrid,
  sx: number,
  sz: number,
  tx: number,
  tz: number,
): Vec2[] | null {
  const startIdx = nearestNavNode(grid, sx, sz);
  const endIdx = nearestNavNode(grid, tx, tz);
  if (startIdx === -1 || endIdx === -1) return null;
  if (startIdx === endIdx) return [{ x: tx, z: tz }];
  return astar(grid.nodes, grid.adj, startIdx, endIdx, tx, tz);
}

/**
 * A* の本体。ノード列と隣接リストだけを見るので、単一グリッドでも
 * 複数グリッドを束ねた NavSet でも同じ実装が使える。
 */
function astar(
  nodes: readonly NavNode[],
  adj: readonly [number, number][][],
  startIdx: number,
  endIdx: number,
  tx: number,
  tz: number,
): Vec2[] | null {
  const n = nodes.length;
  const gScore = new Float64Array(n).fill(Infinity);
  const fScore = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  const end = nodes[endIdx]!;
  const h = (i: number): number => Math.hypot(nodes[i]!.x - end.x, nodes[i]!.z - end.z);

  gScore[startIdx] = 0;
  fScore[startIdx] = h(startIdx);
  const open = new MinHeap((i) => fScore[i]!);
  open.push(startIdx);

  while (open.size > 0) {
    const cur = open.pop()!;
    if (cur === endIdx) break;
    if (closed[cur]) continue;
    closed[cur] = 1;

    for (const [nb, cost] of adj[cur]!) {
      if (closed[nb]) continue;
      const tentative = gScore[cur]! + cost;
      if (tentative < gScore[nb]!) {
        prev[nb] = cur;
        gScore[nb] = tentative;
        fScore[nb] = tentative + h(nb);
        open.push(nb);
      }
    }
  }

  if (prev[endIdx] === -1 && startIdx !== endIdx) return null;

  const path: Vec2[] = [];
  let cur = endIdx;
  while (cur !== -1) {
    path.push({ x: nodes[cur]!.x, z: nodes[cur]!.z });
    cur = prev[cur]!;
  }
  path.reverse();
  path.push({ x: tx, z: tz });
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// 複合ナビゲーション(design §4.2: 屋外1.0m + 建物ごと0.3m、継ぎ目で接続)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解像度の異なるグリッドを1つの探索空間へ束ねたもの。
 *
 * 屋外を0.3mで敷き詰めると中隊規模のマップでノードが百万単位になる。一方で扉幅
 * 1.2mを安全に通すには0.3mが要る(仕様 §7.3 で検証済み)。そこで**建物のまわりだけ
 * 細かくし、継ぎ目で縫い合わせる**。探索そのものは束ねた1つのグラフの上で行うので、
 * 「街路を進んでそのまま建物へ突入する」連続的な経路が1回のA*で出る(仕様 §7.1)。
 */
export interface NavSet {
  /** 束ねたノード列。grids の順に連結されている */
  nodes: NavNode[];
  /** 束ねた隣接リスト(各グリッドの辺 + 継ぎ目の辺) */
  adj: [number, number][][];
  /** [0] = 屋外の粗いグリッド、[1..] = 建物ごとの細グリッド */
  grids: NavGrid[];
  /** grids[i] のノードが束ねた空間で始まるindex */
  offsets: number[];
  /** grids[i+1] が担当する領域(建物 + 進入余裕)。屋外グリッドには対応しない */
  regions: Bounds[];
}

/** 細グリッドが建物の外側へ張り出す余裕 m。スタック位置(扉から1.5m)を含める。 */
const FINE_PAD = 2.5;

function pad(b: Bounds, m: number): Bounds {
  return { minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m };
}

/** 束ねた空間でのノードindex(grid内index → 全体index)。 */
function globalIdx(set: { offsets: number[] }, gridIdx: number, localIdx: number): number {
  return set.offsets[gridIdx]! + localIdx;
}

/**
 * 屋外グリッドと建物ごとの細グリッドを作り、継ぎ目で接続した NavSet を返す。
 * 建物がなければ屋外グリッド1枚だけの NavSet になる(既存の挙動と完全に同じ)。
 */
export function buildNavSet(
  walls: readonly AABB[],
  bounds: Bounds,
  outdoorStep: number,
  outdoorMargin: number,
  buildings: readonly Building[],
  fineStep: number,
  fineMargin: number,
): NavSet {
  const regions = buildings.map((b) => pad(b.bounds, FINE_PAD));
  // 屋外グリッドからは建物の内部だけを除く。外周の余裕(FINE_PAD)まで除くと、
  // 建物の周囲に屋外ノードが無くなって継ぎ目を張れなくなる
  const outdoor = buildNavGrid(
    walls,
    bounds,
    outdoorStep,
    outdoorMargin,
    buildings.map((b) => b.bounds),
  );
  const fine = regions.map((r) =>
    buildNavGrid(walls, clampBounds(r, bounds), fineStep, fineMargin),
  );

  const grids = [outdoor, ...fine];
  const offsets: number[] = [];
  let total = 0;
  for (const g of grids) {
    offsets.push(total);
    total += g.nodes.length;
  }

  const nodes: NavNode[] = [];
  const adj: [number, number][][] = [];
  grids.forEach((g, gi) => {
    for (const n of g.nodes) nodes.push(n);
    for (const list of g.adj) {
      adj.push(list.map(([j, c]) => [globalIdx({ offsets }, gi, j), c] as [number, number]));
    }
  });

  // ── 継ぎ目の接続 ──
  // 細グリッドの外縁ノードから、直近の屋外ノードへ双方向の辺を張る。扉を「だけ」
  // 繋ぐより頑健で、建物の周囲どこからでも出入りできる(仕様 §7.1 のシームレス性)。
  const SEAM = fineStep * 1.5;
  fine.forEach((g, i) => {
    const region = regions[i]!;
    const gi = i + 1;
    g.nodes.forEach((n, li) => {
      const nearEdge =
        n.x - region.minX < SEAM ||
        region.maxX - n.x < SEAM ||
        n.z - region.minZ < SEAM ||
        region.maxZ - n.z < SEAM;
      if (!nearEdge) return;
      const oi = nearestNavNode(outdoor, n.x, n.z);
      if (oi === -1) return;
      const o = outdoor.nodes[oi]!;
      const d = Math.hypot(o.x - n.x, o.z - n.z);
      if (d > outdoorStep * 2) return;
      if (!edgeIsClear(walls, n.x, n.z, o.x, o.z, fineMargin * 0.6)) return;
      const a = globalIdx({ offsets }, gi, li);
      const b = globalIdx({ offsets }, 0, oi);
      adj[a]!.push([b, d]);
      adj[b]!.push([a, d]);
    });
  });

  return { nodes, adj, grids, offsets, regions };
}

function clampBounds(b: Bounds, outer: Bounds): Bounds {
  return {
    minX: Math.max(b.minX, outer.minX),
    maxX: Math.min(b.maxX, outer.maxX),
    minZ: Math.max(b.minZ, outer.minZ),
    maxZ: Math.min(b.maxZ, outer.maxZ),
  };
}

/**
 * 束ねた空間で (x,z) に最も近いノード。建物の担当領域に入っていればその細グリッドを、
 * それ以外は屋外グリッドを使う。細かいほうを優先するのは、扉まわりの解像度を
 * 落とさないため。
 */
export function nearestNodeIn(set: NavSet, x: number, z: number): number {
  for (let i = 0; i < set.regions.length; i++) {
    if (!inBounds(set.regions[i]!, x, z)) continue;
    const g = set.grids[i + 1]!;
    const li = nearestNavNode(g, x, z);
    if (li !== -1) return globalIdx(set, i + 1, li);
  }
  const oi = nearestNavNode(set.grids[0]!, x, z);
  return oi === -1 ? -1 : globalIdx(set, 0, oi);
}

/** NavSet 上のA*。単一グリッドの findPath と同じ意味論(末尾は厳密な目標点)。 */
export function findPathSet(
  set: NavSet,
  sx: number,
  sz: number,
  tx: number,
  tz: number,
): Vec2[] | null {
  const startIdx = nearestNodeIn(set, sx, sz);
  const endIdx = nearestNodeIn(set, tx, tz);
  if (startIdx === -1 || endIdx === -1) return null;
  if (startIdx === endIdx) return [{ x: tx, z: tz }];
  return astar(set.nodes, set.adj, startIdx, endIdx, tx, tz);
}
