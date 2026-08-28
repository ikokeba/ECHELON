/**
 * Uniform navigation grid + A* pathfinding.
 *
 * Ported from cqb-minimal-prototype.jsx (`NAV_GRID` + `findPath`), with two
 * changes for the integrated sim:
 *   - the grid is built from arguments (walls / bounds / step / margin) instead
 *     of module-level constants, so outdoor (1 m) and per-building (0.3 m) grids
 *     can coexist (see docs/design/00 §4.2);
 *   - search is A* on a binary heap instead of full-graph Dijkstra, so it stays
 *     affordable on a company-scale map.
 *
 * Grid semantics are unchanged: 8-connected, and an edge is dropped when it
 * crosses a wall (AABB + parallel-offset LOS via `edgeIsClear`).
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
  /** adjacency: adj[i] = [neighbourNodeIndex, edgeCost][] */
  adj: [number, number][][];
  cols: number;
  rows: number;
  /** cols*rows, entry = node index or -1 */
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

/** Nearest walkable node to an arbitrary world point, or -1 if the grid is empty. */
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

  // spiral outward for the closest free cell
  const maxR = Math.max(cols, rows);
  let best = -1;
  let bestD = Infinity;
  for (let r = 1; r <= maxR; r++) {
    for (let gx = cgx - r; gx <= cgx + r; gx++) {
      for (let gz = cgz - r; gz <= cgz + r; gz++) {
        if (Math.max(Math.abs(gx - cgx), Math.abs(gz - cgz)) !== r) continue; // ring only
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

/** Min-heap keyed by fScore; stores node indices. */
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
 * A* from (sx,sz) to (tx,tz). Returns a list of waypoints ending at the exact
 * target point (absorbing node-centre offset, as the cqb mock did), or null if
 * unreachable.
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
