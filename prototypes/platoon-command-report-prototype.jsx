import React, { useState, useRef, useEffect, useCallback } from "react";

/**
 * 小隊長レベル 検証プロトタイプ (v2)
 * ----------------------------------------------------------------
 * 検証対象(仕様書 第5章・第6章 / 未着手だった小隊以上のロジック):
 *   1) 複数分隊への機動技術の同時指示(前進 / 警戒前進 / 躍進前進)
 *   2) 躍進前進のペア運用(支援射撃距離を超えて躍進しない制約)
 *   3) 報告確度減衰(30秒80% / 90秒50% / 180秒で消滅、時間経過のみがトリガー)
 *   4) 分隊同士の物理的な重なり回避
 *   5) 統制手段(CP/PL/OBJ)ベースの命令、SALUTE形式の報告(ドクトリン準拠)
 *
 * 分隊内部(FTリーダー〜一兵卒)のロジックは検証済みのため、本モックでは
 * 分隊を1つの抽象マーカーとして扱う(個々の兵士描画はしない)。
 *
 * ---- マーカーの意味 ----
 * ・分隊マーカー = 分隊長の位置。分隊内部の隊列(FT配置)は分隊長を基準に
 *   整列される(第6章の隊形Tier)ため、この抽象化は分隊レベル実装と整合する。
 * ・目標地点 = 自由座標ではなく、事前に定義された統制手段(CP/PL/OBJ)。
 *   実際の小隊長が座標を自由指定するのではなく統制線・チェックポイント・
 *   目標を参照して命令を出す運用に合わせた。
 */

// ---------- 定数(仕様書の確定値) ----------
const MAP_W = 900;
const MAP_H = 560;

const TECH = {
  TRAVELING: "traveling",
  OVERWATCH: "traveling_overwatch",
  BOUNDING: "bounding_overwatch",
};

const TECH_LABEL = {
  [TECH.TRAVELING]: "前進 (Traveling)",
  [TECH.OVERWATCH]: "警戒前進 (Traveling Overwatch)",
  [TECH.BOUNDING]: "躍進前進 (Bounding Overwatch)",
};

const SPEED = {
  [TECH.TRAVELING]: 90,
  [TECH.OVERWATCH]: 60,
  [TECH.BOUNDING]: 70,
};

const SUPPORT_RANGE = 170; // px。躍進側が警戒側の支援射撃範囲を超えられない距離(表示用)
const TRAIL_DISTANCE = 130; // px。警戒前進で後続分隊が先頭分隊から保つ距離
const BOUND_STEP = 85; // px。躍進1回分の距離(短めにして交互の切り替えを多く見せる)
const BOUND_SPEED = 55; // px/s。躍進前進の移動速度(ゆっくりにして動きを追いやすくする)
const BOUND_HOLD_SECONDS = 1.4; // 秒。躍進の区間に到達してから交代するまでの明示的な静止(警戒)時間
const DETECT_RADIUS = 60; // 分隊が敵配置に接近して発見する半径
const REPORT_FADE_TOTAL = 180; // 秒。報告確度が0になるまでの時間

const SQUAD_RADIUS = 12;
const MIN_SEPARATION = SQUAD_RADIUS * 2 + 4; // 分隊同士の最小離隔

const SQUAD_COLORS = ["#3b82f6", "#22c55e", "#f59e0b"];

// 統制手段(CP/PL/OBJ)。小隊長はこれらを参照して命令を出す。
const CONTROL_POINTS = [
  { id: "CP-1", label: "CP-1", x: 300, y: 90, kind: "checkpoint" },
  { id: "CP-2", label: "CP-2", x: 540, y: 210, kind: "checkpoint" },
  { id: "PL-BLUE", label: "PL BLUE", x: 430, y: 400, kind: "phaseline" },
  { id: "OBJ-RAVEN", label: "OBJ RAVEN", x: 770, y: 300, kind: "objective" },
];
const CP_CLICK_TOLERANCE = 22;

// 敵の配置(小隊長には見えない。分隊が接近して初めて「発見」→SALUTE報告が上がる)
// いずれかの統制手段(CP)の近傍(発見半径 DETECT_RADIUS 内)に配置し、
// そこへ前進命令を出せば必ず発見できるようにしている。
const ENEMY_SPOTS = [
  { id: "e1", x: 565, y: 235 }, // CP-2(540,210)の近傍
  { id: "e2", x: 745, y: 335 }, // OBJ-RAVEN(770,300)の近傍
  { id: "e3", x: 455, y: 425 }, // PL-BLUE(430,400)の近傍
];

