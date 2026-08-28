/**
 * ホットスワップと人間による操作(仕様 §4)。
 *
 * 本作の設計原則(仕様 §1・§4・§13):
 *   **人間はAIの意思決定者を「置き換える」のであって、能力を追加しない。**
 *
 * したがってこのモジュールは「人間が操作しているノードはどれか」を保持するだけで、
 * 命令の受信箱・報告の送信箱・world picture といった配管は一切変えない。
 * AIコントローラは操作中のノードをスキップし、人間が出した命令をそのまま実行する。
 * 逆にスワップを解除すれば、AIが**現在の状態のまま**判断を再開する(仕様 §4:
 * 「既存の任務・ステートを維持したまま自律行動を続ける」)。
 *
 * この構造だからこそ、敵軍も自軍とまったく同じロジックで動かせる(仕様 §2/§13)。
 */

import type { Echelon, Side } from "./types.ts";
import type { World } from "./world.ts";

/**
 * いま人間が操作しているノード。同時に1つだけ(シングルプレイのため、仕様 §15)。
 * null は全ユニットがAI制御。
 */
export interface ControlState {
  echelon: Echelon;
  side: Side;
  /**
   * 操作対象の識別子。階層によって意味が変わる:
   *   soldier / fireteam : 兵士ID(FTリーダー本人)
   *   squad              : squadId
   *   platoon            : platoonId
   */
  unitId: number;
}

/** 指定した階層・ユニットが人間の操作下にあるか。 */
export function isControlled(
  control: ControlState | null,
  echelon: Echelon,
  side: Side,
  unitId: number,
): boolean {
  return (
    control !== null &&
    control.echelon === echelon &&
    control.side === side &&
    control.unitId === unitId
  );
}

/**
 * 操作対象へスワップする。仕様 §4 のとおり、クールダウン・距離制限・視界制限は設けない。
 * 直前まで操作していたユニットは、状態を保ったまま即座にAI制御へ戻る
 * (このモジュールは状態を一切リセットしないので、これは自動的に成り立つ)。
 */
export function swapTo(world: World, next: ControlState | null): void {
  world.control = next;
}

/** 操作対象の身体(カメラの追従先)。上位階層では指揮官本人の兵士を返す。 */
export function controlledSoldierId(world: World): number | null {
  const c = world.control;
  if (!c) return null;

  if (c.echelon === "soldier" || c.echelon === "fireteam") return c.unitId;

  if (c.echelon === "squad") {
    const sl = world.soldiers.find(
      (s) => s.side === c.side && s.squadId === c.unitId && s.isSquadLeader,
    );
    return sl?.id ?? null;
  }

  // 小隊長・中隊長の身体は未実装(仕様 §2 の小隊本部・中隊本部が未編成のため)。
  // 現状は俯瞰視点のみで、追従する身体を持たない。
  return null;
}

/**
 * 人間が操作している階層に対応する「AIを止めるべきか」の判定。
 * 各AIコントローラの先頭で呼ぶ。
 */
export function aiSuppressed(
  world: World,
  echelon: Echelon,
  side: Side,
  unitId: number,
): boolean {
  return isControlled(world.control, echelon, side, unitId);
}
