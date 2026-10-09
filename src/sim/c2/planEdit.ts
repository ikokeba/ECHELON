/**
 * 作戦の書き換え(`[v7.3]` ロードマップ A-1)。
 *
 * 人間(または LLM)が中隊長に座ると、立案中に AI の作戦を書き換えられる:
 * 主攻(防御なら主陣地)、小隊への任務、接近経路(経由点)、開始時刻(H時)、
 * 調整線(phase line)、迫撃砲の射撃計画。
 *
 * ── 作法 ──
 *   - **AI の案(`basePlan`)の上に、書き換え(`PlanEdit`)を順に重ねる。** 書き換えるたびに
 *     AI の案から作り直すので、何度書き換えても初期条件コード(P3)から作り直した盤面と同じになる
 *     (防衛陣地の置き直し `DefenseEdit` と同じ作法)
 *   - **書き換えは計画であって、新しい能力ではない(P4)。** 任務の種別は AI と同じ3種、
 *     射撃計画は `requestFireMission` を通る(弾・指揮所・間隔・射程・危険近接)。
 *     経由点・開始時刻・調整線は、AI の中隊長が小隊へ下ろしている「任務の目標」を
 *     時間と順序で切り替えるだけ
 *   - **敵の位置は使わない(P1)。** 立案時点で belief は空
 */

import { MORTAR, PLAN_EDIT, SIM_HZ } from "../constants.ts";
import type { ControlState } from "../control.ts";
import { aiSuppressed } from "../control.ts";
import { requestFireMission } from "../systems/indirect.ts";
import { applyPlan, isDefender, platoonName, routeTo } from "./planning.ts";
import { setupDefense } from "./defense.ts";
import type {
  CompanyState,
  Mission,
  MissionKind,
  OperationPlan,
  PlanEdit,
  PlanTask,
  Vec2,
} from "../types.ts";
import type { World } from "../world.ts";

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 書き換えが通らない理由。null なら通る。
 *   not_planning   : 立案中ではない(書き換えは戦闘前だけ。戦闘中は通常の命令で)
 *   not_your_plan  : その陣営の中隊長の座席ではない
 *   no_platoon     : 作戦にその小隊がいない
 *   no_objective   : その拠点が無い
 *   bad_point      : 盤の外の点
 *   too_many_points: 経由点が多すぎる
 *   bad_time       : 時刻が範囲外
 *   fires_too_close: 射撃計画の間隔が要請間隔(`MORTAR.COOLDOWN_SEC`)より短い
 *   fires_too_early: 開戦から要請間隔ぶんは砲の展開中で撃てない
 *   too_many_fires : 弾が足りない(1回 `ROUNDS_PER_MISSION` 発)
 */
export type PlanEditBlock =
  | "not_planning"
  | "not_your_plan"
  | "no_platoon"
  | "no_objective"
  | "bad_point"
  | "too_many_points"
  | "bad_time"
  | "fires_too_close"
  | "fires_too_early"
  | "too_many_fires";

export const PLAN_EDIT_BLOCK_TEXT: Record<PlanEditBlock, string> = {
  not_planning: "書き換えられるのは作戦立案中だけ",
  not_your_plan: "その陣営の中隊長に座ると書き換えられる",
  no_platoon: "作戦にその小隊がいない",
  no_objective: "その拠点は無い",
  bad_point: "盤の外は指定できない",
  too_many_points: `経由点は ${PLAN_EDIT.MAX_VIA} 個まで`,
  bad_time: `時刻は 0〜${PLAN_EDIT.MAX_START_SEC} 秒`,
  fires_too_close: `射撃計画の間隔は ${MORTAR.COOLDOWN_SEC} 秒以上あける`,
  fires_too_early: `迫撃砲は開戦から ${MORTAR.COOLDOWN_SEC} 秒は展開中(H+${MORTAR.COOLDOWN_SEC}秒から)`,
  too_many_fires: "迫撃砲の弾が足りない",
};

function inBounds(world: World, p: Vec2): boolean {
  const b = world.bounds;
  return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
}

function companyOfSeat(world: World, side: CompanyState["side"], seat: ControlState | null): CompanyState | null {
  if (!seat || seat.echelon !== "company" || seat.side !== side) return null;
  return world.companies.find((c) => c.side === side && c.companyId === seat.unitId) ?? null;
}

