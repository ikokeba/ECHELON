import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ==== v5仕様 追補5(CQB)のパラメータをそのまま定数化 ==========================
const STACK_DIST = 1.5;        // スタック形成距離(扉からm)
const CORNER_ANGLE_DEG = 90;   // コーナークリア担当角度
const ENTRY_SPEED_MUL = 0.7;   // 進入時の移動速度倍率
const DANGER_BONUS = 2.0;      // 危険地帯優先度加算(参考表示のみ)
const ENTRY_STAGGER = 0.6;     // 突入時、隊員間の流入間隔(秒)。単一ファイルでの流入を再現

// ==== 部屋・扉ジオメトリ(1部屋+1扉の最小構成) ================================
const ROOM_HW = 5;   // 室内半幅
const ROOM_HD = 4;   // 室内半奥行き
const DOOR_HW = 0.6; // 扉半幅
const WALL_T = 0.15; // 壁厚(半分)

const WALLS = [
  { cx: 0, cz: ROOM_HD, hw: ROOM_HW, hd: WALL_T },                                        // 北壁
  { cx: ROOM_HW, cz: 0, hw: WALL_T, hd: ROOM_HD },                                         // 東壁
  { cx: -ROOM_HW, cz: 0, hw: WALL_T, hd: ROOM_HD },                                        // 西壁
  { cx: -(ROOM_HW + DOOR_HW) / 2, cz: -ROOM_HD, hw: (ROOM_HW - DOOR_HW) / 2, hd: WALL_T }, // 南壁(左, 扉の左側)
  { cx: (ROOM_HW + DOOR_HW) / 2, cz: -ROOM_HD, hw: (ROOM_HW - DOOR_HW) / 2, hd: WALL_T },  // 南壁(右, 扉の右側)
];
const DOOR = { x: 0, z: -ROOM_HD };

// ==== 幾何ユーティリティ(元のsquadモックのrayAABB/hasLineOfSightと同方式) =========
function rayAABB(ox, oz, dx, dz, wall, maxDist) {
  const minX = wall.cx - wall.hw, maxX = wall.cx + wall.hw;
  const minZ = wall.cz - wall.hd, maxZ = wall.cz + wall.hd;
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return null; }
  else { let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return null; }
  else { let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (tmax < tmin || tmax < 0) return null;
  const hit = tmin > 0.001 ? tmin : tmax;
  if (hit < 0 || hit > maxDist) return null;
  return hit;
}
function hasLineOfSight(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1e-6;
  const ndx = dx / d, ndz = dz / d;
  for (const w of WALLS) {
    if (rayAABB(ax, az, ndx, ndz, w, d) !== null) return false;
  }
  return true;
}
function collidesWall(x, z, margin) {
  for (const w of WALLS) {
    if (x > w.cx - w.hw - margin && x < w.cx + w.hw + margin && z > w.cz - w.hd - margin && z < w.cz + w.hd + margin) return true;
  }
  return false;
}
function edgeIsClear(ax, az, bx, bz) {
  if (!hasLineOfSight(ax, az, bx, bz)) return false;
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1;
  const px = -dz / d, pz = dx / d;
  const margin = 0.18;
  if (!hasLineOfSight(ax + px * margin, az + pz * margin, bx + px * margin, bz + pz * margin)) return false;
  if (!hasLineOfSight(ax - px * margin, az - pz * margin, bx - px * margin, bz - pz * margin)) return false;
  return true;
}

