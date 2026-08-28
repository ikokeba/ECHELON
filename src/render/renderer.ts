/**
 * three.js による見下ろしビュー。World を読んで描画するだけで、シム状態は一切変更しない。
 *
 * 正射影カメラで真下(−Y)を向く。画面軸は +X が右、+Z が下。
 * 現状は平面トークン(円盤 + 向きを示すくさび形)。将来3Dフィギュアへ差し替える際も
 * シム側には手を入れずに済む(design AD-4/AD-5)。
 */

import * as THREE from "three";
import type { World } from "@sim/world.ts";
import type { Side } from "@sim/types.ts";
import type { ViewResult } from "@sim/viewpoint.ts";
import { LITTER, SOLDIER_RADIUS } from "@sim/constants.ts";

const SIDE_COLOR: Record<Side, number> = {
  blue: 0x4aa3ff,
  red: 0xff5a4a,
};
const KIA_COLOR = 0x39414f;
const WIA_COLOR = 0xf0c000;
const GROUND_COLOR = 0x0f1420;
const WALL_COLOR = 0x39435a;
/** 確度が尽きた最終目撃情報(ゴースト)の色。仕様 §5 `[v6]` */
const GHOST_COLOR = 0x6b7280;
/** 止血済みWIA。出血は止まったが行動不能で後送待ち(仕様 §9) */
const STABILIZED_COLOR = 0x4fb477;
/** 担架搬送中(負傷者本人と担架要員の両方)。仕様 §9 */
const CARRYING_COLOR = 0x8fd6ff;
const MAX_SOLDIERS = 512;
const MAX_CONTACTS = 512;

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
  /**
   * 1フレーム描画する。
   * `view` は「いまどの立場から戦場を見ているか」の解決結果(仕様 §5)。
   * レンダラは world.soldiers を敵の描画には使わない — 敵は必ず view 経由。
   */
  render(world: World, view: ViewResult, alpha: number): void;
  resize(): void;
  /** 画面ピクセル下のワールド座標(将来の選択・命令発行用) */
  screenToWorld(clientX: number, clientY: number): { x: number; z: number };
  dispose(): void;
}