/** 書き換えが通らない理由(AI・人間・LLM 共通の規則)。 */
export function planEditBlocker(world: World, edit: PlanEdit, seat: ControlState | null): PlanEditBlock | null {
  if (world.phase !== "planning") return "not_planning";
  const co = companyOfSeat(world, edit.side, seat);
  if (!co || !co.basePlan) return "not_your_plan";
  const hasTask = (id: number): boolean => co.basePlan!.tasks.some((t) => t.platoonId === id);
  const objExists = (id: number): boolean => world.objectives.some((o) => o.id === id);
  switch (edit.op) {
    case "task":
      if (!hasTask(edit.platoonId)) return "no_platoon";
      if (edit.mission !== "reserve" && (edit.objectiveId === null || !objExists(edit.objectiveId))) {
        return "no_objective";
      }
      return null;
    case "main":
      return objExists(edit.objectiveId) ? null : "no_objective";
    case "route":
      if (!hasTask(edit.platoonId)) return "no_platoon";
      if (edit.via.length > PLAN_EDIT.MAX_VIA) return "too_many_points";
      return edit.via.every((p) => inBounds(world, p)) ? null : "bad_point";
    case "start":
      if (!hasTask(edit.platoonId)) return "no_platoon";
      return edit.startSec >= 0 && edit.startSec <= PLAN_EDIT.MAX_START_SEC ? null : "bad_time";
    case "phaseLine":
      if (!edit.line) return null;
      return edit.line.every((p) => inBounds(world, p)) ? null : "bad_point";
    case "fires": {
      if (!edit.fires.every((f) => inBounds(world, f.target))) return "bad_point";
      if (!edit.fires.every((f) => f.atSec <= PLAN_EDIT.MAX_START_SEC)) return "bad_time";
      // 開戦直後は砲の展開中(要請間隔の起点が戦闘開始、systems/indirect.ts)
      if (!edit.fires.every((f) => f.atSec >= MORTAR.COOLDOWN_SEC)) return "fires_too_early";
      const at = edit.fires.map((f) => f.atSec).sort((a, b) => a - b);
      for (let i = 1; i < at.length; i++) if (at[i]! - at[i - 1]! < MORTAR.COOLDOWN_SEC) return "fires_too_close";
      if (edit.fires.length * MORTAR.ROUNDS_PER_MISSION > MORTAR.ROUNDS_PER_COMPANY) return "too_many_fires";
      return null;
    }
  }
}

/** 同じ対象の書き換えは後のものだけを残す(記録が際限なく伸びないように) */
function editKey(e: PlanEdit): string {
  switch (e.op) {
    case "task":
    case "route":
    case "start":
      return `${e.side}:${e.op}:${e.platoonId}`;
    default:
      return `${e.side}:${e.op}`;
  }
}

/**
 * 座標を初期条件コードの精度(0.01m)・時刻を1秒へ丸める。丸めてから適用しないと、
 * いま目の前の盤面とコードから作り直した盤面がずれる(P3)
 */
export function normalizePlanEdit(e: PlanEdit): PlanEdit {
  const qv = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });
  switch (e.op) {
    case "route":
      return { ...e, via: e.via.map(qv) };
    case "start":
      return { ...e, startSec: Math.round(e.startSec) };
    case "phaseLine":
      return { ...e, line: e.line ? [qv(e.line[0]), qv(e.line[1])] : null };
    case "fires":
      return { ...e, fires: e.fires.map((f) => ({ target: qv(f.target), atSec: Math.round(f.atSec) })) };
    default:
      return { ...e };
  }
}

/** 書き換えを記録へ足す(同じ対象の古いものは捨てる)。純粋関数 — 初期条件の側でも使う */
export function mergePlanEdits(list: readonly PlanEdit[], e: PlanEdit): PlanEdit[] {
  const n = normalizePlanEdit(e);
  return [...list.filter((x) => editKey(x) !== editKey(n)), n];
}

export type PlanEditResult = { ok: true } | { ok: false; reason: PlanEditBlock };

/**
 * 作戦を書き換える(`[v7.3]` A-1)。中隊長の座席から、立案中だけ。
 * 通ったら AI の案から作戦を作り直し、陣地も置き直す。呼び出し側は `world.planEdits` を
 * 初期条件へ記録する(P3)。
 */
export function editPlan(world: World, edit: PlanEdit, seat: ControlState | null = world.control): PlanEditResult {
  const block = planEditBlocker(world, edit, seat);
  if (block) return { ok: false, reason: block };
  world.planEdits = mergePlanEdits(world.planEdits, edit);
  rebuildPlans(world);
  return { ok: true };
}