// ==== ナビゲーショングリッド(0.3mステップ、ダイクストラ法) ======================
const NAV_STEP = 0.3;
const NAV_MARGIN = 0.3; // ユニット半径(0.32)相当の余裕
const NAV_BOUNDS = { minX: -6.5, maxX: 6.5, minZ: -8.5, maxZ: 5.5 };
const NAV_GRID = (() => {
  const cols = Math.round((NAV_BOUNDS.maxX - NAV_BOUNDS.minX) / NAV_STEP) + 1;
  const rows = Math.round((NAV_BOUNDS.maxZ - NAV_BOUNDS.minZ) / NAV_STEP) + 1;
  const idxMap = new Int32Array(cols * rows).fill(-1);
  const nodes = [];
  for (let gz = 0; gz < rows; gz++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = NAV_BOUNDS.minX + gx * NAV_STEP, z = NAV_BOUNDS.minZ + gz * NAV_STEP;
      if (collidesWall(x, z, NAV_MARGIN)) continue;
      idxMap[gz * cols + gx] = nodes.length;
      nodes.push({ x, z, gx, gz });
    }
  }
  const adj = nodes.map(() => []);
  const dirs8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  nodes.forEach((n, i) => dirs8.forEach(([dx, dz]) => {
    const ngx = n.gx + dx, ngz = n.gz + dz;
    if (ngx < 0 || ngx >= cols || ngz < 0 || ngz >= rows) return;
    const j = idxMap[ngz * cols + ngx];
    if (j === -1) return;
    const m = nodes[j];
    if (!edgeIsClear(n.x, n.z, m.x, m.z)) return; // 辺が壁を貫通する場合は接続しない
    adj[i].push([j, Math.hypot(dx, dz) * NAV_STEP]);
  }));
  return { nodes, adj };
})();
function nearestNavNode(x, z) {
  let best = -1, bestD = Infinity;
  const { nodes } = NAV_GRID;
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i].x - x, nodes[i].z - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function findPath(sx, sz, tx, tz) {
  const { nodes, adj } = NAV_GRID;
  const startIdx = nearestNavNode(sx, sz), endIdx = nearestNavNode(tx, tz);
  if (startIdx === -1 || endIdx === -1) return null;
  const n = nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[startIdx] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1 || u === endIdx) break;
    visited[u] = 1;
    for (const [v, edgeDist] of adj[u]) {
      if (visited[v]) continue;
      const nd = dist[u] + edgeDist;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  if (dist[endIdx] === Infinity) return null;
  const path = [];
  let cur = endIdx;
  while (cur !== -1) { path.push({ x: nodes[cur].x, z: nodes[cur].z }); cur = prev[cur]; }
  path.reverse();
  path.push({ x: tx, z: tz }); // 実際の目標点で終端(ノード中心のズレを吸収)
  return path;
}

// ==== 4名のユニット定義: スタック位置→ブリーチ経路→クリアリング担当位置 =========
const COLORS = [0xf59e0b, 0x38bdf8, 0x4ade80, 0xf87171];
const CORNER_TARGETS = [
  { name: "近方左(手前左隅)", x: -ROOM_HW + 1.0, z: -ROOM_HD + 1.2, facing: [1, 0] },
  { name: "遠方右(奥右隅)", x: ROOM_HW - 1.0, z: ROOM_HD - 1.2, facing: [-1, 0] },
  { name: "近方右(手前右隅)", x: ROOM_HW - 1.0, z: -ROOM_HD + 1.2, facing: [-1, 0] },
  { name: "遠方左(奥左隅)", x: -ROOM_HW + 1.0, z: ROOM_HD - 1.2, facing: [1, 0] },
];
const STACK_POS = [0, 1, 2, 3].map((i) => ({ x: -DOOR_HW - 0.5 - i * 0.5, z: -ROOM_HD - 0.5 }));
const STAGE_POS = [0, 1, 2, 3].map((i) => ({ x: -DOOR_HW - 0.5 - i * 0.5, z: -ROOM_HD - 3.5 }));

function stepAlongPath(u, speed, dt) {
  if (!u.path || u.pathIdx >= u.path.length) return { x: u.x, z: u.z, arrived: true };
  const target = u.path[u.pathIdx];
  const dx = target.x - u.x, dz = target.z - u.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.06) {
    u.pathIdx += 1;
    if (u.pathIdx >= u.path.length) return { x: target.x, z: target.z, arrived: true };
    return { x: target.x, z: target.z, arrived: false, dirX: dx / (d || 1), dirZ: dz / (d || 1) };
  }
  const s = Math.min(d, speed * dt);
  return { x: u.x + (dx / d) * s, z: u.z + (dz / d) * s, arrived: false, dirX: dx / d, dirZ: dz / d };
}

const PHASE_LABEL = {
  approach: "① 接近中(経路探索中)",
  stack: "① スタック形成完了・突入待機",
  breach: "② ブリーチ(突破)実行中",
  clearing: "③ 室内クリアリング中",
  cleared: "③ クリアリング完了",
};

