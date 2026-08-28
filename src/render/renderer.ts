/**
 * Top-down three.js view. Reads World, draws; never mutates sim state.
 *
 * Orthographic camera looking straight down (−Y). Screen axes: +X right,
 * +Z downward. Flat tokens for now (discs + facing wedge); 3D figures can
 * replace them later without touching the sim (design AD-4/AD-5).
 */

import * as THREE from "three";
import type { World } from "@sim/world.ts";
import type { Side } from "@sim/types.ts";
import { SOLDIER_RADIUS } from "@sim/constants.ts";

const SIDE_COLOR: Record<Side, number> = {
  blue: 0x4aa3ff,
  red: 0xff5a4a,
};
const KIA_COLOR = 0x39414f;
const WIA_COLOR = 0xf0c000;
const GROUND_COLOR = 0x0f1420;
const WALL_COLOR = 0x39435a;
const MAX_SOLDIERS = 512;

interface TickSnapshot {
  tick: number;
  pos: Map<number, { x: number; z: number; fx: number; fz: number }>;
}

function snapshot(world: World): TickSnapshot {
  const pos = new Map<number, { x: number; z: number; fx: number; fz: number }>();
  for (const s of world.soldiers) {
    pos.set(s.id, { x: s.pos.x, z: s.pos.z, fx: s.facing.x, fz: s.facing.z });
  }
  return { tick: world.tick, pos };
}

export interface Renderer {
  render(world: World, alpha: number): void;
  resize(): void;
  /** world-space point under a screen pixel (for selection / orders later) */
  screenToWorld(clientX: number, clientY: number): { x: number; z: number };
  dispose(): void;
}

export function createRenderer(canvas: HTMLCanvasElement, world: World): Renderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(GROUND_COLOR);

  // Camera: metres of world height visible is `viewSpan`; pan via target.
  let viewSpan = 60;
  const target = new THREE.Vector3(0, 0, 0);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);

  // Ground
  const groundW = world.bounds.maxX - world.bounds.minX;
  const groundH = world.bounds.maxZ - world.bounds.minZ;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundW, groundH),
    new THREE.MeshBasicMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(
    (world.bounds.minX + world.bounds.maxX) / 2,
    -0.01,
    (world.bounds.minZ + world.bounds.maxZ) / 2,
  );
  scene.add(ground);

  // Border
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(groundW, groundH)),
    new THREE.LineBasicMaterial({ color: 0x2a3446 }),
  );
  border.rotation.x = -Math.PI / 2;
  border.position.copy(ground.position);
  scene.add(border);

  // Walls — few enough to be individual meshes
  const wallMat = new THREE.MeshBasicMaterial({ color: WALL_COLOR });
  for (const w of world.walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.hw * 2, 2, w.hd * 2), wallMat);
    m.position.set(w.cx, 1, w.cz);
    scene.add(m);
  }

  // Control measures (objective rings etc.)
  for (const cm of world.controlMeasures) {
    if (cm.kind === "OBJ" && cm.points[0]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(2.4, 2.9, 40),
        new THREE.MeshBasicMaterial({ color: 0x6de0a0, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cm.points[0].x, 0.02, cm.points[0].z);
      scene.add(ring);
    }
  }

  // Soldiers — instanced discs + instanced facing wedges
  const discGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 1.6, 16);
  discGeo.rotateX(-Math.PI / 2);
  const discMesh = new THREE.InstancedMesh(
    discGeo,
    new THREE.MeshBasicMaterial(),
    MAX_SOLDIERS,
  );
  discMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SOLDIERS * 3), 3);
  scene.add(discMesh);

  const wedgeGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 2.4, 3);
  wedgeGeo.rotateX(-Math.PI / 2);
  const wedgeMesh = new THREE.InstancedMesh(
    wedgeGeo,
    new THREE.MeshBasicMaterial({ color: 0xdfe7f5 }),
    MAX_SOLDIERS,
  );
  scene.add(wedgeMesh);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  let prev: TickSnapshot = snapshot(world);
  let cur: TickSnapshot = prev;
  let lastTick = world.tick;

  function updateCamera(): void {
    const rect = canvas.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    const halfH = viewSpan / 2;
    const halfW = halfH * aspect;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.position.set(target.x, 100, target.z);
    camera.lookAt(target.x, 0, target.z);
    camera.updateProjectionMatrix();
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    updateCamera();
  }

  function render(world: World, alpha: number): void {
    if (world.tick !== lastTick) {
      prev = cur;
      cur = snapshot(world);
      lastTick = world.tick;
    }
    const a = prev === cur ? 1 : alpha;

    let i = 0;
    for (const s of world.soldiers) {
      const p = prev.pos.get(s.id) ?? cur.pos.get(s.id)!;
      const c = cur.pos.get(s.id)!;
      const x = p.x + (c.x - p.x) * a;
      const z = p.z + (c.z - p.z) * a;
      const fx = p.fx + (c.fx - p.fx) * a;
      const fz = p.fz + (c.fz - p.fz) * a;
      const heading = Math.atan2(fx, fz);

      dummy.position.set(x, 0.05, z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      discMesh.setMatrixAt(i, dummy.matrix);

      const color =
        s.status === "kia" ? KIA_COLOR : s.status === "wia" ? WIA_COLOR : SIDE_COLOR[s.side];
      discMesh.setColorAt(i, col.setHex(color));

      dummy.position.set(x + Math.sin(heading) * SOLDIER_RADIUS * 1.1, 0.06, z + Math.cos(heading) * SOLDIER_RADIUS * 1.1);
      dummy.rotation.set(0, heading, 0);
      dummy.updateMatrix();
      wedgeMesh.setMatrixAt(i, dummy.matrix);

      i++;
    }
    discMesh.count = i;
    wedgeMesh.count = i;
    discMesh.instanceMatrix.needsUpdate = true;
    wedgeMesh.instanceMatrix.needsUpdate = true;
    if (discMesh.instanceColor) discMesh.instanceColor.needsUpdate = true;
    wedgeMesh.instanceMatrix.needsUpdate = true;

    renderer.render(scene, camera);
  }

  function screenToWorld(clientX: number, clientY: number): { x: number; z: number } {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const halfH = viewSpan / 2;
    const halfW = halfH * (rect.width / Math.max(1, rect.height));
    return { x: target.x + ndcX * halfW, z: target.z - ndcY * halfH };
  }

  // ── camera controls: drag to pan, wheel to zoom ──
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const perPxY = viewSpan / rect.height;
    target.x -= (e.clientX - lastX) * perPxY;
    target.z -= (e.clientY - lastY) * perPxY;
    lastX = e.clientX;
    lastY = e.clientY;
    updateCamera();
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    viewSpan = THREE.MathUtils.clamp(viewSpan * (e.deltaY > 0 ? 1.1 : 0.9), 12, 220);
    updateCamera();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  resize();

  return {
    render,
    resize,
    screenToWorld,
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      discGeo.dispose();
      wedgeGeo.dispose();
      discMesh.dispose();
      wedgeMesh.dispose();
      renderer.dispose();
    },
  };
}
