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

/** 両陣営とも中立(0.5)。この時点では下位係数がすべて現行定数と一致する。 */
export function defaultPosture(): Record<Side, Posture> {
  return {
    blue: { riskTolerance: 0.5 },
    red: { riskTolerance: 0.5 },
  };
}

/**
 * リスク許容度 0..1 を、FTリーダーAIが使う各しきい値の乗数/加算へ写像する。
 * `riskTolerance === 0.5` で恒等(乗数1・加算0)になるよう線形に組む。
 */
export interface PostureFactors {
  /** 交戦距離帯(ENGAGE_MIN/MAX)への乗数。強気ほど小さい=詰める。0.5→1.0 */
  engageRangeMul: number;
  /** 前進歩幅(BOUND_MIN/MAX_ADV)への乗数。強気ほど大きい。0.5→1.0 */
  boundStepMul: number;
  /** 後退を判断する劣勢人数差への加算。強気ほど大きい=粘る。0.5→0 */
  fallbackDeficitBonus: number;
  /** 小隊長の移動技術しきい距離への乗数。強気ほど小さい=近づくまで警戒しない。0.5→1.0 */
  techniqueRangeMul: number;
}

export function postureFactors(p: Posture): PostureFactors {
  // r: -1(最も慎重)‥0(中立)‥+1(最も強気)
  const r = (p.riskTolerance - 0.5) * 2;
  return {
    engageRangeMul: 1 - r * 0.4, // 0.1 の強気で交戦距離 -8%
    boundStepMul: 1 + r * 0.5,
    fallbackDeficitBonus: Math.round(r * 2), // ±2人まで
    techniqueRangeMul: 1 - r * 0.35,
  };
}
