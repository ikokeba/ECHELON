import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ==== v5仕様 追補3(CASEVAC)のパラメータ ======================================
const BLEED_TIMER_MAX = 45;   // 出血タイマー(秒)
const AID_RADIUS = 2.0;       // 応急手当実行半径(m)
const AID_DURATION = 3.0;     // 応急手当所要時間(秒)
const KIA_RATE = 0.3;         // 被弾時KIA判定確率
// 以下は本検証で決めたい未確定パラメータ(v5には未記載、この場でチューニングする)
const DEFAULT_URGENCY_THRESHOLD = 15; // 出血タイマー残りがこの秒数を切ったら、交戦中でも応急手当へ切替

const COLORS = [0xf59e0b, 0x38bdf8, 0x4ade80, 0xf87171];
const START_POS = [
  { x: -3, z: 0 },
  { x: -1, z: 0 },
  { x: 1, z: 0 },
  { x: 3, z: 0 },
];
const ENEMY_POS = { x: 0, z: 9 };

const STATE_LABEL = {
  healthy: "制圧射撃中",
  moving_to_aid: "応急手当へ移動中",
  aiding: "応急手当実行中",
  wia_bleeding: "負傷(出血中)",
  wia_stabilized: "負傷(安定化済み・後送待ち)",
  kia: "戦闘不能(KIA)",
};

function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