/** AI の案に書き換えを重ねて作戦を作り直し、下達し直す。陣地も作戦に合わせて置き直す */
export function rebuildPlans(world: World): void {
  for (const co of world.companies) {
    if (!co.basePlan) continue;
    co.plan = applyPlanEdits(world, co, co.basePlan, world.planEdits);
    applyPlan(world, co);
  }
  setupDefense(world);
}

const ROLE_JP: Record<PlanTask["role"], string> = { main: "主攻", supporting: "助攻", reserve: "予備" };
const KIND_JP: Record<MissionKind, string> = {
  seize: "を確保せよ",
  support_by_fire: "へ射線の通る位置に就き、支援射撃せよ",
  screen: "の方向を掩護・監視せよ",
};

/** 書き換えた任務の命令文。AI の命令文と同じ形(誰が・何を・どう) */
function orderText(world: World, plan: OperationPlan, t: PlanTask): string {
  const name = platoonName(t.platoonId);
  if (t.role === "reserve") return `${name} — 予備。集結地点で待機し、命令により投入する`;
  const o = world.objectives.find((x) => x.id === t.objectiveId);
  const label = o?.label ?? "目標";
  const role = t.role === "main" && plan.mainObjectiveId === t.objectiveId ? ROLE_JP.main : ROLE_JP[t.role];
  const extra: string[] = [];
  if (t.via && t.via.length > 0) extra.push(`経由点${t.via.length}か所を通る`);
  if (t.startSec && t.startSec > 0) extra.push(`H+${t.startSec}秒に発進`);
  return `${name} — ${role}。${label} ${KIND_JP[t.mission.kind]}${extra.length ? `(${extra.join("、")})` : ""}`;
}

/** 経由点を通る接近経路(表示と前進軸)。脚ごとにナビグリッドで引いてつなぐ */
function routeVia(world: World, from: Vec2, via: readonly Vec2[], to: Vec2): Vec2[] {
  const pts = [from, ...via, to];
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const leg = routeTo(world, pts[i]!, pts[i + 1]!);
    out.push(...(i === 0 ? leg : leg.slice(1)));
  }
  return out;
}

/**
 * AI の案(`base`)に書き換えを重ねた作戦。純粋関数(世界も `base` も変えない)。
 */