export default function CQBPrototype() {
  const mountRef = useRef(null);
  const [phase, setPhase] = useState("approach");
  const [unitStates, setUnitStates] = useState(["接近", "接近", "接近", "接近"]);
  const [pathOk, setPathOk] = useState(true);
  const breachRequestedRef = useRef(false);
  const resetRequestedRef = useRef(false);

  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth, height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const CAM_DIV = 34;
    const camera = new THREE.OrthographicCamera(-width / CAM_DIV, width / CAM_DIV, height / CAM_DIV, -height / CAM_DIV, 0.1, 400);
    camera.position.set(0, 46, 20);
    camera.lookAt(0, 0, -1.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 1));

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x1e293b }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    scene.add(new THREE.GridHelper(40, 40, 0x334155, 0x1f2937));

    // 壁
    WALLS.forEach((w) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.hw * 2, 1.4, w.hd * 2), new THREE.MeshBasicMaterial({ color: 0x64748b }));
      mesh.position.set(w.cx, 0.7, w.cz);
      scene.add(mesh);
    });

    // 扉マーカー
    const doorMesh = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_HW * 2, WALL_T * 2 + 0.3), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
    doorMesh.rotation.x = -Math.PI / 2;
    doorMesh.position.set(DOOR.x, 0.02, DOOR.z);
    scene.add(doorMesh);

    // 危険地帯(扉〜室内側のファネル)のハイライト
    const dangerMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.6), new THREE.MeshBasicMaterial({ color: 0xdc2626, transparent: true, opacity: 0.18 }));
    dangerMesh.rotation.x = -Math.PI / 2;
    dangerMesh.position.set(0, 0.015, -ROOM_HD + 1.0);
    scene.add(dangerMesh);

    // スタック形成距離の目安円
    const stackRing = new THREE.Mesh(new THREE.RingGeometry(STACK_DIST - 0.03, STACK_DIST, 48), new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    stackRing.rotation.x = -Math.PI / 2;
    stackRing.position.set(DOOR.x, 0.015, DOOR.z);
    scene.add(stackRing);

    // ナビゲーショングリッドのデバッグ表示(通行可能ノード)
    const navDots = new THREE.Group();
    NAV_GRID.nodes.forEach((n) => {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.03, 6), new THREE.MeshBasicMaterial({ color: 0x334155 }));
      d.rotation.x = -Math.PI / 2;
      d.position.set(n.x, 0.005, n.z);
      navDots.add(d);
    });
    scene.add(navDots);

    // ユニット
    const unitMeshes = COLORS.map((color) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 16), new THREE.MeshBasicMaterial({ color }));
      body.position.y = 0.25;
      g.add(body);
      const facing = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      facing.rotation.x = Math.PI / 2;
      facing.position.set(0, 0.25, 0.4);
      g.add(facing);
      scene.add(g);
      return g;
    });

    // 経路ライン(色付き、隊員ごと)
    const pathLines = COLORS.map((color) => {
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      scene.add(line);
      return line;
    });

    // セクター(90°索敵扇形)は必要時にのみ生成
    const sectorMeshes = [null, null, null, null];
    function clearSector(i) {
      if (sectorMeshes[i]) { scene.remove(sectorMeshes[i]); sectorMeshes[i].geometry.dispose(); sectorMeshes[i].material.dispose(); sectorMeshes[i] = null; }
    }
    function setSector(i, cx, cz, dirX, dirZ) {
      clearSector(i);
      const angle = (CORNER_ANGLE_DEG * Math.PI) / 180;
      const baseAngle = Math.atan2(dirX, dirZ);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      const steps = 16;
      for (let s = 0; s <= steps; s++) {
        const a = baseAngle - angle / 2 + (angle * s) / steps;
        shape.lineTo(Math.sin(a) * 2.2, Math.cos(a) * 2.2);
      }
      shape.lineTo(0, 0);
      const geo = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS[i], transparent: true, opacity: 0.15, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, 0.01, cz);
      scene.add(mesh);
      sectorMeshes[i] = mesh;
    }
    function setPathLine(i, pts) {
      if (!pts || pts.length < 2) { pathLines[i].visible = false; return; }
      const arr = new Float32Array(pts.length * 3);
      pts.forEach((p, k) => { arr[k * 3] = p.x; arr[k * 3 + 1] = 0.04; arr[k * 3 + 2] = p.z; });
      pathLines[i].geometry.dispose();
      pathLines[i].geometry = new THREE.BufferGeometry();
      pathLines[i].geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      pathLines[i].visible = true;
    }

    // ユニット内部状態(座標・経路・突入開始タイマー)
    const units = STAGE_POS.map((p, i) => ({ x: p.x, z: p.z, facing: [0, 1], path: null, pathIdx: 0, entryDelay: i * ENTRY_STAGGER, entryStarted: false }));
    let localPhase = "approach";
    let anyPathFailed = false;
    const localUnitLabels = ["経路計算中", "経路計算中", "経路計算中", "経路計算中"];

    function assignPath(u, i, tx, tz) {
      const p = findPath(u.x, u.z, tx, tz);
      if (!p) { anyPathFailed = true; return false; }
      u.path = p; u.pathIdx = 0;
      setPathLine(i, [{ x: u.x, z: u.z }, ...p]);
      return true;
    }

    // 起動時: 各ユニットのステージ位置→スタック位置の経路をあらかじめ計算
    units.forEach((u, i) => assignPath(u, i, STACK_POS[i].x, STACK_POS[i].z));
    setPathOk(!anyPathFailed);

    let raf;
    let last = performance.now();
    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (resetRequestedRef.current) {
        resetRequestedRef.current = false;
        localPhase = "approach";
        anyPathFailed = false;
        units.forEach((u, i) => {
          u.x = STAGE_POS[i].x; u.z = STAGE_POS[i].z; u.facing = [0, 1];
          u.entryDelay = i * ENTRY_STAGGER; u.entryStarted = false;
          clearSector(i);
          assignPath(u, i, STACK_POS[i].x, STACK_POS[i].z);
        });
        setPathOk(!anyPathFailed);
        setPhase("approach");
      }

      if (localPhase === "approach") {
        let allArrived = true;
        units.forEach((u, i) => {
          const r = stepAlongPath(u, 2.2, dt);
          u.x = r.x; u.z = r.z;
          if (r.dirX !== undefined) u.facing = [r.dirX, r.dirZ];
          localUnitLabels[i] = "接近中";
          if (!r.arrived) allArrived = false;
        });
        if (allArrived) {
          localPhase = "stack"; setPhase("stack");
          units.forEach((_, i) => { localUnitLabels[i] = "待機(スタック)"; pathLines[i].visible = false; });
        }
      } else if (localPhase === "stack") {
        if (breachRequestedRef.current) {
          breachRequestedRef.current = false;
          anyPathFailed = false;
          units.forEach((u, i) => assignPath(u, i, CORNER_TARGETS[i].x, CORNER_TARGETS[i].z));
          setPathOk(!anyPathFailed);
          localPhase = "breach"; setPhase("breach");
        }
      } else if (localPhase === "breach" || localPhase === "clearing") {
        let allArrived = true;
        units.forEach((u, i) => {
          if (!u.entryStarted) {
            u.entryDelay -= dt;
            if (u.entryDelay > 0) { localUnitLabels[i] = "突入順番待ち"; allArrived = false; return; }
            u.entryStarted = true;
          }
          const target = CORNER_TARGETS[i];
          const r = stepAlongPath(u, 2.2 * ENTRY_SPEED_MUL, dt);
          u.x = r.x; u.z = r.z;
          if (r.arrived) {
            u.facing = target.facing;
            localUnitLabels[i] = `コーナー確保(${target.name})`;
            setSector(i, u.x, u.z, target.facing[0], target.facing[1]);
            pathLines[i].visible = false;
          } else {
            if (r.dirX !== undefined) u.facing = [r.dirX, r.dirZ];
            localUnitLabels[i] = "進入・移動中";
            allArrived = false;
          }
        });
        if (localPhase === "breach") { localPhase = "clearing"; setPhase("clearing"); }
        if (allArrived) { localPhase = "cleared"; setPhase("cleared"); }
      }

      setUnitStates([...localUnitLabels]);

      unitMeshes.forEach((g, i) => {
        g.position.set(units[i].x, 0, units[i].z);
        const [fx, fz] = units[i].facing;
        g.rotation.y = Math.atan2(fx, fz);
      });

      stackRing.material.opacity = localPhase === "stack" ? 0.9 : 0.25;

      renderer.render(scene, camera);
    }
    animate();

    const onResize = () => {
      const w2 = mount.clientWidth, h2 = mount.clientHeight;
      camera.left = -w2 / CAM_DIV; camera.right = w2 / CAM_DIV; camera.top = h2 / CAM_DIV; camera.bottom = -h2 / CAM_DIV;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: "#0f172a", fontFamily: "system-ui, sans-serif", color: "#e2e8f0" }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>CQB最小プロトタイプ:1部屋+1扉(ダイクストラ経路探索版)</strong>
        <span style={{ fontSize: 13, padding: "3px 10px", borderRadius: 6, background: "#1e293b", color: "#fbbf24" }}>{PHASE_LABEL[phase]}</span>
        {!pathOk && <span style={{ fontSize: 12, color: "#f87171" }}>⚠ 一部ユニットの経路が見つかりませんでした</span>}
        <button
          onClick={() => { breachRequestedRef.current = true; }}
          disabled={phase !== "stack"}
          style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: phase === "stack" ? "pointer" : "not-allowed", background: phase === "stack" ? "#dc2626" : "#334155", color: "#fff", fontWeight: 600 }}
        >
          ② ブリーチ命令発行
        </button>
        <button
          onClick={() => { resetRequestedRef.current = true; }}
          style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #334155", cursor: "pointer", background: "transparent", color: "#e2e8f0" }}
        >
          リセット
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          スタック距離{STACK_DIST}m / セクター{CORNER_ANGLE_DEG}° / 進入速度×{ENTRY_SPEED_MUL} / 流入間隔{ENTRY_STAGGER}s / 危険地帯加算+{DANGER_BONUS} / グリッド{NAV_STEP}m
        </span>
      </div>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ padding: "8px 16px", borderTop: "1px solid #1f2937", display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12 }}>
        {unitStates.map((s, i) => (
          <span key={i} style={{ color: `#${COLORS[i].toString(16).padStart(6, "0")}` }}>
            隊員{i + 1}: {s}
          </span>
        ))}
      </div>
    </div>
  );
}