export function createRenderer(canvas: HTMLCanvasElement, world: World): Renderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(GROUND_COLOR);

  // カメラ: 画面に収まるワールド高さ(m)が `viewSpan`。パンは target を動かす。
  // 初期値はマップ全体が収まる高さにする(マップが大きくなっても勝手に見切れない)。
  let viewSpan = (world.bounds.maxZ - world.bounds.minZ) * 1.1;
  const target = new THREE.Vector3(
    (world.bounds.minX + world.bounds.maxX) / 2,
    0,
    (world.bounds.minZ + world.bounds.maxZ) / 2,
  );
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);

  // 地面
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

  // マップ境界
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(groundW, groundH)),
    new THREE.LineBasicMaterial({ color: 0x2a3446 }),
  );
  border.rotation.x = -Math.PI / 2;
  border.position.copy(ground.position);
  scene.add(border);

  // 壁 — 数が少ないので個別メッシュで足りる
  const wallMat = new THREE.MeshBasicMaterial({ color: WALL_COLOR });
  for (const w of world.walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.hw * 2, 2, w.hd * 2), wallMat);
    m.position.set(w.cx, 1, w.cz);
    scene.add(m);
  }

  // 統制手段(目標リングなど)
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

  // 負傷者集合点(CCP、仕様 §9)。担架班の搬送先なので、常に両陣営分を描く。
  for (const side of ["blue", "red"] as Side[]) {
    const p = world.ccp[side];
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(LITTER.EVAC_RADIUS - 0.35, LITTER.EVAC_RADIUS, 32),
      new THREE.MeshBasicMaterial({
        color: SIDE_COLOR[side],
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.02, p.z);
    scene.add(ring);
    // CCPだと分かるよう十字を重ねる(衛生標識の見立て)
    const cross = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
    );
    cross.rotation.x = -Math.PI / 2;
    cross.position.set(p.x, 0.021, p.z);
    scene.add(cross);
    const cross2 = cross.clone();
    cross2.rotation.z = Math.PI / 2;
    scene.add(cross2);
  }

  // 兵士 — インスタンス化した円盤 + 向きを示すくさび形
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

  // 敵接触マーカー — 実体ではなく「報告された最終目撃位置」を描く(仕様 §5)。
  // 味方の円盤と明確に見分けがつくよう、菱形(4分割の円)で表現する。
  const contactGeo = new THREE.CircleGeometry(SOLDIER_RADIUS * 2.0, 4);
  contactGeo.rotateX(-Math.PI / 2);
  const contactMesh = new THREE.InstancedMesh(
    contactGeo,
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
    MAX_CONTACTS,
  );
  contactMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_CONTACTS * 3),
    3,
  );
  scene.add(contactMesh);

  // 不確度円 — 時間経過とともに拡大する(仕様 §5)。リング状の線で描く。
  const errorRingGeo = new THREE.RingGeometry(0.97, 1.0, 32);
  errorRingGeo.rotateX(-Math.PI / 2);
  const errorRingMesh = new THREE.InstancedMesh(
    errorRingGeo,
    // 多数の円が重なるので、1本1本はごく薄くする。密度そのものが不確かさの表現になる。
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.14, side: THREE.DoubleSide }),
    MAX_CONTACTS,
  );
  errorRingMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_CONTACTS * 3),
    3,
  );
  scene.add(errorRingMesh);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const col2 = new THREE.Color();

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

  function render(world: World, view: ViewResult, alpha: number): void {
    if (world.tick !== lastTick) {
      prev = cur;
      cur = snapshot(world);
      lastTick = world.tick;
    }
    const a = prev === cur ? 1 : alpha;

    // ── 味方 ── 自軍の編成は完全に把握しているので、実体をそのまま描く
    let i = 0;
    for (const s of view.friendly) {
      const p = prev.pos.get(s.id) ?? cur.pos.get(s.id)!;
      const c = cur.pos.get(s.id) ?? p;
      const x = p.x + (c.x - p.x) * a;
      const z = p.z + (c.z - p.z) * a;
      const fx = p.fx + (c.fx - p.fx) * a;
      const fz = p.fz + (c.fz - p.fz) * a;
      const heading = Math.atan2(fx, fz);

      const dead = s.status === "kia";
      dummy.position.set(x, dead ? 0.02 : 0.05, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(dead ? 0.7 : 1);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      discMesh.setMatrixAt(i, dummy.matrix);

      let color =
        s.status === "kia"
          ? KIA_COLOR
          : s.status === "wia"
            ? s.evac === "carrying"
              ? CARRYING_COLOR // 担架搬送中(仕様 §9)
              : s.stabilized
                ? STABILIZED_COLOR // 止血済み: 出血は止まり後送待ち(仕様 §9)
                : WIA_COLOR // 出血中: 45秒以内に手当がなければKIAへ
            : s.bearing !== null
              ? CARRYING_COLOR // 担架要員: 搬送に専念していて射撃できない
              : SIDE_COLOR[s.side];
      if (s.status === "ok" && s.suppressedUntilTick > world.tick) {
        color = col.setHex(color).lerp(col2.setHex(0xe8edf5), 0.55).getHex();
      }
      discMesh.setColorAt(i, col.setHex(color));

      // 向きのくさび形は、まだ戦闘可能な兵士にのみ表示する
      const wedgeScale = s.status === "ok" ? 1 : 0.001;
      dummy.position.set(
        x + Math.sin(heading) * SOLDIER_RADIUS * 1.1,
        0.06,
        z + Math.cos(heading) * SOLDIER_RADIUS * 1.1,
      );
      dummy.rotation.set(0, heading, 0);
      dummy.scale.setScalar(wedgeScale);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      wedgeMesh.setMatrixAt(i, dummy.matrix);

      i++;
    }
    discMesh.count = i;
    wedgeMesh.count = i;
    discMesh.instanceMatrix.needsUpdate = true;
    wedgeMesh.instanceMatrix.needsUpdate = true;
    if (discMesh.instanceColor) discMesh.instanceColor.needsUpdate = true;

    // ── 敵 ── 実体ではなく world picture の接触情報を描く(仕様 §5)。
    // 位置は最終目撃位置であって現在位置ではない。確度が下がるほど薄く、
    // 確度0まで落ちた「最終目撃情報」はグレーのゴーストになる。
    let k = 0;
    for (const e of view.enemies) {
      if (k >= MAX_CONTACTS) break;
      const ghost = e.confidence <= 0;

      dummy.position.set(e.pos.x, 0.045, e.pos.z);
      dummy.rotation.set(0, Math.PI / 4, 0);
      dummy.scale.setScalar(ghost ? 0.75 : 1);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      contactMesh.setMatrixAt(k, dummy.matrix);

      if (ghost) {
        contactMesh.setColorAt(k, col.setHex(GHOST_COLOR));
      } else {
        // 確度が高いほど鮮やかに。低いほど背景側へ寄せる。
        col.setHex(SIDE_COLOR[view.enemySide]);
        col2.setHex(GHOST_COLOR);
        contactMesh.setColorAt(k, col.lerp(col2, 1 - e.confidence));
      }

      // 不確度円(仕様 §5「時間経過とともに不確度範囲(円)が拡大する」)
      const r = Math.max(0.001, e.posError);
      dummy.position.set(e.pos.x, 0.03, e.pos.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(r, 1, r);
      dummy.updateMatrix();
      dummy.scale.setScalar(1);
      errorRingMesh.setMatrixAt(k, dummy.matrix);
      errorRingMesh.setColorAt(k, col.setHex(ghost ? GHOST_COLOR : SIDE_COLOR[view.enemySide]));

      k++;
    }
    contactMesh.count = k;
    errorRingMesh.count = k;
    contactMesh.instanceMatrix.needsUpdate = true;
    errorRingMesh.instanceMatrix.needsUpdate = true;
    if (contactMesh.instanceColor) contactMesh.instanceColor.needsUpdate = true;
    if (errorRingMesh.instanceColor) errorRingMesh.instanceColor.needsUpdate = true;

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

  // ── カメラ操作: ドラッグでパン、ホイールでズーム ──
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