export function applyPlanEdits(
  world: World,
  co: CompanyState,
  base: OperationPlan,
  edits: readonly PlanEdit[],
): OperationPlan {
  const plan = JSON.parse(JSON.stringify(base)) as OperationPlan;
  const mine = edits.filter((e) => e.side === co.side);
  if (mine.length === 0) return plan;
  const touched = new Set<number>();
  const taskOf = (id: number): PlanTask | undefined => plan.tasks.find((t) => t.platoonId === id);

  for (const e of mine) {
    switch (e.op) {
      case "task": {
        const t = taskOf(e.platoonId);
        if (!t) break;
        touched.add(t.platoonId);
        if (e.mission === "reserve") {
          t.role = "reserve";
          t.objectiveId = null;
          t.mission = { kind: "screen", target: { ...co.rallyPoint } };
        } else {
          const o = world.objectives.find((x) => x.id === e.objectiveId);
          if (!o) break;
          t.role = "supporting";
          t.objectiveId = o.id;
          t.mission = { kind: e.mission, target: { ...o.pos } } satisfies Mission;
        }
        break;
      }
      case "main":
        if (world.objectives.some((o) => o.id === e.objectiveId)) plan.mainObjectiveId = e.objectiveId;
        break;
      case "route": {
        const t = taskOf(e.platoonId);
        if (!t) break;
        touched.add(t.platoonId);
        if (e.via.length > 0) t.via = e.via.map((p) => ({ ...p }));
        else delete t.via;
        break;
      }
      case "start": {
        const t = taskOf(e.platoonId);
        if (!t) break;
        touched.add(t.platoonId);
        if (e.startSec > 0) t.startSec = e.startSec;
        else delete t.startSec;
        break;
      }
      case "phaseLine":
        plan.phaseLine = e.line ? [{ ...e.line[0] }, { ...e.line[1] }] : null;
        break;
      case "fires":
        plan.fires = [...e.fires]
          .sort((a, b) => a.atSec - b.atSec)
          .map((f) => ({ target: { ...f.target }, atSec: f.atSec }));
        break;
    }
  }

  // 主攻は「主攻の拠点を確保する」任務の小隊1つ(AI の案と同じ規則)。他は助攻
  let mainGiven = false;
  for (const t of plan.tasks) {
    if (t.role === "reserve") continue;
    const isMain = !mainGiven && t.objectiveId === plan.mainObjectiveId && t.mission.kind === "seize";
    const prev = t.role;
    t.role = isMain ? "main" : "supporting";
    if (isMain) mainGiven = true;
    if (prev !== t.role) touched.add(t.platoonId);
  }
  const mainObj = world.objectives.find((o) => o.id === plan.mainObjectiveId);
  for (const t of plan.tasks) {
    if (!touched.has(t.platoonId)) continue;
    const start = t.route[0] ?? t.mission.target;
    t.route = routeVia(world, start, t.via ?? [], t.mission.target);
    t.order = orderText(world, plan, t);
  }
  plan.edited = true;
  const n = world.objectives.length;
  const need = Math.floor(n / 2) + 1;
  const mainTask = plan.tasks.find((t) => t.role === "main");
  const defending = isDefender(world, co.side);
  plan.intent =
    `【書き換えた作戦】${n}個の拠点のうち${need}個を${defending ? "保持" : "確保"}する。` +
    (mainObj
      ? `${defending ? "主陣地" : "主攻"}は${mainTask ? platoonName(mainTask.platoonId) : "未指定"}(${mainObj.label})。`
      : "") +
    (plan.phaseLine ? "調整線で足並みを揃えてから越える。" : "") +
    (plan.fires && plan.fires.length > 0 ? `迫撃砲の射撃計画 ${plan.fires.length}件。` : "");
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// 戦闘中: 作戦の実行(経由点・開始時刻・調整線・射撃計画)
// ─────────────────────────────────────────────────────────────────────────────

/** 調整線の、敵の方角を向いた単位法線 */
function lineNormal(line: [Vec2, Vec2], advanceDir: Vec2): Vec2 {
  const dx = line[1].x - line[0].x;
  const dz = line[1].z - line[0].z;
  const d = Math.hypot(dx, dz) || 1;
  let n = { x: -dz / d, z: dx / d };
  if (n.x * advanceDir.x + n.z * advanceDir.z < 0) n = { x: -n.x, z: -n.z };
  return n;
}

/** 調整線からの符号つき距離(敵の側が正) */
function sideOfLine(line: [Vec2, Vec2], n: Vec2, p: Vec2): number {
  return (p.x - line[0].x) * n.x + (p.z - line[0].z) * n.z;
}

/** 調整線の手前で待つ地点: 目標を線分へ落とし、手前へ `PL_STANDOFF` 引いたところ */
function holdBeforeLine(line: [Vec2, Vec2], n: Vec2, target: Vec2): Vec2 {
  const ax = line[1].x - line[0].x;
  const az = line[1].z - line[0].z;
  const l2 = ax * ax + az * az || 1;
  const t = Math.max(0, Math.min(1, ((target.x - line[0].x) * ax + (target.z - line[0].z) * az) / l2));
  return {
    x: line[0].x + ax * t - n.x * PLAN_EDIT.PL_STANDOFF,
    z: line[0].z + az * t - n.z * PLAN_EDIT.PL_STANDOFF,
  };
}

function platoonCentroid(world: World, side: CompanyState["side"], platoonId: number): Vec2 | null {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const s of world.soldiers) {
    if (s.side !== side || s.platoonId !== platoonId || s.status !== "ok") continue;
    x += s.pos.x;
    z += s.pos.z;
    n++;
  }
  return n === 0 ? null : { x: x / n, z: z / n };
}

/** 調整線に従う任務(拠点を持つ・予備でない) */
function boundByLine(t: PlanTask): boolean {
  return t.role !== "reserve" && t.objectiveId !== null;
}

/**
 * いまその小隊に下ろすべき「作戦の段階」の目標。null なら任務そのもの(`task.mission`)。
 *   wait : 開始時刻まで出発地点で待つ(掩護)
 *   viaN : N 番目の経由点へ(確保 = そこまで進む)
 *   pl   : 調整線の手前で待つ
 */
