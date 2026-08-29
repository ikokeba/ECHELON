/**
 * 実行時チューニング層(`[v6.1]`)。
 *
 * デバッグパネルのスライダーが動かす値を `constants.ts` から切り離す。既定値は定数
 * そのままなので、**誰もスライダーを触らなければシムの挙動は現状と完全一致**する
 * (`test/symmetry.test.ts` / `test/determinism.test.ts` はここに触れないため不変)。
 *
 * 値は `world` に乗せる(`world.tuning` / `world.posture`)。世界が唯一のミュータブル
 * コンテナである原則を崩さず、シリアライズ可能性も保つため。
 */

import {
  DETECT_RANGE,
  FIRE_ALIGN_RAD,
  FOV_HALF_RAD,
  MOVE_SPEED,
  TURN_RATE,
} from "./constants.ts";
import type { Posture, Side, Tuning } from "./types.ts";

/** FTリーダーAIの後退判断で使う劣勢人数差の基準(fireteam.ts と同じ値)。 */
const FALLBACK_DEFICIT_BASE = 1;

/** 攻勢分遣の発動兵力比の既定(F-2)。 */
export const OFFENSIVE_RATIO_DEFAULT = 1.3;

/** 定数そのままの共通チューニング。 */
export function defaultTuning(): Tuning {
  return {
    detectRange: DETECT_RANGE,
    fovHalfRad: FOV_HALF_RAD,
    fireAlignRad: FIRE_ALIGN_RAD,
    moveSpeed: MOVE_SPEED,
    turnRate: TURN_RATE,
  };
}

/**
 * リスク許容度 0..1 を各性格パラメータへ写像する。`rt === 0.5` で全 identity。
 * マスタースライダーを動かしたとき、個別値をこの値へまとめて再設定する。
 */
export function postureFromRisk(rt: number): Omit<Posture, "riskTolerance"> {
  // r: -1(最も慎重)‥0(中立)‥+1(最も強気)
  const r = (rt - 0.5) * 2;
  return {
    engageMinMul: 1 - r * 0.4, // 強気ほど交戦距離を詰める
    engageMaxMul: 1 - r * 0.4,
    boundMinMul: 1 + r * 0.5, // 強気ほど躍進が大きい
    boundMaxMul: 1 + r * 0.5,
    fallbackDeficit: FALLBACK_DEFICIT_BASE + Math.round(r * 2), // 強気ほど粘る
    techniqueRangeMul: 1 - r * 0.35, // 強気ほど近づくまで警戒しない
    coverPref: 1 - r * 0.4, // 慎重ほど露出を嫌う
    offensiveRatio: OFFENSIVE_RATIO_DEFAULT, // 兵力比しきい値は riskTolerance では動かさない
  };
}

/** 中立(0.5)= 全 identity。この時点で下位係数がすべて現行定数と一致する。 */
export function defaultPosture(): Record<Side, Posture> {
  const make = (): Posture => ({ riskTolerance: 0.5, ...postureFromRisk(0.5) });
  return { blue: make(), red: make() };
}
