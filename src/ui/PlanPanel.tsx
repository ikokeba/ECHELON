import { useSimStore, type PlanTaskView, type PlanView } from "./store.ts";
import type { MissionKind } from "@sim/types.ts";

/**
 * L2 文脈スロット — 作戦立案フェーズ(`[v6.5]`、`[v6.6]` でレビュー反映)。
 *
 * 流れは「配置(G)→ 中隊長が立案 → 内容を確認 → 戦闘開始」。ここに出るのは
 * 作戦命令(OPORD)の第3項「機動の要領」に相当するもので、中隊長が拠点に対して
 * 主攻と助攻を決め、各小隊へ任務と接近経路を割り当てた結果(仕様 §3① / §11)。
 *
 * 中隊長は**敵の位置を一切見ずに**これを立てている(仕様 §5)。立案時点で
 * belief は空であり、地形と拠点と自軍の配置だけが材料になる。
 *
 * `[v6.6]` — UIレビュー 05: **主攻の行だけが枠線と背景を持つ**。役割ラベルは幅36px
 * 固定にして命令文の左端を揃える。3行が同じ重さで並ぶと、どれが主攻かを毎回読む
 * ことになる — 主効の指定は作戦の骨格なので、一目で分かる必要がある。
 *
 * 行にカーソルを乗せると、地図側でその小隊の接近経路だけが濃くなる。地図に文字を
 * 出さずにパネルと盤面を対応づけるための仕掛け。
 */

const ROLE_LABEL: Record<PlanTaskView["role"], string> = {
  main: "主攻",
  supporting: "助攻",
  reserve: "予備",
};

const MISSION_LABEL: Record<PlanTaskView["missionKind"], string> = {
  seize: "確保",
  support_by_fire: "支援射撃",
  screen: "掩護",
};

/** その陣営の中隊長に座っていれば、作戦を書き換えられる(`[v7.3]` A-1) */
function useEditable(): (p: PlanView) => boolean {
  const control = useSimStore((s) => s.control);
  return (p) => control?.echelon === "company" && control.side === p.side;
}

const EDIT_MISSIONS: Array<{ v: MissionKind | "reserve"; label: string }> = [
  { v: "seize", label: "確保" },
  { v: "support_by_fire", label: "支援射撃" },
  { v: "screen", label: "掩護" },
  { v: "reserve", label: "予備" },
];

/**
 * 小隊1つぶんの書き換え(`[v7.3]` A-1)。任務・対象の拠点・主攻・開始時刻・経由点。
 * どれも AI の案の上に重ねる書き換えで、初期条件コードに載る
 */