export function planLeg(
  world: World,
  co: CompanyState,
  task: PlanTask,
): { target: Vec2; kind: MissionKind; key: string } | null {
  const plan = co.plan;
  if (!plan) return null;
  if (task.startSec && world.tick < Math.round(task.startSec * SIM_HZ)) {
    return { target: { ...(task.route[0] ?? task.mission.target) }, kind: "screen", key: "wait" };
  }
  const c = platoonCentroid(world, co.side, task.platoonId);
  if (task.via && task.via.length > 0) {
    let i = task.viaIdx ?? 0;
    while (c && i < task.via.length && dist(c, task.via[i]!) <= PLAN_EDIT.VIA_ARRIVE) i++;
    task.viaIdx = i;
    if (i < task.via.length) return { target: { ...task.via[i]! }, kind: "seize", key: `via${i}` };
  }
  if (plan.phaseLine && plan.phaseLineLiftedTick == null && boundByLine(task)) {
    const n = lineNormal(plan.phaseLine, co.advanceDir);
    return { target: holdBeforeLine(plan.phaseLine, n, task.mission.target), kind: "seize", key: "pl" };
  }
  return null;
}

/**
 * 調整線の解除を判断する。任務を持つ健在な小隊がすべて線に着いたら(手前 `PL_ARRIVE` 以内、
 * または既に越えている)解除。最初の小隊が着いてから `PL_MAX_WAIT_SEC` 待っても揃わなければ解除
 */
function updatePhaseLine(world: World, co: CompanyState): void {
  const plan = co.plan;
  if (!plan?.phaseLine || plan.phaseLineLiftedTick != null) return;
  const n = lineNormal(plan.phaseLine, co.advanceDir);
  let all = true;
  let any = false;
  for (const t of plan.tasks) {
    if (!boundByLine(t)) continue;
    const c = platoonCentroid(world, co.side, t.platoonId);
    if (!c) continue;
    // 経由点を残している・まだ発進していない小隊は、線に着いたことにならない
    const pending =
      (t.startSec && world.tick < Math.round(t.startSec * SIM_HZ)) || (t.via && (t.viaIdx ?? 0) < t.via.length);
    const at = !pending && sideOfLine(plan.phaseLine, n, c) >= -PLAN_EDIT.PL_ARRIVE;
    if (at) any = true;
    else all = false;
  }
  if (any && plan.phaseLineFirstTick == null) plan.phaseLineFirstTick = world.tick;
  const waited =
    plan.phaseLineFirstTick != null &&
    world.tick - plan.phaseLineFirstTick >= Math.round(PLAN_EDIT.PL_MAX_WAIT_SEC * SIM_HZ);
  if ((any && all) || waited) plan.phaseLineLiftedTick = world.tick;
}

/** 射撃計画の実行。時刻が来たら AI と同じ `requestFireMission` で要請する */
function runPlannedFires(world: World, co: CompanyState): void {
  const fires = co.plan?.fires;
  if (!fires) return;
  for (const f of fires) {
    if (f.done) continue;
    const at = Math.round(f.atSec * SIM_HZ);
    if (world.tick < at) continue;
    const r = requestFireMission(world, co, f.target);
    // 通らなかったら(間隔・指揮所など)しばらく粘り、時機を逸したら取りやめる
    if (r.ok || world.tick - at >= Math.round(PLAN_EDIT.FIRE_GRACE_SEC * SIM_HZ)) f.done = true;
  }
}

/**
 * 毎ティック、中隊長が人間・LLM・AI のどれでも走る作戦の実行(`[v7.3]` A-1)。
 * 立てた計画は誰が座っていても計画どおりに進む — 開始時刻・経由点・調整線は
 * 段階が**変わったときだけ**小隊へ下ろすので、座っている人間が途中で出した命令を
 * 毎ティック上書きすることはない。射撃計画は時刻に要請する。
 */
export function executePlan(world: World, co: CompanyState): void {
  if (!co.plan || world.phase !== "battle") return;
  updatePhaseLine(world, co);
  runPlannedFires(world, co);
  if (!aiSuppressed(world, "company", co.side, co.companyId)) return; // AI の中隊長は companyAI が下ろす
  for (const t of co.plan.tasks) {
    const leg = planLeg(world, co, t);
    const key = leg?.key ?? "mission";
    if (t.legKey === key) continue;
    t.legKey = key;
    const pl = world.platoons.find((p) => p.side === co.side && p.platoonId === t.platoonId);
    if (!pl || aiSuppressed(world, "platoon", pl.side, pl.platoonId)) continue;
    const m: Mission = leg ? { kind: leg.kind, target: leg.target } : t.mission;
    co.platoonObjectives.set(pl.platoonId, { ...m.target });
    co.platoonMissions.set(pl.platoonId, { kind: m.kind, target: { ...m.target } });
    pl.objective = { ...m.target };
    pl.mission = { kind: m.kind, target: { ...m.target } };
  }
}
