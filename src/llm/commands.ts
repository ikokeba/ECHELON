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
} from "../sim/playerOrders.ts";
import { SMOKE_BLOCK_TEXT } from "../sim/systems/smoke.ts";
import { FIRE_MISSION_BLOCK_TEXT } from "../sim/systems/indirect.ts";
import type { MissionKind, Vec2 } from "../sim/types.ts";
import type { World } from "../sim/world.ts";
import { MAX_COMMANDS, type AgentCommand, type AgentResponse, type AgentSeat } from "./protocol.ts";

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