function TaskEditor({ plan, task }: { plan: PlanView; task: PlanTaskView }) {
  const request = useSimStore((s) => s.requestPlanEdit);
  const planArm = useSimStore((s) => s.planArm);
  const setPlanArm = useSimStore((s) => s.setPlanArm);
  const side = plan.side;
  const mission: MissionKind | "reserve" = task.role === "reserve" ? "reserve" : task.missionKind;
  const objective = task.objectiveId ?? plan.objectives[0]?.id ?? null;
  const drawing = planArm?.kind === "via" && planArm.platoonId === task.platoonId ? planArm : null;
  return (
    <div className="plan-edit">
      <select
        value={mission}
        onChange={(e) => {
          const m = e.target.value as MissionKind | "reserve";
          request({
            side,
            op: "task",
            platoonId: task.platoonId,
            mission: m,
            objectiveId: m === "reserve" ? null : objective,
          });
        }}
        title="任務の種別"
      >
        {EDIT_MISSIONS.map((m) => (
          <option key={m.v} value={m.v}>
            {m.label}
          </option>
        ))}
      </select>
      {mission !== "reserve" && (
        <select
          value={task.objectiveId ?? ""}
          onChange={(e) =>
            request({
              side,
              op: "task",
              platoonId: task.platoonId,
              mission,
              objectiveId: Number(e.target.value),
            })
          }
          title="対象の拠点"
        >
          {plan.objectives.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {mission !== "reserve" &&
        task.objectiveId !== null &&
        task.objectiveId !== plan.mainObjectiveId && (
          <button
            type="button"
            className="seg-btn"
            onClick={() => request({ side, op: "main", objectiveId: task.objectiveId! })}
            title="この拠点を主攻(防御なら主陣地)にする"
          >
            主攻に
          </button>
        )}
      <label className="plan-time" title="開始時刻(戦闘開始から何秒後に動き出すか。H時)">
        H+
        <input
          type="number"
          min={0}
          max={600}
          step={10}
          value={task.startSec}
          onChange={(e) =>
            request({
              side,
              op: "start",
              platoonId: task.platoonId,
              startSec: Math.max(0, Number(e.target.value) || 0),
            })
          }
        />
        秒
      </label>
      {drawing ? (
        <>
          <button
            type="button"
            className="seg-btn seg-on"
            onClick={() => {
              setPlanArm(null);
              request({ side, op: "route", platoonId: task.platoonId, via: drawing.points });
            }}
          >
            経由点 {drawing.points.length} を確定
          </button>
          <button type="button" className="seg-btn" onClick={() => setPlanArm(null)}>
            やめる
          </button>
        </>
      ) : (
        <button
          type="button"
          className="seg-btn"
          onClick={() => setPlanArm({ kind: "via", side, platoonId: task.platoonId, points: [] })}
          title="盤面をクリックして経由点を順に置く"
        >
          経路を描く{task.via.length > 0 ? `(${task.via.length})` : ""}
        </button>
      )}
      {task.via.length > 0 && !drawing && (
        <button
          type="button"
          className="seg-btn"
          onClick={() => request({ side, op: "route", platoonId: task.platoonId, via: [] })}
          title="経由点を消して AI の経路に戻す"
        >
          経路を消す
        </button>
      )}
    </div>
  );
}

/** 中隊全体の書き換え(`[v7.3]` A-1)。調整線と迫撃砲の射撃計画 */
function PlanWideEditor({ plan }: { plan: PlanView }) {
  const request = useSimStore((s) => s.requestPlanEdit);
  const planArm = useSimStore((s) => s.planArm);
  const setPlanArm = useSimStore((s) => s.setPlanArm);
  const side = plan.side;
  const setFires = (fires: PlanView["fires"]) => request({ side, op: "fires", fires });
  return (
    <div className="plan-defense">
      <div className="dbg-k">調整線・射撃計画(書き換え)</div>
      <div className="plan-edit">
        <button
          type="button"
          className={`seg-btn${planArm?.kind === "line" ? " seg-on" : ""}`}
          onClick={() =>
            setPlanArm(planArm?.kind === "line" ? null : { kind: "line", side, first: null })
          }
          title="盤面を2回クリックして調整線を引く。各小隊は線の手前で揃ってから越える"
        >
          {planArm?.kind === "line"
            ? planArm.first
              ? "2点目をクリック…"
              : "1点目をクリック…"
            : "調整線を引く"}
        </button>
        {plan.phaseLine && (
          <button
            type="button"
            className="seg-btn"
            onClick={() => request({ side, op: "phaseLine", line: null })}
          >
            調整線を消す
          </button>
        )}
        <button
          type="button"
          className={`seg-btn${planArm?.kind === "fire" ? " seg-on" : ""}`}
          onClick={() => setPlanArm(planArm?.kind === "fire" ? null : { kind: "fire", side })}
          title="盤面をクリックして迫撃砲の射撃計画を足す(要請の規則はAIと同じ)"
        >
          {planArm?.kind === "fire" ? "照準点をクリック…" : "射撃計画を足す"}
        </button>
      </div>
      {plan.fires.map((f, i) => (
        <div key={i} className="plan-edit">
          <span className="plan-unit">
            射撃 {i + 1} ({f.target.x.toFixed(0)}, {f.target.z.toFixed(0)})
          </span>
          <label className="plan-time">
            H+
            <input
              type="number"
              min={0}
              max={600}
              step={15}
              value={f.atSec}
              onChange={(e) =>
                setFires(
                  plan.fires.map((x, j) =>
                    j === i ? { ...x, atSec: Math.max(0, Number(e.target.value) || 0) } : x,
                  ),
                )
              }
            />
            秒
          </label>
          <button
            type="button"
            className="seg-btn"
            onClick={() => setFires(plan.fires.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function PlanPanel() {
  const phase = useSimStore((s) => s.phase);
  const plans = useSimStore((s) => s.plans);
  const viewSide = useSimStore((s) => s.viewSide);
  const setHovered = useSimStore((s) => s.setHoveredPlan);
  const startBattle = useSimStore((s) => s.startBattle);
  const defenseMoveId = useSimStore((s) => s.defenseMoveId);
  const setDefenseMove = useSimStore((s) => s.setDefenseMove);
  const control = useSimStore((s) => s.control);
  const editable = useEditable();

  if (phase !== "planning") return null;

  return (
    <div className="panel panel-warn plan-fit">
      <div className="panel-cap">
        <span className="plan-title">作戦立案</span>
        <span>開始まで時間は止まっています</span>
      </div>

      {plans.length === 0 && (
        <div className="dbg-k">この編成には中隊長がいません(分隊・小隊シナリオ)。</div>
      )}

      {plans.map((p) => (
        <div key={p.side} className="plan-force">
          <div className={`plan-force-head force-${p.side}`}>
            <span className="force-label">{p.side.toUpperCase()}</span>
            {p.side !== viewSide && <span className="plan-peek">神視点</span>}
          </div>
          <div className="plan-intent">{p.intent}</div>
          {!editable(p) && p.side === viewSide && (
            <div className="dbg-k">
              中隊長に座ると作戦を書き換えられる(任務・主攻・経路・開始時刻・調整線・射撃計画)
            </div>
          )}
          {p.tasks.map((t) => (
            <div
              key={t.key}
              className={t.role === "main" ? "plan-task plan-main" : "plan-task"}
              onMouseEnter={() => setHovered(t.key)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className={`plan-role plan-role-${t.role}`}>{ROLE_LABEL[t.role]}</span>
              <span className="plan-unit">{t.name}</span>
              <span className="plan-unit">{MISSION_LABEL[t.missionKind]}</span>
              <span className="plan-order">{t.order}</span>
              {editable(p) && <TaskEditor plan={p} task={t} />}
            </div>
          ))}
          {editable(p) && <PlanWideEditor plan={p} />}
          {p.defense.length > 0 && (
            <div
              className="plan-defense"
              title="防衛陣地(ロードマップ S-1)。攻撃側には見えない。防衛側の中隊長に座ると、選んでから盤面をクリックして置き直せる"
            >
              <div className="dbg-k">
                防衛陣地
                {!(control?.echelon === "company" && control.side === p.side) &&
                  "(中隊長に座ると置き直せる)"}
              </div>
              {p.defense.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`seg-btn plan-def-btn${defenseMoveId === d.id ? " seg-on" : ""}`}
                  disabled={!(control?.echelon === "company" && control.side === p.side)}
                  onClick={() => setDefenseMove(defenseMoveId === d.id ? null : d.id)}
                >
                  {defenseMoveId === d.id
                    ? "地点を選択…"
                    : `${d.label}${d.objective ? `(${d.objective})` : ""}`}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <button type="button" className="plan-start" onClick={startBattle}>
        戦闘開始
        <span className="key-cap">Enter</span>
      </button>
      <div className="hint">配置(G)を変えると中隊長が立案し直します</div>
    </div>
  );
}
