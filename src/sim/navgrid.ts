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
import type { AABB, Bounds, Vec2 } from "./types.ts";

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

export function buildNavGrid(
  walls: readonly AABB[],
  bounds: Bounds,
  step: number,
  margin: number,
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
      adj[i]!.push([j, Math.hypot(dx, dz) * step]);
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
  const { nodes, adj } = grid;
  const startIdx = nearestNavNode(grid, sx, sz);
  const endIdx = nearestNavNode(grid, tx, tz);
  if (startIdx === -1 || endIdx === -1) return null;
  if (startIdx === endIdx) return [{ x: tx, z: tz }];

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
