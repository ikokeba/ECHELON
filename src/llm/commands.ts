/**
 * エージェントの応答を解釈し、検証し、シムへ適用する(`[v7.0]`)。
 *
 * LLM の出力は**信用しない入力**として扱う。形が崩れていれば捨て、座標は盤面へ
 * 収め、座席の階層で出せない命令は弾く。弾いた理由は次の観測の `lastResult` で
 * エージェントへ返す — 小さなモデルでも自分の誤りを直せるように。
 *
 * 適用は `src/sim/playerOrders.ts` の**人間と同じ関数**を通す(仕様 §4)。
 */

import {
  assignPlatoonMission,
  assignSquadMission,
  orderCasevac,
  orderControlledTo,
  orderFireMission,
  orderReinforcement,
  orderSmoke,
  orderAntiArmor,
} from "../sim/playerOrders.ts";
import { ANTI_ARMOR_BLOCK_TEXT } from "../sim/systems/antiArmor.ts";
import { SMOKE_BLOCK_TEXT } from "../sim/systems/smoke.ts";
import { FIRE_MISSION_BLOCK_TEXT } from "../sim/systems/indirect.ts";
import { editPlan, PLAN_EDIT_BLOCK_TEXT } from "../sim/c2/planEdit.ts";
import type { MissionKind, PlanEdit, Vec2 } from "../sim/types.ts";
import type { World } from "../sim/world.ts";
import {
  MAX_COMMANDS,
  type AgentCommand,
  type AgentResponse,
  type AgentSeat,
  type PlanCommand,
} from "./protocol.ts";

const MISSIONS: readonly MissionKind[] = ["seize", "support_by_fire", "screen"];

