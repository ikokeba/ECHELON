/**
 * 固定タイムステップのアキュムレータ。
 *
 * 純粋関数として実装する: 呼び出し側(src/sim/ の外にある rAF ドライバ)が実時間の
 * 経過ミリ秒を渡すと、このフレームで何ティック回すべきかを返す。この分離により
 * タクティカルポーズ・スロー・早送り・1ステップ実行が自然に実現できる
 * (仕様 §1/§6: ポーズ解除後はタイムラグなしで即座に実行)。
 */

import { SIM_DT } from "./constants.ts";

export interface SimClock {
  /** フレーム間で持ち越される未消費のシミュレーション秒 */
  accumulator: number;
  /** 時間倍率。0 = 一時停止 */
  speed: number;
  /** speed に関係なく実行する1ステップ実行の予約数(ポーズ中に使用) */
  stepQueue: number;
  /** 1フレームでこれ以上のティックは回さない(デススパイラル防止) */
  maxTicksPerFrame: number;
}

export function createSimClock(speed = 1): SimClock {
  return { accumulator: 0, speed, stepQueue: 0, maxTicksPerFrame: 8 };
}

export function setSpeed(clock: SimClock, speed: number): void {
  clock.speed = Math.max(0, speed);
  if (clock.speed === 0) clock.accumulator = 0; // ポーズ中は実時間を溜め込まない
}

/** ポーズ中でも次回のドレインで実行されるティックを N 個予約する。 */
export function requestSteps(clock: SimClock, n = 1): void {
  clock.stepQueue += n;
}

/**
 * 実時間の経過ミリ秒を受け取り、いま回すべき固定ティック数を返してクロックを更新する。
 * 明示的な1ステップ実行の予約は常に優先して消化する。
 */
export function drainTicks(clock: SimClock, realElapsedMs: number): number {
  let ticks = 0;

  if (clock.stepQueue > 0) {
    ticks += clock.stepQueue;
    clock.stepQueue = 0;
  }

  if (clock.speed > 0) {
    clock.accumulator += (realElapsedMs / 1000) * clock.speed;
    while (clock.accumulator >= SIM_DT && ticks < clock.maxTicksPerFrame) {
      clock.accumulator -= SIM_DT;
      ticks += 1;
    }
    if (clock.accumulator > SIM_DT * clock.maxTicksPerFrame) {
      clock.accumulator = 0; // フレーム落ちが激しい場合は溜まった分を諦める
    }
  }

  return ticks;
}

/** 直近2つのシム状態を補間して描画するための係数 [0,1)。 */
export function renderAlpha(clock: SimClock): number {
  return clock.speed > 0 ? Math.min(1, Math.max(0, clock.accumulator / SIM_DT)) : 0;
}
