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

import type { Echelon, Side, Soldier } from "./types.ts";
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

  // 分隊長以上の身体は「いま指揮を執っている者」= commanderId で決まる(仕様 §12)。
  // 肩書きで探すと、指揮官が倒れて次席者が継承したあとに身体を見失う。
  if (c.echelon === "squad") {
    const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
    return sq?.commanderId ?? null;
  }
  if (c.echelon === "platoon") {
    const pl = world.platoons.find((p) => p.side === c.side && p.platoonId === c.unitId);
    return pl?.commanderId ?? null;
  }
  if (c.echelon === "company") {
    const co = world.companies.find((x) => x.side === c.side && x.companyId === c.unitId);
    return co?.commanderId ?? null;
  }
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
  if (isControlled(world.control, echelon, side, unitId)) return true;
  // 外部エージェント(LLM)の座席も、人間の操作と同じ意味でAIを止める(`[v7.0]`)
  for (const seat of world.agentSeats) {
    if (isControlled(seat, echelon, side, unitId)) return true;
  }
  return false;
}

/**
 * この兵士に人間(またはエージェント)が一兵卒として座っているか(`[v7.3]` ロードマップ A-7)。
 * 座っている兵士には、FTリーダーAI・本部の位置取りが命令を出さない。応急手当・担架の
 * 自動の割り当てにも選ばない — 自分の足で動いている人を勝手に担架に就けない。
 */
export function soldierSeated(world: World, s: Soldier): boolean {
  return aiSuppressed(world, "soldier", s.side, s.id);
}