export default function CasevacWiaPrototype() {
  const mountRef = useRef(null);
  const [engaged, setEngaged] = useState(true);
  const [speedMul, setSpeedMul] = useState(1);
  const [threshold, setThreshold] = useState(DEFAULT_URGENCY_THRESHOLD);
  const [unitInfo, setUnitInfo] = useState(START_POS.map(() => ({ state: "healthy", bleed: 0 })));

  const engagedRef = useRef(engaged);
  const speedMulRef = useRef(speedMul);
  const thresholdRef = useRef(threshold);
  const hitRequestRef = useRef([false, false, false, false]);
  const resetRequestRef = useRef(false);

  useEffect(() => { engagedRef.current = engaged; }, [engaged]);
  useEffect(() => { speedMulRef.current = speedMul; }, [speedMul]);
  useEffect(() => { thresholdRef.current = threshold; }, [threshold]);

  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth, height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const CAM_DIV = 30;
    const camera = new THREE.OrthographicCamera(-width / CAM_DIV, width / CAM_DIV, height / CAM_DIV, -height / CAM_DIV, 0.1, 400);
    camera.position.set(0, 40, 14);
    camera.lookAt(0, 0, 4);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshBasicMaterial({ color: 0x1e293b }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    scene.add(new THREE.GridHelper(30, 30, 0x334155, 0x1f2937));

    // 敵(ダミー)
    const enemyMesh = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 4), new THREE.MeshBasicMaterial({ color: 0x94a3b8 }));
    enemyMesh.position.set(ENEMY_POS.x, 0.4, ENEMY_POS.z);
    scene.add(enemyMesh);

    // ユニット
    const unitMeshes = COLORS.map((color) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 16), new THREE.MeshBasicMaterial({ color }));
      body.position.y = 0.25;
      g.add(body);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 24), new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      ring.visible = false;
      g.add(ring);
      const aidCircle = new THREE.Mesh(new THREE.RingGeometry(AID_RADIUS - 0.03, AID_RADIUS, 32), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
      aidCircle.rotation.x = -Math.PI / 2;
      aidCircle.position.y = 0.015;
      aidCircle.visible = false;
      g.add(aidCircle);
      scene.add(g);
      return { g, ring, aidCircle };
    });

    // 制圧射撃ライン・応急手当移動ライン
    const suppressLines = COLORS.map((color) => {
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      scene.add(line);
      return line;
    });
    function setLine(line, ax, az, bx, bz) {
      const arr = new Float32Array([ax, 0.05, az, bx, 0.05, bz]);
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
      line.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      line.visible = true;
    }

    // ==== ユニット状態 ====
    function makeUnit(i) {
      return { i, x: START_POS[i].x, z: START_POS[i].z, state: "healthy", bleed: 0, aidTarget: -1, aidTimer: 0 };
    }
    let units = START_POS.map((_, i) => makeUnit(i));

    function resolveHit(i) {
      const u = units[i];
      if (u.state === "kia" || u.state === "wia_bleeding" || u.state === "wia_stabilized") return;
      if (Math.random() < KIA_RATE) {
        u.state = "kia";
      } else {
        u.state = "wia_bleeding";
        u.bleed = BLEED_TIMER_MAX;
        // 最寄りの健常ユニットを応急手当担当として割当(この場で確定)
        let best = -1, bestD = Infinity;
        units.forEach((o) => {
          if (o.i === i || o.state !== "healthy") return;
          const d = dist(o, u);
          if (d < bestD) { bestD = d; best = o.i; }
        });
        u.assignedAider = best;
      }
    }

    let raf;
    let last = performance.now();
    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dtReal = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dt = dtReal * speedMulRef.current;
      const engagedNow = engagedRef.current;
      const urgency = thresholdRef.current;

      if (resetRequestRef.current) {
        resetRequestRef.current = false;
        units = START_POS.map((_, i) => makeUnit(i));
      }
      hitRequestRef.current.forEach((req, i) => { if (req) { resolveHit(i); hitRequestRef.current[i] = false; } });

      // 出血タイマー進行
      units.forEach((u) => {
        if (u.state === "wia_bleeding") {
          u.bleed -= dt;
          if (u.bleed <= 0) { u.bleed = 0; u.state = "kia"; }
        }
      });

      // 各healthyユニットの行動決定
      units.forEach((u) => {
        if (u.state !== "healthy" && u.state !== "moving_to_aid" && u.state !== "aiding") return;
        // 自分が担当している負傷者を探す
        const wounded = units.find((w) => (w.state === "wia_bleeding") && w.assignedAider === u.i);
        if (!wounded) {
          u.state = "healthy"; u.aidTarget = -1;
          return;
        }
        const shouldAid = !engagedNow || wounded.bleed <= urgency;
        if (!shouldAid) {
          u.state = "healthy"; u.aidTarget = -1;
          return;
        }
        const d = dist(u, wounded);
        if (d > AID_RADIUS - 0.05) {
          u.state = "moving_to_aid"; u.aidTarget = wounded.i;
          const dx = wounded.x - u.x, dz = wounded.z - u.z;
          const dd = Math.hypot(dx, dz) || 1;
          const speed = 2.0;
          const s = Math.min(dd - (AID_RADIUS - 0.1), speed * dt);
          if (s > 0) { u.x += (dx / dd) * s; u.z += (dz / dd) * s; }
        } else {
          if (u.state !== "aiding") { u.state = "aiding"; u.aidTimer = 0; }
          u.aidTimer += dt;
          if (u.aidTimer >= AID_DURATION) {
            wounded.state = "wia_stabilized";
            u.state = "healthy"; u.aidTarget = -1;
          }
        }
      });

      // 描画更新
      const info = units.map((u) => ({ state: u.state, bleed: u.bleed, aider: u.state === "wia_bleeding" ? u.assignedAider : undefined }));
      setUnitInfo(info);

      unitMeshes.forEach(({ g, ring, aidCircle }, i) => {
        const u = units[i];
        g.visible = u.state !== "kia";
        g.position.set(u.x, 0, u.z);
        ring.visible = u.state === "wia_bleeding";
        aidCircle.visible = u.state === "aiding";
        suppressLines[i].visible = false;
        if (u.state === "healthy" && engagedNow) {
          setLine(suppressLines[i], u.x, u.z, ENEMY_POS.x, ENEMY_POS.z);
        } else if (u.state === "moving_to_aid" || u.state === "aiding") {
          const target = units[u.aidTarget];
          if (target) setLine(suppressLines[i], u.x, u.z, target.x, target.z);
        }
      });

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
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>WIA/出血タイマー/バディエイド検証</strong>
        <button
          onClick={() => setEngaged((e) => !e)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: engaged ? "#dc2626" : "#334155", color: "#fff", fontWeight: 600 }}
        >
          交戦中: {engaged ? "ON(制圧射撃継続を優先)" : "OFF(即応急手当)"}
        </button>
        <button
          onClick={() => setSpeedMul((s) => (s === 1 ? 5 : 1))}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155", cursor: "pointer", background: "transparent", color: "#e2e8f0" }}
        >
          デバッグ倍速: ×{speedMul}
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>応急手当切替しきい値(未確定パラメータ):</span>
        <button onClick={() => setThreshold((t) => Math.max(3, t - 3))} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#e2e8f0", cursor: "pointer" }}>−</button>
        <span style={{ fontSize: 13, minWidth: 40, textAlign: "center" }}>{threshold}秒</span>
        <button onClick={() => setThreshold((t) => Math.min(40, t + 3))} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#e2e8f0", cursor: "pointer" }}>＋</button>
        <button
          onClick={() => { resetRequestRef.current = true; }}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155", cursor: "pointer", background: "transparent", color: "#e2e8f0" }}
        >
          リセット
        </button>
      </div>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ padding: "10px 16px", borderTop: "1px solid #1f2937", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
        {unitInfo.map((u, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", minWidth: 150, padding: "6px 10px", borderRadius: 6, background: "#1e293b", border: `1px solid #${COLORS[i].toString(16).padStart(6, "0")}` }}>
            <span style={{ color: `#${COLORS[i].toString(16).padStart(6, "0")}`, fontWeight: 600 }}>隊員{i + 1}</span>
            <span>{STATE_LABEL[u.state]}</span>
            {u.state === "wia_bleeding" && <span>出血タイマー残: {u.bleed.toFixed(1)}秒</span>}
            {u.state !== "healthy" && u.state !== "kia" && u.state !== "wia_bleeding" ? null : null}
            {u.state === "healthy" || u.state === "moving_to_aid" || u.state === "aiding" ? (
              <button
                onClick={() => { hitRequestRef.current[i] = true; }}
                style={{ marginTop: 4, padding: "3px 8px", borderRadius: 4, border: "none", background: "#7f1d1d", color: "#fff", fontSize: 11, cursor: "pointer" }}
              >
                被弾判定(KIA{Math.round(KIA_RATE * 100)}% / WIA{Math.round((1 - KIA_RATE) * 100)}%)
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
