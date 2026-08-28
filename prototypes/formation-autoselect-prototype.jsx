import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ==== 通路区画: 4段階の幅を連続して配置(x範囲ごとにhalfWidthが変わる) =========
const SEGMENTS = [
  { x0: -17, x1: -12.5, halfWidth: 1.0 },  // Tier1 幅2.0m(極狭)
  { x0: -12.5, x1: -8, halfWidth: 1.6 },   // Tier2 幅3.2m(狭)
  { x0: -8, x1: -3.5, halfWidth: 2.6 },    // Tier3 幅5.2m(中)
  { x0: -3.5, x1: 6, halfWidth: 4.2 },     // Tier4 幅8.4m(広/開豁地)
];
const OPEN_BOUND = 8; // 区画外(開豁地)のデフォルト半幅

function getHalfWidthAtX(x) {
  const seg = SEGMENTS.find((s) => x >= s.x0 && x <= s.x1);
  return seg ? seg.halfWidth : OPEN_BOUND;
}

// ==== 隊形階層: 4段階の通路幅にそれぞれ対応(全オフセットは前後 or 左右の片軸のみ、斜め配置なし) ====
const SAFETY_MARGIN = 0.45; // 壁からの最低離隔距離
const TIER_THRESHOLDS = [2.2, 4.0, 6.5]; // 幅がこれ未満ならそのTierを採用(4段階)
const TIERS = [
  { key: "t1", label: "Tier1: 密集縦隊(幅<2.2m)", offsets: [{ x: 0, z: 0 }, { x: -1.0, z: 0 }, { x: -2.0, z: 0 }, { x: -3.0, z: 0 }] },
  { key: "t2", label: "Tier2: 縦隊(幅2.2〜4.0m)", offsets: [{ x: 0, z: 0 }, { x: -1.6, z: 0 }, { x: -3.2, z: 0 }, { x: -4.8, z: 0 }] },
  { key: "t3", label: "Tier3: 分散隊形・側面確保(幅4.0〜6.5m)", offsets: [{ x: 0, z: 0 }, { x: 0, z: -1.3 }, { x: -1.6, z: 0 }, { x: 0, z: 1.3 }] },
  { key: "t4", label: "Tier4: 横隊(幅6.5m以上)", offsets: [{ x: 0, z: 0 }, { x: 0, z: -1.8 }, { x: 0, z: 1.8 }, { x: 0, z: 3.6 }] },
];
function decideTier(width) {
  if (width < TIER_THRESHOLDS[0]) return TIERS[0];
  if (width < TIER_THRESHOLDS[1]) return TIERS[1];
  if (width < TIER_THRESHOLDS[2]) return TIERS[2];
  return TIERS[3];
}

const COLORS = [0xfbbf24, 0x38bdf8, 0x4ade80, 0xf87171];

function rotate(off, dir) {
  const fx = dir.x, fz = dir.z;
  const rx = -fz, rz = fx;
  return { x: off.x * fx + off.z * rx, z: off.x * fz + off.z * rz };
}

