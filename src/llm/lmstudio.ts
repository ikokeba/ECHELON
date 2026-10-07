/**
 * LM Studio(ローカルLLM)への接続(`[v7.0]`)。
 *
 * LM Studio の「Local Server」は OpenAI 互換の HTTP API を出している
 * (既定 `http://localhost:1234/v1`)。ここで使うのは2つだけ:
 *
 *   GET  /v1/models            読み込まれているモデルの一覧(model 未指定時に先頭を使う)
 *   POST /v1/chat/completions  観測を渡して命令を受け取る
 *
 * 構造化出力(`response_format: json_schema`)を既定で要求する。LM Studio は
 * llama.cpp の文法制約でこれを守らせるので、小さなモデルでも JSON が崩れにくい。
 * 古い版などで 400 が返ったら、以後は付けずに送り直す(本文から JSON を探す)。
 *
 * ブラウザから直接叩くと CORS で止まる。開発サーバ経由では Vite のプロキシ
 * (`/lmstudio` → LM Studio、vite.config.ts)を使うので、LM Studio 側の設定は要らない。
 * Node(`npm run llm`)からは直接繋ぐ。
 */

import type { Agent, AgentReply } from "./agent.ts";
import { DEFAULT_SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import { RESPONSE_SCHEMA, type Observation } from "./protocol.ts";

export interface LmStudioConfig {
  /** 例: "http://localhost:1234"(Node)/ "/lmstudio"(ブラウザ、Vite プロキシ経由) */
  baseUrl: string;
  /** 省略時は /v1/models の先頭 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 1回の問い合わせの上限 ms。超えたら打ち切り、その回は命令なしになる */
  timeoutMs?: number;
  /** 構造化出力を要求するか(既定 true) */
  jsonSchema?: boolean;
  systemPrompt?: string;
}

export const DEFAULT_LMSTUDIO: Required<Omit<LmStudioConfig, "model">> = {
  baseUrl: "http://localhost:1234",
  temperature: 0.3,
  maxTokens: 800,
  timeoutMs: 60_000,
  jsonSchema: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** 読み込まれているモデルの一覧。疎通確認にも使う */
export async function listModels(baseUrl: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/models`, { signal });
  if (!res.ok) throw new Error(`GET /v1/models → HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((m) => m.id ?? "").filter((s) => s.length > 0);
}

/** 2つの AbortSignal のどちらかで止まる signal(外からの中断 + タイムアウト) */
function anySignal(
  a: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout ${ms}ms`)), ms);
  const onAbort = () => ctl.abort(a?.reason);
  a?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      a?.removeEventListener("abort", onAbort);
    },
  };
}

export function createLmStudioAgent(config: LmStudioConfig): Agent {
  const cfg = { ...DEFAULT_LMSTUDIO, ...config };
  const base = trimSlash(cfg.baseUrl);
  let model = config.model;
  let useSchema = cfg.jsonSchema;

  const post = async (obs: Observation, signal: AbortSignal): Promise<Response> => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: cfg.systemPrompt },
        { role: "user", content: userMessage(obs) },
      ],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: false,
    };
    if (useSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "echelon_orders", strict: false, schema: RESPONSE_SCHEMA },
      };
    }
    return fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  };

  return {
    get name() {
      return `LM Studio: ${model ?? "(未選択)"}`;
    },
    async decide(obs: Observation, outer?: AbortSignal): Promise<AgentReply> {
      const t0 = performance.now();
      const { signal, done } = anySignal(outer, cfg.timeoutMs);
      try {
        if (!model) {
          const models = await listModels(base, signal);
          if (models.length === 0) throw new Error("LM Studio にモデルが読み込まれていない");
          model = models[0];
        }
        let res = await post(obs, signal);
        if (res.status === 400 && useSchema) {
          // 構造化出力に対応していない版。以後は付けずに送る
          useSchema = false;
          res = await post(obs, signal);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`POST /v1/chat/completions → HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const raw = data.choices?.[0]?.message?.content ?? "";
        return { raw, payload: raw, latencyMs: performance.now() - t0 };
      } finally {
        done();
      }
    },
  };
}
