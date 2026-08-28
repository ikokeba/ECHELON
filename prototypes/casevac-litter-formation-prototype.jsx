import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ==== v5仕様 追補3(CASEVAC)5.3のパラメータ ====================================
const CARRY_SPEED_MUL = { 2: 0.5, 4: 0.85 }; // ドクトリン準拠: 2名(緊急・近距離)/4名(標準・四隅担架法)
const LEADER_SPEED = 2.4;   // 通常時の分隊移動速度

// ==== 隊形オフセット(既存squadモックのくさび形パターンを踏襲) ==================
const ESCORT_OFFSETS = [
  { x: -1.6, z: -1.9 },
  { x: -1.6, z: 1.9 },
];
const LITTER_ANCHOR = { x: -3.4, z: 0 }; // 担架班の隊列内アンカー位置(リーダー基準)

function rotate(off, dir) {
  // dir = (dx, dz) 正規化済み前進方向。オフセットは前進方向基準のローカル座標。
  const fx = dir.x, fz = dir.z;
  const rx = -fz, rz = fx; // 右方向
  return { x: off.x * fx + off.z * rx, z: off.x * fz + off.z * rz };
}

export default function CasevacFormationPrototype() {
  const mountRef = useRef(null);
  const [litterSize, setLitterSize] = useState(4);
  const [matchToLitter, setMatchToLitter] = useState(true);
  const [readout, setReadout] = useState({ speed: 0, drift: 0 });

  const litterSizeRef = useRef(litterSize);
  const matchRef = useRef(matchToLitter);
  const destRef = useRef({ x: 6, z: 4 });

  useEffect(() => { litterSizeRef.current = litterSize; }, [litterSize]);
  useEffect(() => { matchRef.current = matchToLitter; }, [matchToLitter]);

  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth, height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const CAM_DIV = 26;
    const camera = new THREE.OrthographicCamera(-width / CAM_DIV, width / CAM_DIV, height / CAM_DIV, -height / CAM_DIV, 0.1, 400);
    camera.position.set(0, 40, 20);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x1e293b }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    scene.add(new THREE.GridHelper(40, 40, 0x334155, 0x1f2937));

    // 目的地マーカー
    const destMesh = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 24), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
    destMesh.rotation.x = -Math.PI / 2;
    destMesh.position.set(destRef.current.x, 0.02, destRef.current.z);
    scene.add(destMesh);

    // クリックで目的地変更
    const raycaster = new THREE.Raycaster();
    const mouseVec = new THREE.Vector2();
    function onClick(ev) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouseVec.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouseVec.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouseVec, camera);
      const hit = raycaster.intersectObject(ground)[0];
      if (hit) {
        destRef.current = { x: hit.point.x, z: hit.point.z };
        destMesh.position.set(hit.point.x, 0.02, hit.point.z);
      }
    }
    renderer.domElement.addEventListener("pointerdown", onClick);

    // リーダー
    function makeMarker(color, size) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(size, size, 0.5, 16), new THREE.MeshBasicMaterial({ color }));
      body.position.y = 0.25;
      g.add(body);
      scene.add(g);
      return g;
    }
    const leaderMesh = makeMarker(0xfbbf24, 0.34);
    const escortMeshes = [makeMarker(0x38bdf8, 0.28), makeMarker(0x38bdf8, 0.28)];
    const litterMeshes = [0, 1, 2, 3].map(() => makeMarker(0x4ade80, 0.24));
    const woundedMesh = makeMarker(0xf87171, 0.22);

    // 隊列アンカーとの距離を示すライン(担架班)
    const driftLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf87171 }));
    scene.add(driftLine);

    // ==== 状態 ====
    let leader = { x: -8, z: -4, dir: { x: 1, z: 0 } };
    let escorts = ESCORT_OFFSETS.map(() => ({ x: leader.x, z: leader.z }));
    let litterAnchorPos = { x: leader.x + LITTER_ANCHOR.x, z: leader.z };
    let litters = [0, 1, 2, 3].map((i) => ({ x: leader.x - 3 - i * 0.1, z: leader.z }));

    let raf;
    let last = performance.now();
    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const size = litterSizeRef.current;
      const carrySpeed = LEADER_SPEED * CARRY_SPEED_MUL[size];
      const leaderSpeed = matchRef.current ? Math.min(LEADER_SPEED, carrySpeed) : LEADER_SPEED;

      // リーダー移動
      const dest = destRef.current;
      const dx = dest.x - leader.x, dz = dest.z - leader.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const s = Math.min(d, leaderSpeed * dt);
        leader.x += (dx / d) * s; leader.z += (dz / d) * s;
        leader.dir = { x: dx / d, z: dz / d };
      }

      // エスコートは隊形オフセットへ通常速度で追従(常に間に合う速度を持つ)
      escorts = escorts.map((e, i) => {
        const target = { x: leader.x + rotate(ESCORT_OFFSETS[i], leader.dir).x, z: leader.z + rotate(ESCORT_OFFSETS[i], leader.dir).z };
        const edx = target.x - e.x, edz = target.z - e.z;
        const ed = Math.hypot(edx, edz);
        if (ed < 0.02) return target;
        const s = Math.min(ed, LEADER_SPEED * dt);
        return { x: e.x + (edx / ed) * s, z: e.z + (edz / ed) * s };
      });

      // 担架班の隊列アンカー(リーダー基準)
      litterAnchorPos = { x: leader.x + rotate(LITTER_ANCHOR, leader.dir).x, z: leader.z + rotate(LITTER_ANCHOR, leader.dir).z };

      // 担架要員は搬送速度(carrySpeed)でしか移動できない → matchToLitterがOFFだと隊列アンカーへ追いつけず遅れが発生
      litters = litters.map((u, i) => {
        if (i >= size) return u; // 不使用スロットは非表示
        const side = i % 2 === 0 ? -1 : 1;
        const rowOff = Math.floor(i / 2) * 0.5;
        const localOff = { x: LITTER_ANCHOR.x - rowOff, z: side * 0.35 };
        const target = { x: leader.x + rotate(localOff, leader.dir).x, z: leader.z + rotate(localOff, leader.dir).z };
        const udx = target.x - u.x, udz = target.z - u.z;
        const ud = Math.hypot(udx, udz);
        if (ud < 0.02) return target;
        const s = Math.min(ud, carrySpeed * dt);
        return { x: u.x + (udx / ud) * s, z: u.z + (udz / ud) * s };
      });

      // 負傷者(担架上、使用中の担架要員の重心に追従)
      const activeLitters = litters.slice(0, size);
      const woundedPos = {
        x: activeLitters.reduce((s, u) => s + u.x, 0) / size,
        z: activeLitters.reduce((s, u) => s + u.z, 0) / size,
      };

      // ドリフト量(隊列アンカーと実際の担架班重心の距離)= 隊形から遅れている距離
      const drift = Math.hypot(litterAnchorPos.x - woundedPos.x, litterAnchorPos.z - woundedPos.z);
      setReadout({ speed: leaderSpeed.toFixed(2), drift: drift.toFixed(2) });

      leaderMesh.position.set(leader.x, 0, leader.z);
      escortMeshes.forEach((m, i) => m.position.set(escorts[i].x, 0, escorts[i].z));
      litterMeshes.forEach((m, i) => { m.visible = i < size; if (i < size) m.position.set(litters[i].x, 0, litters[i].z); });
      woundedMesh.position.set(woundedPos.x, 0, woundedPos.z);

      const arr = new Float32Array([litterAnchorPos.x, 0.03, litterAnchorPos.z, woundedPos.x, 0.03, woundedPos.z]);
      driftLine.geometry.dispose();
      driftLine.geometry = new THREE.BufferGeometry();
      driftLine.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));

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
      renderer.domElement.removeEventListener("pointerdown", onClick);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", background: "#0f172a", fontFamily: "system-ui, sans-serif", color: "#e2e8f0" }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>担架搬送と隊形維持の両立検証</strong>
        <button
          onClick={() => setMatchToLitter((v) => !v)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: matchToLitter ? "#16a34a" : "#dc2626", color: "#fff", fontWeight: 600 }}
        >
          全体速度を担架班に合わせる: {matchToLitter ? "ON" : "OFF(検証比較用)"}
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>担架人数:</span>
        {[2, 4].map((n) => (
          <button
            key={n}
            onClick={() => setLitterSize(n)}
            style={{ padding: "5px 10px", borderRadius: 6, border: litterSize === n ? "none" : "1px solid #334155", background: litterSize === n ? "#38bdf8" : "transparent", color: litterSize === n ? "#0f172a" : "#e2e8f0", cursor: "pointer", fontWeight: 600 }}
          >
            {n}名(×{CARRY_SPEED_MUL[n]})
          </button>
        ))}
        <span style={{ fontSize: 12, color: "#94a3b8" }}>地面クリックでリーダーの目的地を指定</span>
      </div>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ padding: "8px 16px", borderTop: "1px solid #1f2937", display: "flex", gap: 24, fontSize: 12 }}>
        <span>分隊移動速度: {readout.speed} (通常{LEADER_SPEED})</span>
        <span style={{ color: Number(readout.drift) > 1.0 ? "#f87171" : "#4ade80" }}>担架班の隊列からの遅れ距離: {readout.drift}m</span>
      </div>
    </div>
  );
}