/**
 * モデルの生の出力から JSON を取り出す。
 *   - 推論モデルの `<think>…</think>` を捨てる
 *   - ```json フェンスを剥がす
 *   - それでも駄目なら最初の `{` から最後の `}` まで
 */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function vecOf(v: unknown): Vec2 | null {
  if (!isObj(v)) return null;
  const x = Number(v.x);
  const z = Number(v.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

export interface ParsedResponse {
  response: AgentResponse | null;
  errors: string[];
}

const PLAN_OPS: readonly PlanCommand["op"][] = ["task", "main", "route", "start", "phase_line", "fires"];

/** `plan` 命令(`[v7.3]` A-1)の形を検証する。崩れていれば理由の文字列 */
function parsePlan(c: Record<string, unknown>): PlanCommand | string {
  const op = c.op as PlanCommand["op"];
  if (!PLAN_OPS.includes(op)) return `op は ${PLAN_OPS.join(" / ")}`;
  const unit = Number(c.unit);
  const objective = Number(c.objective);
  const points = Array.isArray(c.points) ? c.points.map(vecOf) : [];
  if (points.some((p) => p === null)) return "points の各点は {x,z}";
  const pts = points as Vec2[];
  switch (op) {
    case "task": {
      const mission = c.mission as PlanCommand["mission"];
      if (!Number.isInteger(unit) || !(mission === "reserve" || MISSIONS.includes(mission as MissionKind))) {
        return "task には unit(整数)と mission が要る";
      }
      if (mission !== "reserve" && !Number.isInteger(objective)) return "task には objective(拠点 id)が要る";
      return { type: "plan", op, unit, mission, ...(mission !== "reserve" ? { objective } : {}) };
    }
    case "main":
      return Number.isInteger(objective) ? { type: "plan", op, objective } : "main には objective が要る";
    case "route":
      return Number.isInteger(unit) ? { type: "plan", op, unit, points: pts } : "route には unit が要る";
    case "start": {
      const atSec = Number(c.atSec);
      return Number.isInteger(unit) && Number.isFinite(atSec)
        ? { type: "plan", op, unit, atSec }
        : "start には unit と atSec が要る";
    }
    case "phase_line":
      return pts.length === 0 || pts.length === 2 ? { type: "plan", op, points: pts } : "phase_line の points は2点(空で消す)";
    case "fires": {
      const list = Array.isArray(c.fires) ? c.fires : [];
      const fires: Array<{ target: Vec2; atSec: number }> = [];
      for (const f of list) {
        const t = isObj(f) ? vecOf(f.target) : null;
        const at = isObj(f) ? Number(f.atSec) : NaN;
        if (!t || !Number.isFinite(at)) return "fires の各件は {target:{x,z}, atSec}";
        fires.push({ target: t, atSec: at });
      }
      return { type: "plan", op, fires };
    }
  }
}

/** `plan` 命令をシムの書き換え(`PlanEdit`)へ */
function planEditOf(seat: AgentSeat, c: PlanCommand): PlanEdit {
  const side = seat.side;
  switch (c.op) {
    case "task":
      return { side, op: "task", platoonId: c.unit!, mission: c.mission!, objectiveId: c.objective ?? null };
    case "main":
      return { side, op: "main", objectiveId: c.objective! };
    case "route":
      return { side, op: "route", platoonId: c.unit!, via: c.points ?? [] };
    case "start":
      return { side, op: "start", platoonId: c.unit!, startSec: c.atSec ?? 0 };
    case "phase_line":
      return {
        side,
        op: "phaseLine",
        line: c.points && c.points.length === 2 ? [c.points[0]!, c.points[1]!] : null,
      };
    case "fires":
      return { side, op: "fires", fires: c.fires ?? [] };
  }
}

/** JSON(または生テキスト)を検証済みの応答へ。壊れた命令は1件ずつ捨てて理由を残す */
export function parseResponse(raw: unknown): ParsedResponse {
  const errors: string[] = [];
  const data = typeof raw === "string" ? extractJson(raw) : raw;
  if (!isObj(data)) return { response: null, errors: ["応答が JSON オブジェクトではない"] };
  const list = Array.isArray(data.commands) ? data.commands : [];
  if (!Array.isArray(data.commands)) errors.push("commands 配列が無い");
  const commands: AgentCommand[] = [];
  list.slice(0, MAX_COMMANDS).forEach((c, i) => {
    if (!isObj(c)) {
      errors.push(`commands[${i}]: オブジェクトではない`);
      return;
    }
    switch (c.type) {
      case "move": {
        const target = vecOf(c.target);
        if (!target) errors.push(`commands[${i}] move: target {x,z} が無い`);
        else commands.push({ type: "move", target });
        return;
      }
      case "assign": {
        const target = vecOf(c.target);
        const unit = Number(c.unit);
        const mission = c.mission as MissionKind;
        if (!target || !Number.isInteger(unit) || !MISSIONS.includes(mission)) {
          errors.push(`commands[${i}] assign: unit(整数)・mission・target が必要`);
        } else {
          commands.push({ type: "assign", unit, mission, target });
        }
        return;
      }
      case "casevac":
        commands.push({ type: "casevac" });
        return;
      case "hold":
        commands.push({ type: "hold" });
        return;
      case "reinforce":
        commands.push({ type: "reinforce" });
        return;
      case "smoke": {
        const target = vecOf(c.target);
        if (!target) errors.push(`commands[${i}] smoke: target {x,z} が無い`);
        else commands.push({ type: "smoke", target });
        return;
      }
      case "fire_mission": {
        const target = vecOf(c.target);
        if (!target) errors.push(`commands[${i}] fire_mission: target {x,z} が無い`);
        else commands.push({ type: "fire_mission", target });
        return;
      }
      case "anti_armor": {
        const target = vecOf(c.target);
        if (!target) errors.push(`commands[${i}] anti_armor: target {x,z} が無い`);
        else commands.push({ type: "anti_armor", target });
        return;
      }
      case "plan": {
        const p = parsePlan(c);
        if (typeof p === "string") errors.push(`commands[${i}] plan: ${p}`);
        else commands.push(p);
        return;
      }
      default:
        errors.push(`commands[${i}]: 不明な type ${JSON.stringify(c.type)}`);
    }
  });
  if (list.length > MAX_COMMANDS) errors.push(`命令は${MAX_COMMANDS}件まで(超過分は捨てた)`);
  const intent = typeof data.intent === "string" ? data.intent.slice(0, 200) : undefined;
  return { response: { commands, ...(intent ? { intent } : {}) }, errors };
}

/** 盤面の内側へ収める(盤外の目標はナビグリッドに乗らない) */
function clampToBounds(world: World, p: Vec2): Vec2 {
  const m = 2;
  const b = world.bounds;
  return {
    x: Math.min(b.maxX - m, Math.max(b.minX + m, p.x)),
    z: Math.min(b.maxZ - m, Math.max(b.minZ + m, p.z)),
  };
}

/**
 * 検証済みの応答をシムへ適用する。結果を1行ずつ返す(次の観測の `lastResult`)。
 * 指揮官が倒れて誰も指揮を継いでいない座席は、何も命令できない(仕様 §12)。
 */
export function applyResponse(world: World, seat: AgentSeat, resp: AgentResponse): string[] {
  const out: string[] = [];
  const alive =
    seat.echelon === "company"
      ? world.companies.find((c) => c.side === seat.side && c.companyId === seat.unitId)
          ?.commanderId != null
      : seat.echelon === "platoon"
        ? world.platoons.find((p) => p.side === seat.side && p.platoonId === seat.unitId)
            ?.commanderId != null
        : world.squads.find((s) => s.side === seat.side && s.squadId === seat.unitId)
            ?.commanderId != null;
  if (!alive) return ["指揮官が不在のため命令は通らなかった"];

  resp.commands.forEach((c, i) => {
    switch (c.type) {
      case "hold":
        out.push(`#${i} hold: 現在の命令を継続`);
        return;
      case "move": {
        const t = clampToBounds(world, c.target);
        const ok = orderControlledTo(world, t, seat);
        out.push(
          ok ? `#${i} move (${t.x.toFixed(0)},${t.z.toFixed(0)}): 受理` : `#${i} move: 却下`,
        );
        return;
      }
      case "assign": {
        if (seat.echelon === "squad") {
          out.push(`#${i} assign: 分隊長は assign を出せない(move を使う)`);
          return;
        }
        const t = clampToBounds(world, c.target);
        const mission = { kind: c.mission, target: t };
        const ok =
          seat.echelon === "company"
            ? assignPlatoonMission(world, c.unit, mission, seat)
            : assignSquadMission(world, c.unit, mission, seat);
        out.push(
          ok
            ? `#${i} assign unit ${c.unit} ${c.mission} (${t.x.toFixed(0)},${t.z.toFixed(0)}): 受理`
            : `#${i} assign: unit ${c.unit} は麾下にいない`,
        );
        return;
      }
      case "reinforce": {
        const ok = orderReinforcement(world, seat);
        out.push(
          ok
            ? `#${i} reinforce: 後援部隊を要請した`
            : `#${i} reinforce: 要請できない(最上位の指揮官ではない / 回数切れ / 後援なし)`,
        );
        return;
      }
      case "fire_mission": {
        if (seat.echelon !== "company") {
          out.push(`#${i} fire_mission: 中隊長だけが出せる`);
          return;
        }
        const t = clampToBounds(world, c.target);
        const r = orderFireMission(world, t, seat);
        const at = `(${t.x.toFixed(0)},${t.z.toFixed(0)})`;
        out.push(
          !r
            ? `#${i} fire_mission: 却下`
            : r.ok
              ? `#${i} fire_mission ${at}: 受理(${r.rounds}発)`
              : `#${i} fire_mission ${at}: 却下 — ${FIRE_MISSION_BLOCK_TEXT[r.reason]}`,
        );
        return;
      }
      case "smoke": {
        if (seat.echelon !== "squad") {
          out.push(`#${i} smoke: 分隊長だけが出せる`);
          return;
        }
        const t = clampToBounds(world, c.target);
        const r = orderSmoke(world, t, seat);
        const at = `(${t.x.toFixed(0)},${t.z.toFixed(0)})`;
        out.push(
          !r
            ? `#${i} smoke: 却下`
            : r.ok
              ? `#${i} smoke ${at}: 受理`
              : `#${i} smoke ${at}: 却下 — ${SMOKE_BLOCK_TEXT[r.reason]}`,
        );
        return;
      }
      case "anti_armor": {
        if (seat.echelon !== "squad") {
          out.push(`#${i} anti_armor: 分隊長だけが出せる`);
          return;
        }
        const t = clampToBounds(world, c.target);
        const r = orderAntiArmor(world, t, seat);
        const at = `(${t.x.toFixed(0)},${t.z.toFixed(0)})`;
        out.push(
          !r
            ? `#${i} anti_armor: 却下`
            : r.ok
              ? `#${i} anti_armor ${at}: 発射(${r.hit ? "命中" : "外れ"}、${r.victims}名)`
              : `#${i} anti_armor ${at}: 却下 — ${ANTI_ARMOR_BLOCK_TEXT[r.reason]}`,
        );
        return;
      }
      case "plan": {
        // 作戦の書き換え(`[v7.3]` A-1)。人間と同じ `editPlan` を通る(中隊長の座席・立案中だけ)
        const r = editPlan(world, planEditOf(seat, c), seat);
        out.push(r.ok ? `#${i} plan ${c.op}: 受理` : `#${i} plan ${c.op}: 却下 — ${PLAN_EDIT_BLOCK_TEXT[r.reason]}`);
        return;
      }
      case "casevac": {
        if (seat.echelon !== "squad") {
          out.push(`#${i} casevac: 分隊長だけが出せる`);
          return;
        }
        const ok = orderCasevac(world, undefined, seat);
        out.push(ok ? `#${i} casevac: 後送を命じた` : `#${i} casevac: 後送できる負傷者がいない`);
        return;
      }
    }
  });
  return out;
}
