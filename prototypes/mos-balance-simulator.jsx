import React, { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from "recharts";

// ==== v5仕様 追補4(MOS)6.2のパラメータ ========================================
const BASE_SUPPRESS_DURATION = 3.0; // 秒(制圧効果の基準値、本検証での仮定値)
const LETHAL_HIT_CHANCE = 0.015;    // tickごとの命中(排除)確率
const SUPPRESS_CHANCE = 0.04;       // tickごとの制圧(行動不能化)確率
const GRENADE_USE_CHANCE = 0.01;    // tickごとの擲弾使用試行確率(残弾がある場合)
const DT = 0.2;                     // 秒/tick
const MAX_TICKS = 4000;             // 800秒相当の安全上限

// このMOS戦力バランス検証で確定させたいパラメータ(調整可能)
function makeParams(sawMul, grenadeCharges, grenadeSuccess) {
  return { sawMul, grenadeCharges, grenadeSuccess };
}

function makeBaselineTeam() {
  return [0, 1, 2, 3].map(() => ({ role: "rifleman", alive: true, suppressedUntil: 0 }));
}
function makeMosTeam(grenadeCharges) {
  return [
    { role: "leader", alive: true, suppressedUntil: 0 },
    { role: "saw", alive: true, suppressedUntil: 0 },
    { role: "grenadier", alive: true, suppressedUntil: 0, charges: grenadeCharges },
    { role: "rifleman", alive: true, suppressedUntil: 0 }, // CLS(衛生兼任)は戦闘性能同一のため区別なし
  ];
}

function pickRandomAlive(team, excludeIdx = -1) {
  const idxs = team.map((_, i) => i).filter((i) => i !== excludeIdx && team[i].alive);
  if (idxs.length === 0) return -1;
  return idxs[Math.floor(Math.random() * idxs.length)];
}

function simulateBattle(compA, compB, params) {
  const A = compA.map((u) => ({ ...u }));
  const B = compB.map((u) => ({ ...u }));
  let t = 0;
  let grenadeKillsB = 0, grenadeKillsA = 0;

  function tickTeam(self, enemy, isBSide) {
    self.forEach((u, i) => {
      if (!u.alive) return;
      if (u.suppressedUntil > t) return; // 制圧されて行動不能

      // 擲弾手: 残弾があれば低確率で使用、成功すれば遮蔽無視で確定排除
      if (u.role === "grenadier" && u.charges > 0 && Math.random() < GRENADE_USE_CHANCE) {
        u.charges -= 1;
        if (Math.random() < params.grenadeSuccess) {
          const tgt = pickRandomAlive(enemy);
          if (tgt !== -1) {
            enemy[tgt].alive = false;
            if (isBSide) grenadeKillsB++; else grenadeKillsA++;
          }
        }
        return; // このtickは擲弾行動のみ
      }

      // 通常射撃: 排除判定
      if (Math.random() < LETHAL_HIT_CHANCE) {
        const tgt = pickRandomAlive(enemy);
        if (tgt !== -1) enemy[tgt].alive = false;
      }
      // 制圧判定
      if (Math.random() < SUPPRESS_CHANCE) {
        const tgt = pickRandomAlive(enemy);
        if (tgt !== -1) {
          const mul = u.role === "saw" ? params.sawMul : 1.0;
          enemy[tgt].suppressedUntil = t + BASE_SUPPRESS_DURATION * mul;
        }
      }
    });
  }

  while (t < MAX_TICKS * DT) {
    if (Math.random() < 0.5) { tickTeam(A, B, false); tickTeam(B, A, true); }
    else { tickTeam(B, A, true); tickTeam(A, B, false); }
    t += DT;
    const aliveA = A.some((u) => u.alive);
    const aliveB = B.some((u) => u.alive);
    if (!aliveA || !aliveB) {
      return {
        winner: aliveA && !aliveB ? "A" : !aliveA && aliveB ? "B" : "draw",
        duration: t,
        survivorsA: A.filter((u) => u.alive).length,
        survivorsB: B.filter((u) => u.alive).length,
        grenadeKillsA, grenadeKillsB,
      };
    }
  }
  return { winner: "draw", duration: t, survivorsA: A.filter((u) => u.alive).length, survivorsB: B.filter((u) => u.alive).length, grenadeKillsA, grenadeKillsB };
}

function runBatch(n, compAFactory, compBFactory, params) {
  let winA = 0, winB = 0, draw = 0, durSum = 0, survWinnerSum = 0, grenadeKillsSum = 0;
  for (let i = 0; i < n; i++) {
    const res = simulateBattle(compAFactory(), compBFactory(), params);
    if (res.winner === "A") { winA++; survWinnerSum += res.survivorsA; }
    else if (res.winner === "B") { winB++; survWinnerSum += res.survivorsB; }
    else draw++;
    durSum += res.duration;
    grenadeKillsSum += res.grenadeKillsA; // MOS編成は常にcompA側(呼び出し元のfactory順)に配置される
  }
  return {
    winRateA: (winA / n) * 100,
    winRateB: (winB / n) * 100,
    drawRate: (draw / n) * 100,
    avgDuration: durSum / n,
    avgSurvivorsOfWinner: survWinnerSum / (winA + winB || 1),
    avgGrenadeKillsB: grenadeKillsSum / n,
  };
}

export default function MosBalanceSimulator() {
  const [n, setN] = useState(1000);
  const [sawMul, setSawMul] = useState(1.5);
  const [grenadeCharges, setGrenadeCharges] = useState(3);
  const [grenadeSuccess, setGrenadeSuccess] = useState(0.85);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);

  function runAll() {
    setRunning(true);
    setTimeout(() => {
      const params = makeParams(sawMul, grenadeCharges, grenadeSuccess);
      const control = runBatch(n, makeBaselineTeam, makeBaselineTeam, params); // 対照実験: 均一編成同士
      const mosVsBase = runBatch(n, () => makeMosTeam(grenadeCharges), makeBaselineTeam, params); // A=MOS, B=均一
      const mosVsMos = runBatch(n, () => makeMosTeam(grenadeCharges), () => makeMosTeam(grenadeCharges), params); // 両者MOS
      setResults({ control, mosVsBase, mosVsMos });
      setRunning(false);
    }, 30);
  }

  const chartData = results ? [
    { name: "対照実験\n(均一4v4)", A勝率: results.control.winRateA, B勝率: results.control.winRateB },
    { name: "MOS vs 均一\n(A=MOS)", A勝率: results.mosVsBase.winRateA, B勝率: results.mosVsBase.winRateB },
    { name: "MOS vs MOS", A勝率: results.mosVsMos.winRateA, B勝率: results.mosVsMos.winRateB },
  ] : [];

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", fontFamily: "system-ui, sans-serif", padding: 20, boxSizing: "border-box" }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>MOS戦力バランス検証(モンテカルロ・シミュレーション)</h2>
      <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 0, marginBottom: 16 }}>
        4v4・CASEVAC層は分離(被弾=即排除)。SAWの制圧倍率と擲弾手の遮蔽越え性能を変えて、対照実験(均一4v4)/MOS vs 均一/MOS vs MOSの3パターンの勝率を比較する。
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 16, padding: 12, background: "#1e293b", borderRadius: 8 }}>
        <label style={{ fontSize: 12 }}>試行回数:
          <select value={n} onChange={(e) => setN(Number(e.target.value))} style={{ marginLeft: 6, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4 }}>
            <option value={200}>200</option>
            <option value={1000}>1000</option>
            <option value={3000}>3000</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>SAW制圧倍率:
          <input type="number" step="0.1" value={sawMul} onChange={(e) => setSawMul(Number(e.target.value))} style={{ marginLeft: 6, width: 60, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4 }} />
        </label>
        <label style={{ fontSize: 12 }}>擲弾使用回数上限:
          <input type="number" value={grenadeCharges} onChange={(e) => setGrenadeCharges(Number(e.target.value))} style={{ marginLeft: 6, width: 50, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4 }} />
        </label>
        <label style={{ fontSize: 12 }}>擲弾成功率:
          <input type="number" step="0.05" value={grenadeSuccess} onChange={(e) => setGrenadeSuccess(Number(e.target.value))} style={{ marginLeft: 6, width: 60, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4 }} />
        </label>
        <button onClick={runAll} disabled={running} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: running ? "#334155" : "#dc2626", color: "#fff", fontWeight: 600, cursor: running ? "default" : "pointer" }}>
          {running ? "実行中..." : `${n}戦 × 3パターン 実行`}
        </button>
      </div>

      {results && (
        <>
          <div style={{ height: 260, background: "#1e293b", borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} unit="%" />
                <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="A勝率" fill="#f59e0b" />
                <Bar dataKey="B勝率" fill="#38bdf8" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, fontSize: 12 }}>
            <div style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
              <strong>① 対照実験(均一4v4、A=B)</strong>
              <div>A勝率: {results.control.winRateA.toFixed(1)}% / B勝率: {results.control.winRateB.toFixed(1)}%</div>
              <div style={{ color: "#94a3b8" }}>シミュレータ自体のバイアス確認用。50%前後なら健全</div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
              <strong>② MOS(A) vs 均一(B)</strong>
              <div>A(MOS)勝率: {results.mosVsBase.winRateA.toFixed(1)}% / B(均一)勝率: {results.mosVsBase.winRateB.toFixed(1)}%</div>
              <div>勝利側の平均生存者数: {results.mosVsBase.avgSurvivorsOfWinner.toFixed(2)}名</div>
              <div style={{ color: "#fbbf24" }}>擲弾手の平均排除貢献数(A側): {results.mosVsBase.avgGrenadeKillsB.toFixed(2)}体/戦</div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 8, padding: 12 }}>
              <strong>③ MOS vs MOS(双方MOS編成)</strong>
              <div>A勝率: {results.mosVsMos.winRateA.toFixed(1)}% / B勝率: {results.mosVsMos.winRateB.toFixed(1)}%</div>
              <div style={{ color: "#94a3b8" }}>編成が対称なら50%前後が妥当</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
