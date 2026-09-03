import type { Posture } from "@sim/types.ts";
import type { TuningUi } from "./store.ts";

/**
 * デバッグパネルのスライダー定義。`[v6.9]` DebugPanel.tsx から切り出した
 * (コンポーネント以外を同じファイルから export すると Fast Refresh が効かなくなる)。
 *
 * 範囲が既定値を含んでいるかは `test/debugSliders.test.ts` が見張っている。
 */

/**
 * 共通パラメータのスライダー。
 *
 * **上限は必ず定数の既定値より大きく取ること。** `[v6.9]` 索敵距離の上限が 40 のまま
 * 残っていて、既定値 `DETECT_RANGE = 150`(仕様 §10 でライフルの射程を本来の値へ戻した
 * ときの変更)がスライダーの右端に張り付いて見えていた。表示だけの問題では済まず、
 * 一度つまむと値が 40 以下へ落ちて索敵距離が 1/4 になる。
 * 既定値が範囲に入っているかは `test/debugSliders.test.ts` が見張っている。
 */
export interface SliderDef {
  key: keyof TuningUi;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt?: (n: number) => string;
}
export const COMMON_SLIDERS: SliderDef[] = [
  // 上限は選抜射手の索敵距離(`DM_DETECT_RANGE` = 300、仕様 §10)に合わせてある
  { key: "detectRange", label: "索敵距離 (m)", min: 20, max: 300, step: 5 },
  { key: "fovDeg", label: "視界角 (度・正面中心)", min: 30, max: 200, step: 5 },
  { key: "fireAlignDeg", label: "実射の正対角 (±度)", min: 2, max: 45, step: 1 },
  { key: "moveSpeed", label: "移動速度 (m/s)", min: 0.5, max: 6, step: 0.1, fmt: (n) => n.toFixed(1) },
  { key: "turnRateDeg", label: "旋回速度 (度/秒)", min: 60, max: 720, step: 10 },
];

/** 陣営別 性格パラメータの個別スライダー。すべて identity(乗数1 / 絶対値=定数)中心。 */
export const POSTURE_KNOBS: Array<{
  key: Exclude<keyof Posture, "riskTolerance">;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "engageMinMul", label: "最小交戦距離 ×", min: 0.5, max: 1.5, step: 0.05 },
  { key: "engageMaxMul", label: "最大交戦距離 ×", min: 0.5, max: 1.5, step: 0.05 },
  { key: "boundMinMul", label: "躍進歩幅・最小 ×", min: 0.5, max: 2, step: 0.05 },
  { key: "boundMaxMul", label: "躍進歩幅・最大 ×", min: 0.5, max: 2, step: 0.05 },
  { key: "fallbackDeficit", label: "劣勢許容(人数差)", min: -2, max: 4, step: 1 },
  { key: "techniqueRangeMul", label: "警戒前進しきい ×", min: 0.5, max: 1.5, step: 0.05 },
  { key: "coverPref", label: "露出回避度", min: 0.5, max: 2, step: 0.05 },
  { key: "offensiveRatio", label: "攻勢分遣の兵力比", min: 1, max: 2.5, step: 0.1 },
];
