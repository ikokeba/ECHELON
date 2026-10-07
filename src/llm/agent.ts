/**
 * エージェントの共通インタフェースと、通信を使わない参照実装(`[v7.0]`)。
 *
 * `Agent` は「観測を受け取って応答を返す」だけの非同期関数。LM Studio 版
 * (`lmstudio.ts`)も、テスト・配線確認用の `ruleAgent` も同じ形をしているので、
 * セッション(`session.ts`)はどちらが繋がっているかを気にしない。
 */

import type { AgentResponse, Observation } from "./protocol.ts";

export interface AgentReply {
  /** モデルの生の出力(ログ用) */
  raw: string;
  /** 解釈前の応答。文字列なら `parseResponse` が JSON を探す */
  payload: unknown;
  /** 通信・推論にかかった時間 ms */
  latencyMs: number;
}

export interface Agent {
  /** 表示名(例: "LM Studio: qwen2.5-7b-instruct") */
  name: string;
  decide(obs: Observation, signal?: AbortSignal): Promise<AgentReply>;
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 規則で動く参照エージェント。**LLM ではない。** 通信口が端から端まで繋がっているかを
 * ネットワーク無しで確かめるためのもの(テストと `npm run llm -- --mock`)。
 *
 * 判断: まだ自分のものでない拠点のうち最寄りへ向かう。中隊・小隊なら、麾下を
 * 1つずつ別の拠点へ割り振る(残りは最初の拠点への支援射撃)。
 */
export function ruleAgent(): Agent {
  return {
    name: "rule-agent (LLMなし)",
    async decide(obs: Observation): Promise<AgentReply> {
      const open = obs.map.objectives.filter((o) => o.owner !== "own");
      const resp: AgentResponse = { commands: [], intent: "未確保の拠点を順に取る" };
      if (open.length === 0) {
        resp.commands.push({ type: "hold" });
        resp.intent = "全拠点を確保済み。保持する";
      } else if (obs.you.echelon === "squad") {
        const me = obs.subordinates[0]?.pos ?? obs.you.mission?.target ?? { x: 0, z: 0 };
        const best = [...open].sort((a, b) => dist(me, a.pos) - dist(me, b.pos))[0]!;
        resp.commands.push({ type: "move", target: best.pos });
        resp.commands.push({ type: "casevac" });
      } else {
        const taken = new Set<number>();
        for (const sub of obs.subordinates) {
          if (sub.weapons) continue;
          const free = open.filter((o) => !taken.has(o.id));
          const pool = free.length > 0 ? free : open;
          const best = [...pool].sort((a, b) => dist(sub.pos, a.pos) - dist(sub.pos, b.pos))[0]!;
          if (free.length > 0) {
            taken.add(best.id);
            resp.commands.push({
              type: "assign",
              unit: sub.unit,
              mission: "seize",
              target: best.pos,
            });
          } else {
            resp.commands.push({
              type: "assign",
              unit: sub.unit,
              mission: "support_by_fire",
              target: best.pos,
            });
          }
        }
      }
      const raw = JSON.stringify(resp);
      return { raw, payload: resp, latencyMs: 0 };
    },
  };
}
