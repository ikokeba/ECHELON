/**
 * エージェントの座席を世界へ取り付け、一定間隔で「観測 → 応答 → 命令」を回す(`[v7.0]`)。
 *
 * 2つの回し方がある:
 *
 *   `poll(world)`   **非同期**。ブラウザの描画ループから毎フレーム呼ぶ。問い合わせ中も
 *                   時間は流れ続け、応答が届いたフレームで命令を適用する。LLM の
 *                   考える時間がそのまま「無線で命令が届くまでの遅れ」になる
 *   `decideNow()`   **同期**。ヘッドレス実行(`npm run llm`)用。応答が届くまで時間を
 *                   止める。モデルの出力が同じなら戦闘は厳密に再現される(シムは決定論的)
 *
 * どちらでも、命令の適用はティックとティックのあいだでしか起きない。
 */

import { SIM_HZ } from "../sim/constants.ts";
import type { World } from "../sim/world.ts";
import type { Agent } from "./agent.ts";
import { applyResponse, parseResponse } from "./commands.ts";
import { buildObservation } from "./observe.ts";
import type { AgentSeat, Observation } from "./protocol.ts";

export interface SessionLogEntry {
  /** 観測を作ったティック */
  tick: number;
  /** 命令を適用したティック(問い合わせ中に時間が流れたぶん tick より後) */
  appliedTick: number | null;
  intent: string | null;
  results: string[];
  errors: string[];
  latencyMs: number;
  raw: string;
}

export interface LlmSessionOptions {
  seat: AgentSeat;
  agent: Agent;
  /** 何秒(シム時間)おきに問い合わせるか */
  intervalSec: number;
  /** ログの保持件数 */
  maxLog?: number;
}

export interface LlmSession {
  readonly seat: AgentSeat;
  readonly agent: Agent;
  readonly log: readonly SessionLogEntry[];
  /** 問い合わせ中か */
  readonly busy: boolean;
  /** 座席を世界へ取り付ける(そのノードのAIが止まる) */
  attach(world: World): void;
  /** 座席を外す(AIが現在の状態のまま判断を再開する、仕様 §4) */
  detach(world: World): void;
  poll(world: World): void;
  decideNow(world: World): Promise<SessionLogEntry | null>;
  /** 直近の観測(デバッグ表示用) */
  readonly lastObservation: Observation | null;
}

function sameSeat(a: AgentSeat, b: { side: string; echelon: string; unitId: number }): boolean {
  return a.side === b.side && a.echelon === b.echelon && a.unitId === b.unitId;
}

export function createLlmSession(opts: LlmSessionOptions): LlmSession {
  const intervalTicks = Math.max(1, Math.round(opts.intervalSec * SIM_HZ));
  const maxLog = opts.maxLog ?? 50;
  const log: SessionLogEntry[] = [];
  let lastAskTick = -Infinity;
  /** 立案中に1度だけ作戦を尋ねたか(`[v7.3]` A-1。中隊長の座席) */
  let askedInPlanning = false;
  let busy = false;
  let lastResult: string[] = [];
  let lastObservation: Observation | null = null;
  let abort: AbortController | null = null;
  /** 非同期で届いた応答。次の poll で適用する */
  let pending: { entry: SessionLogEntry; payload: unknown } | null = null;

  const push = (e: SessionLogEntry): void => {
    log.push(e);
    if (log.length > maxLog) log.splice(0, log.length - maxLog);
  };

  const apply = (world: World, entry: SessionLogEntry, payload: unknown): void => {
    const parsed = parseResponse(payload);
    entry.errors.push(...parsed.errors);
    if (parsed.response) {
      entry.intent = parsed.response.intent ?? null;
      entry.results = applyResponse(world, opts.seat, parsed.response);
    }
    entry.appliedTick = world.tick;
    lastResult = [...entry.results, ...entry.errors.map((e) => `エラー: ${e}`)];
  };

  const ask = async (
    world: World,
  ): Promise<{ entry: SessionLogEntry; payload: unknown } | null> => {
    const obs = buildObservation(world, opts.seat, lastResult);
    if (!obs) return null;
    lastObservation = obs;
    const entry: SessionLogEntry = {
      tick: world.tick,
      appliedTick: null,
      intent: null,
      results: [],
      errors: [],
      latencyMs: 0,
      raw: "",
    };
    abort = new AbortController();
    try {
      const reply = await opts.agent.decide(obs, abort.signal);
      entry.raw = reply.raw;
      entry.latencyMs = Math.round(reply.latencyMs);
      return { entry, payload: reply.payload };
    } catch (e) {
      entry.errors.push(`通信失敗: ${e instanceof Error ? e.message : String(e)}`);
      return { entry, payload: null };
    } finally {
      abort = null;
    }
  };

  return {
    seat: opts.seat,
    agent: opts.agent,
    get log() {
      return log;
    },
    get busy() {
      return busy;
    },
    get lastObservation() {
      return lastObservation;
    },
    attach(world) {
      if (!world.agentSeats.some((s) => sameSeat(opts.seat, s))) {
        world.agentSeats.push({ ...opts.seat });
      }
    },
    detach(world) {
      abort?.abort();
      world.agentSeats = world.agentSeats.filter((s) => !sameSeat(opts.seat, s));
    },
    poll(world) {
      if (pending) {
        const p = pending;
        pending = null;
        if (p.payload !== null) apply(world, p.entry, p.payload);
        else lastResult = p.entry.errors.map((e) => `エラー: ${e}`);
        push(p.entry);
      }
      if (busy || world.victory) return;
      // 立案中(`[v7.3]` A-1): 中隊長の座席にだけ、作戦を書き換える機会を1度与える
      if (world.phase === "planning") {
        if (opts.seat.echelon !== "company" || askedInPlanning) return;
        askedInPlanning = true;
        busy = true;
        void ask(world).then((r) => {
          busy = false;
          if (r) pending = r;
        });
        return;
      }
      if (world.tick - lastAskTick < intervalTicks) return;
      lastAskTick = world.tick;
      busy = true;
      void ask(world).then((r) => {
        busy = false;
        if (r) pending = r;
      });
    },
    async decideNow(world) {
      lastAskTick = world.tick;
      busy = true;
      const r = await ask(world);
      busy = false;
      if (!r) return null;
      if (r.payload !== null) apply(world, r.entry, r.payload);
      else lastResult = r.entry.errors.map((e) => `エラー: ${e}`);
      push(r.entry);
      return r.entry;
    },
  };
}