export default function FormationAutoSelectPrototype() {
  const mountRef = useRef(null);
  const [hug, setHug] = useState(false);
  const [tierLabel, setTierLabel] = useState(TIERS[3].label);
  const [width, setWidth] = useState(16);
  const [clampedCount, setClampedCount] = useState(0);

  const hugRef = useRef(hug);
  useEffect(() => { hugRef.current = hug; }, [hug]);

  useEffect(() => {
    const mount = mountRef.current;
    const w0 = mount.clientWidth, h0 = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const CAM_DIV = 20;
    const camera = new THREE.OrthographicCamera(-w0 / CAM_DIV, w0 / CAM_DIV, h0 / CAM_DIV, -h0 / CAM_DIV, 0.1, 400);
    camera.position.set(0, 50, 6);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w0, h0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(50, 20), new THREE.MeshBasicMaterial({ color: 0x1e293b }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    scene.add(new THREE.GridHelper(50, 50, 0x334155, 0x1f2937));

    // 壁描画(区画ごとに南北の壁)
    SEGMENTS.forEach((s) => {
      const cx = (s.x0 + s.x1) / 2, hw = (s.x1 - s.x0) / 2;
      [s.halfWidth, -s.halfWidth].forEach((cz) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 0.2, 1.4, 0.3), new THREE.MeshBasicMaterial({ color: 0x64748b }));
        mesh.position.set(cx, 0.7, cz);
        scene.add(mesh);
      });
    });

    const unitMeshes = COLORS.map((color, i) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(i === 0 ? 0.34 : 0.28, i === 0 ? 0.34 : 0.28, 0.5, 16), new THREE.MeshBasicMaterial({ color }));
      body.position.y = 0.25;
      g.add(body);
      scene.add(g);
      return g;
    });

    let leader = { x: SEGMENTS[0].x0 - 1, z: 0 };
    let dir = { x: 1, z: 0 };
    let followers = [0, 1, 2].map(() => ({ x: leader.x, z: leader.z }));

    let raf;
    let last = performance.now();
    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // リーダーはx方向に往復移動。z方向は「中央」か「端寄り」かをHugトグルで決定
      const speed = 1.6;
      leader.x += dir.x * speed * dt;
      const minX = SEGMENTS[0].x0 - 1, maxX = SEGMENTS[SEGMENTS.length - 1].x1 + 1;
      if (leader.x > maxX) { leader.x = maxX; dir.x = -1; }
      if (leader.x < minX) { leader.x = minX; dir.x = 1; }

      const hw = getHalfWidthAtX(leader.x);
      const hugTargetZ = Math.min(hw - SAFETY_MARGIN, 3.0); // 開豁地でも寄りすぎない上限
      const targetZ = hugRef.current ? hugTargetZ : 0;
      leader.z += (targetZ - leader.z) * Math.min(1, dt * 2.0);
      leader.z = Math.max(-hw + SAFETY_MARGIN, Math.min(hw - SAFETY_MARGIN, leader.z));

      const width2 = hw * 2;
      const tier = decideTier(width2);
      setWidth(width2);
      setTierLabel(tier.label);

      // 各隊員の目標位置を計算し、壁から安全マージンを保つようクランプ
      let clampCnt = 0;
      followers = followers.map((f, idx) => {
        const off = tier.offsets[idx + 1];
        const rel = rotate(off, dir);
        let tx = leader.x + rel.x, tz = leader.z + rel.z;
        const localHw = getHalfWidthAtX(tx);
        const zMin = -localHw + SAFETY_MARGIN, zMax = localHw - SAFETY_MARGIN;
        if (tz < zMin) { tz = zMin; clampCnt++; }
        if (tz > zMax) { tz = zMax; clampCnt++; }
        const fdx = tx - f.x, fdz = tz - f.z;
        const fd = Math.hypot(fdx, fdz);
        if (fd < 0.02) return { x: tx, z: tz };
        const s = Math.min(fd, 2.4 * dt);
        return { x: f.x + (fdx / fd) * s, z: f.z + (fdz / fd) * s };
      });
      setClampedCount(clampCnt);

      unitMeshes[0].position.set(leader.x, 0, leader.z);
      followers.forEach((f, i) => unitMeshes[i + 1].position.set(f.x, 0, f.z));

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
        <strong style={{ fontSize: 14 }}>隊形パターン自動選択(4段階通路幅)検証</strong>
        <span style={{ fontSize: 13, padding: "3px 10px", borderRadius: 6, background: "#1e293b", color: "#fbbf24" }}>{tierLabel}</span>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>通路幅: {width.toFixed(1)}m</span>
        <span style={{ fontSize: 12, color: clampedCount > 0 ? "#f87171" : "#4ade80" }}>壁面クランプ発動中の隊員数: {clampedCount}</span>
        <button
          onClick={() => setHug((h) => !h)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: hug ? "#dc2626" : "#334155", color: "#fff", fontWeight: 600 }}
        >
          リーダーの進行位置: {hug ? "端寄り" : "中央"}
        </button>
      </div>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ padding: "8px 16px", borderTop: "1px solid #1f2937", fontSize: 12, color: "#94a3b8" }}>
        全隊形とも各隊員のオフセットは前後方向または左右方向いずれか片軸のみ(斜め配置なし)。壁から{SAFETY_MARGIN}m以内に入りそうな場合は自動でオフセットをクランプし、隊員が壁にめり込まないようにしています。「端寄り」に切り替えて、リーダーが壁際を歩いた時に反対側の隊員がどう安全マージンを保つか確認できます。
      </div>
    </div>
  );
}