const SALUTE_SIZE = ["2〜3名", "4〜5名", "分隊規模(8〜10名)"];
const SALUTE_ACTIVITY = ["静止・警戒中", "移動中", "陣地構築中の様子"];
const SALUTE_EQUIP = ["小火器のみ確認", "装備不明", "対戦車火器らしき装備を確認"];

// 報告確度: 時間(秒)→ 確信度(0〜1)。仕様書5章の確定値をそのまま実装。
function confidenceAt(elapsedSec) {
  if (elapsedSec <= 30) return 1 - (0.2 * elapsedSec) / 30;
  if (elapsedSec <= 90) return 0.8 - (0.3 * (elapsedSec - 30)) / 60;
  if (elapsedSec <= 180) return 0.5 - (0.5 * (elapsedSec - 90)) / 90;
  return 0;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeInitialSquads() {
  return [
    { id: "A", name: "1分隊", x: 80, y: 120, color: SQUAD_COLORS[0], technique: TECH.TRAVELING, waypoint: null, waypointLabel: null, boundPairId: null, boundRole: null, boundHoldTimer: null, overwatchRole: null, overwatchLeadId: null },
    { id: "B", name: "2分隊", x: 80, y: 280, color: SQUAD_COLORS[1], technique: TECH.TRAVELING, waypoint: null, waypointLabel: null, boundPairId: null, boundRole: null, boundHoldTimer: null, overwatchRole: null, overwatchLeadId: null },
    { id: "C", name: "3分隊", x: 80, y: 440, color: SQUAD_COLORS[2], technique: TECH.TRAVELING, waypoint: null, waypointLabel: null, boundPairId: null, boundRole: null, boundHoldTimer: null, overwatchRole: null, overwatchLeadId: null },
  ];
}

export default function PlatoonCommandPrototype() {
  const [squads, setSquads] = useState(makeInitialSquads);
  const [reports, setReports] = useState([]); // {id, squadId, x, y, spottedAt, size, activity, equipment, cpRef}
  const [selectedIds, setSelectedIds] = useState([]);
  const [pendingTechnique, setPendingTechnique] = useState(TECH.TRAVELING);
  const [now, setNow] = useState(0);
  const [running, setRunning] = useState(true);
  const [log, setLog] = useState([]);
  const detectedSetRef = useRef(new Set());

  const pushLog = useCallback((msg) => {
    setLog((prev) => [{ t: Date.now(), msg }, ...prev].slice(0, 7));
  }, []);

  const queueSwapLog = useCallback((newMoverName, newCoveringName) => {
    pushLog(`躍進前進: ${newMoverName}が前進開始 / ${newCoveringName}が警戒に切替`);
  }, [pushLog]);

  // ---------- メインループ ----------
  useEffect(() => {
    if (!running) return;
    let raf;
    let last = performance.now();

    const tick = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      setNow((n) => n + dt);

      setSquads((prevSquads) => {
        const next = prevSquads.map((s) => ({ ...s }));
        const byId = Object.fromEntries(next.map((s) => [s.id, s]));

        for (const s of next) {
          if (!s.waypoint && !(s.technique === TECH.OVERWATCH && s.overwatchRole === "trail")) continue;
          if (s.technique === TECH.TRAVELING) {
            moveToward(s, s.waypoint, SPEED[TECH.TRAVELING] * dt);
          } else if (s.technique === TECH.OVERWATCH) {
            if (s.overwatchRole === "trail" && s.overwatchLeadId && byId[s.overwatchLeadId]) {
              handleOverwatchTrail(s, byId[s.overwatchLeadId], dt);
            } else if (s.overwatchRole === "lead") {
              moveToward(s, s.waypoint, SPEED[TECH.OVERWATCH] * dt);
            }
          } else if (s.technique === TECH.BOUNDING && s.boundPairId && byId[s.boundPairId]) {
            handleBounding(s, byId[s.boundPairId], dt);
          }
        }

        applySeparation(next);
        return next;
      });

      // 敵発見判定 → SALUTE報告生成
      setSquads((currentSquads) => {
        currentSquads.forEach((s) => {
          ENEMY_SPOTS.forEach((e) => {
            const key = `${s.id}:${e.id}`;
            if (dist(s, e) < DETECT_RADIUS && !detectedSetRef.current.has(key)) {
              detectedSetRef.current.add(key);
              const reportId = `${key}:${Math.round(now)}`;
              const nearestCp = CONTROL_POINTS.reduce((best, cp) =>
                dist(cp, e) < dist(best, e) ? cp : best, CONTROL_POINTS[0]);
              setReports((prev) => [
                ...prev,
                {
                  id: reportId,
                  squadId: s.id,
                  x: e.x,
                  y: e.y,
                  spottedAt: now,
                  size: pickRandom(SALUTE_SIZE),
                  activity: pickRandom(SALUTE_ACTIVITY),
                  equipment: pickRandom(SALUTE_EQUIP),
                  cpRef: nearestCp.label,
                },
              ]);
              pushLog(`${s.name}が接触を報告(${nearestCp.label}付近)`);
              setTimeout(() => detectedSetRef.current.delete(key), REPORT_FADE_TOTAL * 1000);
            }
          });
        });
        return currentSquads;
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    setReports((prev) => prev.filter((r) => confidenceAt(now - r.spottedAt) > 0));
  }, [now]);

  function moveToward(unit, target, maxStep) {
    const d = dist(unit, target);
    if (d < 2) return;
    const step = Math.min(maxStep, d);
    unit.x += ((target.x - unit.x) / d) * step;
    unit.y += ((target.y - unit.y) / d) * step;
  }

  // 躍進1回分の目標: 「現在の警戒側の位置」から最終目標方向へ BOUND_STEP だけ進んだ点。
  // 警戒側の位置を基準に毎回再計算するため、役割交代のたびに躍進側が警戒側を追い越していく。
  function computeBoundTarget(coveringPos, finalWaypoint) {
    const d = dist(coveringPos, finalWaypoint);
    if (d <= BOUND_STEP) return { x: finalWaypoint.x, y: finalWaypoint.y };
    const nx = (finalWaypoint.x - coveringPos.x) / d;
    const ny = (finalWaypoint.y - coveringPos.y) / d;
    return { x: coveringPos.x + nx * BOUND_STEP, y: coveringPos.y + ny * BOUND_STEP };
  }

  // 躍進側(moving)の1体だけを処理する。到達→ホールド→交代までをこの関数内で完結させる
  // (以前は移動と役割交代を別のタイマーに分けていたためズレが生じていた。1つのループに統合)
  function handleBounding(mover, partner, dt) {
    if (mover.boundRole !== "moving" || !mover.waypoint) return;

    const boundTarget = computeBoundTarget(partner, mover.waypoint);
    const atLegTarget = dist(mover, boundTarget) < 4;
    const atFinal = dist(mover, mover.waypoint) < 4;

    if (!atLegTarget) {
      // まだこの区間の躍進目標に到達していない → 前進を続ける
      moveToward(mover, boundTarget, BOUND_SPEED * dt);
      mover.boundHoldTimer = null;
      return;
    }

    if (atFinal) {
      // 最終目標(統制手段)に到達済み。これ以上の交代は不要
      mover.boundHoldTimer = null;
      return;
    }

    // この区間の躍進目標に到達 → 警戒姿勢で一定時間静止してから交代
    if (mover.boundHoldTimer == null) {
      mover.boundHoldTimer = BOUND_HOLD_SECONDS;
      return;
    }
    mover.boundHoldTimer -= dt;
    if (mover.boundHoldTimer <= 0) {
      mover.boundRole = "covering";
      mover.boundHoldTimer = null;
      partner.boundRole = "moving";
      partner.boundHoldTimer = null;
      queueSwapLog(partner.name, mover.name);
    }
  }

  // 警戒前進の後続分隊: 先頭分隊から TRAIL_DISTANCE を保ちながら追従(先頭が止まれば止まる)
  function handleOverwatchTrail(trail, lead, dt) {
    const d = dist(trail, lead);
    if (d <= TRAIL_DISTANCE) return; // 距離を保てているので待機
    const closeBy = Math.min(SPEED[TECH.OVERWATCH] * dt, d - TRAIL_DISTANCE);
    const nx = (lead.x - trail.x) / d;
    const ny = (lead.y - trail.y) / d;
    trail.x += nx * closeBy;
    trail.y += ny * closeBy;
  }

  // 分隊同士が重ならないよう、最小離隔を下回った組を押し合わせる(待機中も適用)
  function applySeparation(list) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const d = dist(a, b);
        if (d > 0 && d < MIN_SEPARATION) {
          const overlap = MIN_SEPARATION - d;
          const nx = (a.x - b.x) / d;
          const ny = (a.y - b.y) / d;
          a.x += (nx * overlap) / 2;
          a.y += (ny * overlap) / 2;
          b.x -= (nx * overlap) / 2;
          b.y -= (ny * overlap) / 2;
        } else if (d === 0) {
          a.x += 1;
        }
      }
    }
  }

  // 役割交代(躍進⇔警戒)は handleBounding 内で移動と同じループに統合済み(別タイマーは廃止)

  // ---------- 操作 ----------
  function toggleSelect(id) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // 統制手段(CP/PL/OBJ)クリック1回で「技術の割当」と「命令発行」を同時に確定する。
  // (以前は「適用ボタン→CPクリック」の2段階だったため、適用ボタンの押し忘れがあると
  //  技術が反映されないまま前のtechnique=前進のままCPクリックだけが通ってしまうバグがあった)
  function handleControlPointClick(cp) {
    if (selectedIds.length === 0) {
      pushLog("先に分隊を選択してください");
      return;
    }

    if (pendingTechnique === TECH.BOUNDING && selectedIds.length !== 2) {
      pushLog("躍進前進は必ず2分隊を選択してください(現在の選択: " + selectedIds.length + ")");
      return;
    }
    if (pendingTechnique === TECH.OVERWATCH && selectedIds.length < 2) {
      pushLog("警戒前進は2分隊以上を選択してください(最初に選んだ分隊が先頭)");
      return;
    }

    setSquads((prev) => {
      const next = prev.map((s) => ({ ...s }));

      if (pendingTechnique === TECH.BOUNDING) {
        const [id1, id2] = selectedIds;
        for (const s of next) {
          if (s.id === id1) { s.technique = TECH.BOUNDING; s.boundPairId = id2; s.boundRole = "moving"; s.boundHoldTimer = null; s.overwatchRole = null; s.overwatchLeadId = null; s.waypoint = { x: cp.x, y: cp.y }; s.waypointLabel = cp.label; }
          if (s.id === id2) { s.technique = TECH.BOUNDING; s.boundPairId = id1; s.boundRole = "covering"; s.boundHoldTimer = null; s.overwatchRole = null; s.overwatchLeadId = null; s.waypoint = { x: cp.x, y: cp.y }; s.waypointLabel = cp.label; }
        }
        pushLog(`${id1}分隊(躍進)・${id2}分隊(警戒)のペアで ${cp.label} へ躍進前進命令`);
      } else if (pendingTechnique === TECH.OVERWATCH) {
        const [leadId, ...trailIds] = selectedIds;
        for (const s of next) {
          if (s.id === leadId) {
            s.technique = TECH.OVERWATCH;
            s.overwatchRole = "lead";
            s.overwatchLeadId = null;
            s.boundPairId = null;
            s.boundRole = null;
            s.waypoint = { x: cp.x, y: cp.y };
            s.waypointLabel = cp.label;
          } else if (trailIds.includes(s.id)) {
            s.technique = TECH.OVERWATCH;
            s.overwatchRole = "trail";
            s.overwatchLeadId = leadId;
            s.boundPairId = null;
            s.boundRole = null;
            s.waypoint = null; // 後続は先頭を動的に追従するため個別waypointは不要
          }
        }
        pushLog(`${leadId}分隊を先頭に ${cp.label} へ前進(警戒前進、${trailIds.join("・")}分隊が後続)`);
      } else {
        for (const s of next) {
          if (selectedIds.includes(s.id)) {
            s.technique = TECH.TRAVELING;
            s.boundPairId = null;
            s.boundRole = null;
            s.boundHoldTimer = null;
            s.overwatchRole = null;
            s.overwatchLeadId = null;
            s.waypoint = { x: cp.x, y: cp.y };
            s.waypointLabel = cp.label;
          }
        }
        pushLog(`${selectedIds.join("・")}分隊(前進)→ ${cp.label} 前進命令`);
      }

      return next;
    });
  }

  return (
    <div style={{ display: "flex", gap: 16, fontFamily: "system-ui, sans-serif", background: "#0f172a", padding: 16, minHeight: "100vh", color: "#e2e8f0" }}>
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>小隊長視点プロトタイプ v2</h2>
        <p style={{ margin: "0 0 4px", fontSize: 12, color: "#94a3b8" }}>
          分隊マーカー=分隊長位置 / 目標地点=統制手段(CP・PL・OBJ)のみ指定可
        </p>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#94a3b8" }}>
          複数分隊への機動技術指示 + 報告確度減衰(SALUTE形式)+ 分隊間の重なり回避を検証
        </p>
        {squads.some((s) => s.technique === TECH.BOUNDING && s.boundPairId) && (
          <div style={{ marginBottom: 8, padding: "6px 10px", background: "#1e293b", borderRadius: 4, fontSize: 12 }}>
            {squads
              .filter((s) => s.technique === TECH.BOUNDING && s.boundRole === "moving")
              .map((s) => (
                <span key={s.id} style={{ color: s.color }}>
                  ● {s.name}が躍進中{s.boundHoldTimer != null ? `(次の躍進まで保持 ${s.boundHoldTimer.toFixed(1)}s)` : ""}
                  {"  "}/ {squads.find((p) => p.id === s.boundPairId)?.name}は警戒(静止)中
                </span>
              ))}
          </div>
        )}
        <svg
          width={MAP_W}
          height={MAP_H}
          style={{ background: "#1e293b", border: "1px solid #334155" }}
        >
          {squads
            .filter((s) => s.technique === TECH.BOUNDING && s.boundRole === "covering")
            .map((s) => (
              <circle key={`sr-${s.id}`} cx={s.x} cy={s.y} r={SUPPORT_RANGE} fill="none" stroke={s.color} strokeDasharray="4 4" opacity={0.35} />
            ))}

          {/* 統制手段(CP/PL/OBJ) */}
          {CONTROL_POINTS.map((cp) => (
            <g
              key={cp.id}
              transform={`translate(${cp.x},${cp.y})`}
              onClick={() => handleControlPointClick(cp)}
              style={{ cursor: selectedIds.length ? "pointer" : "default" }}
            >
              <rect x={-8} y={-8} width={16} height={16} transform="rotate(45)" fill="none" stroke="#facc15" strokeWidth={2} />
              <text y={-14} fontSize={11} fill="#facc15" textAnchor="middle">{cp.label}</text>
            </g>
          ))}

          {/* 報告マーカー(位置確度の減衰を可視化) */}
          {reports.map((r) => {
            const conf = confidenceAt(now - r.spottedAt);
            const radius = 10 + (1 - conf) * 55;
            const squad = squads.find((s) => s.id === r.squadId);
            return (
              <g key={r.id}>
                <circle cx={r.x} cy={r.y} r={radius} fill={squad ? squad.color : "#f87171"} opacity={0.12} />
                <circle cx={r.x} cy={r.y} r={4} fill="none" stroke={squad ? squad.color : "#f87171"} strokeWidth={1.5} opacity={Math.max(0.15, conf)} />
                <text x={r.x + 8} y={r.y - 8} fontSize={11} fill="#fca5a5">? {Math.round(conf * 100)}%</text>
              </g>
            );
          })}

          {/* waypoint線 */}
          {squads.filter((s) => s.waypoint).map((s) => (
            <line key={`wp-${s.id}`} x1={s.x} y1={s.y} x2={s.waypoint.x} y2={s.waypoint.y} stroke={s.color} strokeDasharray="3 3" opacity={0.5} />
          ))}

          {/* 警戒前進: 先頭-後続の追従関係を線で可視化 */}
          {squads
            .filter((s) => s.technique === TECH.OVERWATCH && s.overwatchRole === "trail" && s.overwatchLeadId)
            .map((s) => {
              const lead = squads.find((l) => l.id === s.overwatchLeadId);
              if (!lead) return null;
              return (
                <line key={`ow-${s.id}`} x1={s.x} y1={s.y} x2={lead.x} y2={lead.y} stroke={s.color} strokeWidth={1.5} strokeDasharray="2 5" opacity={0.6} />
              );
            })}

          {/* 分隊マーカー(=分隊長位置) */}
          {squads.map((s) => {
            const selected = selectedIds.includes(s.id);
            return (
              <g
                key={s.id}
                transform={`translate(${s.x},${s.y})`}
                onClick={(e) => { e.stopPropagation(); toggleSelect(s.id); }}
                style={{ cursor: "pointer" }}
              >
                <circle r={selected ? SQUAD_RADIUS + 3 : SQUAD_RADIUS} fill={s.color} stroke={selected ? "#fff" : (s.technique === TECH.BOUNDING && s.boundRole === "moving" ? "#fff" : "none")} strokeWidth={s.technique === TECH.BOUNDING && s.boundRole === "moving" ? 3 : 2} />
                <text y={-18} fontSize={11} fill="#e2e8f0" textAnchor="middle">
                  {s.name}
                  {s.technique === TECH.BOUNDING
                    ? s.boundRole === "moving"
                      ? s.boundHoldTimer != null
                        ? `(躍進→保持 ${s.boundHoldTimer.toFixed(1)}s)`
                        : "(躍進中)"
                      : "(警戒中・静止)"
                    : ""}
                  {s.technique === TECH.OVERWATCH ? `(${s.overwatchRole === "lead" ? "先頭" : "後続"})` : ""}
                </text>
              </g>
            );
          })}
        </svg>

        <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>
          分隊マーカーをクリックして選択(複数可、選ぶ順序が重要) → 右側で機動技術を選ぶ → 黄色い統制手段(◇)をクリックすると、その時点で技術の割当と前進命令が同時に確定する<br />
          ・前進: 何分隊でも可、全員同じ目標へ直進<br />
          ・警戒前進: 2分隊以上、<b>最初に選んだ分隊が先頭</b>・残りが距離を保って後続<br />
          ・躍進前進: 必ず2分隊、約1.4秒の静止を挟みながら交互に前進(黄枠が太い方が現在移動中)
        </div>
      </div>

      <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "#1e293b", padding: 12, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>選択中: {selectedIds.length ? selectedIds.join(", ") : "なし"}</div>
          {Object.values(TECH).map((t) => (
            <label key={t} style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <input type="radio" checked={pendingTechnique === t} onChange={() => setPendingTechnique(t)} style={{ marginRight: 6 }} />
              {TECH_LABEL[t]}
            </label>
          ))}
          <div style={{ fontSize: 11, color: "#64748b" }}>統制手段(◇)をクリックした瞬間に確定(別途「適用」操作は不要)</div>
        </div>

        <div style={{ background: "#1e293b", padding: 12, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>敵情報報告(SALUTE形式)</div>
          {reports.length === 0 && <div style={{ fontSize: 12, color: "#475569" }}>報告なし</div>}
          {reports.map((r) => {
            const conf = confidenceAt(now - r.spottedAt);
            return (
              <div key={r.id} style={{ fontSize: 11, marginBottom: 8, borderLeft: "2px solid #475569", paddingLeft: 6 }}>
                <div style={{ color: "#e2e8f0" }}>{r.squadId}分隊 発見報告({r.cpRef}付近)</div>
                <div>S(規模): {r.size}</div>
                <div>A(活動): {r.activity}</div>
                <div>L(位置): 確度 {Math.round(conf * 100)}%(経過{Math.round(now - r.spottedAt)}秒)</div>
                <div>U(所属): 不明</div>
                <div>T(時刻): +{Math.round(r.spottedAt)}秒</div>
                <div>E(装備): {r.equipment}</div>
              </div>
            );
          })}
        </div>

        <div style={{ background: "#1e293b", padding: 12, borderRadius: 6, flex: 1 }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>ログ</div>
          {log.map((l, i) => (
            <div key={l.t + i} style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 4 }}>{l.msg}</div>
          ))}
        </div>

        <button
          onClick={() => setRunning((r) => !r)}
          style={{ padding: "6px 0", background: running ? "#475569" : "#22c55e", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer" }}
        >
          {running ? "一時停止" : "再開"}
        </button>
      </div>
    </div>
  );
}
