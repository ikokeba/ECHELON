/**
 * 振り返り・リプレイの記録と再生(`[v7.2]` ロードマップ S-4)。
 *
 * **記録するのは命令だけ。** シムは決定論的(ロードマップ P3)なので、同じ初期条件
 * (初期条件コード)から始めて、同じティックに同じ命令を入れれば同じ戦闘になる。
 * 盤面のスナップショットを何百枚も持つ必要はない。
 *
 * 記録の中身は2種類:
 *   order  人間・LLM が出した命令(`playerOrders.ts` の公開関数を通ったもの)
 *   state  そのティックの開始時点の「外から変えられる設定」— 操作中の座席、LLM の座席、
 *          デバッグスライダー(索敵距離など)、陣営の性格、ドクトリン。変わったときだけ記録する
 *
 * 再生は `applyReplay` を各ティックの前に呼ぶだけ。AI の判断は記録しない — AI は
 * 同じ入力から同じ判断をするので、記録する必要がない。
 */

import type { ControlState } from "./control.ts";
import type { Doctrine } from "./doctrine.ts";
import type { Posture, Side, Tuning } from "./types.ts";
import type { World } from "./world.ts";
import { replayOrder } from "./playerOrders.ts";

/** 記録できる命令(`playerOrders.ts` の公開関数名) */
export type OrderFn =
  | "orderSquadTo"
  | "orderPlatoonTo"
  | "orderCompanyTo"
  | "orderFireteamTo"
  | "orderSoldierTo"
  | "orderHold"
  | "orderCasevac"
  | "orderControlledTo"
  | "assignPlatoonMission"
  | "assignSquadMission"
  | "orderReinforcement"
  | "orderFireMission"
  | "orderSmoke"
  | "orderAntiArmor";

export interface ReplayState {
  control: ControlState | null;
  agentSeats: ControlState[];
  tuning: Tuning;
  posture: Record<Side, Posture>;
  doctrine: Record<Side, Doctrine>;
}

export type ReplayEntry =
  | {
      tick: number;
      kind: "order";
      fn: OrderFn;
      seat: ControlState | null;
      /** 引数(JSON にできる値だけ: 座標・番号・任務) */
      args: unknown[];
    }
  | { tick: number; kind: "state"; state: ReplayState };

function stateOf(world: World): ReplayState {
  return JSON.parse(
    JSON.stringify({
      control: world.control,
      agentSeats: world.agentSeats,
      tuning: world.tuning,
      posture: world.posture,
      doctrine: world.doctrine,
    }),
  ) as ReplayState;
}

/** 記録を始める。以後 `playerOrders` の命令と、ティックごとの設定の変化が `world.log` に溜まる */
export function startRecording(world: World): void {
  world.log = [];
  world.logStateKey = "";
}

/**
 * `stepWorld` の頭で呼ぶ。外から変えられる設定が前のティックから変わっていれば記録する。
 * 記録していなければ何もしない(テスト・ヘッドレス実行の既定)。
 */
export function recordState(world: World): void {
  if (!world.log) return;
  const st = stateOf(world);
  const key = JSON.stringify(st);
  if (key === world.logStateKey) return;
  world.logStateKey = key;
  world.log.push({ tick: world.tick, kind: "state", state: st });
}

/**
 * 再生の進み具合。`next` はまだ適用していない最初の記録の位置。
 * 1つの世界に1つ持ち、ティックを進める前に `applyReplay` へ渡す。
 */
export interface ReplayCursor {
  entries: readonly ReplayEntry[];
  next: number;
}

export function replayCursor(entries: readonly ReplayEntry[]): ReplayCursor {
  return { entries, next: 0 };
}

/**
 * このティックを進める**前**に呼ぶ。記録のうち `tick <= world.tick` のものを記録順に適用する。
 * 記録したときと同じ順(命令 → そのティックの設定)なので、`stepWorld` が見る状態は
 * 記録したときと同じになる。
 */
export function applyReplay(world: World, cur: ReplayCursor): void {
  while (cur.next < cur.entries.length && cur.entries[cur.next]!.tick <= world.tick) {
    const e = cur.entries[cur.next++]!;
    if (e.kind === "order") {
      replayOrder(world, e.fn, e.seat, e.args);
    } else {
      const st = JSON.parse(JSON.stringify(e.state)) as ReplayState;
      world.control = st.control;
      world.agentSeats = st.agentSeats;
      Object.assign(world.tuning, st.tuning);
      Object.assign(world.posture.blue, st.posture.blue);
      Object.assign(world.posture.red, st.posture.red);
      world.doctrine.blue = st.doctrine.blue;
      world.doctrine.red = st.doctrine.red;
    }
  }
}

/** 記録の最後のティック(記録が無ければ 0) */
export function lastLoggedTick(entries: readonly ReplayEntry[]): number {
  return entries.length > 0 ? entries[entries.length - 1]!.tick : 0;
}
