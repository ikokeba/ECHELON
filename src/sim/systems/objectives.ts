/**
 * 拠点の確保と勝敗判定(仕様 §12)。
 *
 * 仕様が確定させている規則をそのまま実装する:
 *
 *   - **メイン条件は拠点確保**。複数を同時に奪い合い、一定数を一定時間確保した側が勝つ
 *   - 拠点規模は2段階。小拠点は1名で60秒、大拠点は1名で180秒が基準
 *   - **拠点内の人数に応じて確保速度が変化する**(多いほど早い)。ただし加速上限は
 *     規模に連動し(小3名/大8名)、上限を超えた人数は混雑により追加効果なし
 *   - **コンテスト状態**: 拠点内に敵がいる間、確保カウントは**完全に停止**する
 *
 * 「分隊を集中投入すれば早く確保できる分、他方面が手薄になる」というトレードオフが
 * 仕様の狙いなので、加速上限は速度ではなく**上限**として効かせる点が要になる。
 *
 * 指揮系統の崩壊(§12 近道条件)は勝利条件ではない。あれは麾下部隊の指揮能力を
 * 落として勝利を**近づける**もので、実装は c2/succession.ts にある。
 */

import { OBJECTIVE, SIM_HZ } from "../constants.ts";
import { isOffField } from "./litter.ts";
import type { Side, Soldier } from "../types.ts";
import type { World } from "../world.ts";

const HOLD_TO_WIN_TICKS = Math.round(OBJECTIVE.HOLD_TO_WIN_SEC * SIM_HZ);

/** 拠点の確保に数えられる兵士か。倒れている者・後送済みは数えない。 */
function counts(s: Soldier): boolean {
  return s.status === "ok" && !isOffField(s);
}

export function objectivesSystem(world: World): void {
  // ── 1. 各拠点の確保進捗 ──
  for (const o of world.objectives) {
    let blue = 0;
    let red = 0;
    const r2 = o.radius * o.radius;
    for (const s of world.soldiers) {
      if (!counts(s)) continue;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      if (dx * dx + dz * dz > r2) continue;
      if (s.side === "blue") blue++;
      else red++;
    }

    o.contested = blue > 0 && red > 0;
    // コンテスト状態では確保カウントが完全に停止する(仕様 §12)。
    // 敵を排除しない限り進まない、という明快な規則。
    if (o.contested || (blue === 0 && red === 0)) continue;

    const side: Side = blue > 0 ? "blue" : "red";
    const n = Math.min(blue > 0 ? blue : red, OBJECTIVE.MAX_CAPTURERS[o.size]);
    const perTick = n / (OBJECTIVE.BASE_SEC[o.size] * SIM_HZ);

    if (o.owner !== null && o.owner !== side) {
      // 敵の拠点を奪う: まず相手の確保を剥がしてから、自分の確保を積む
      o.progress -= perTick * OBJECTIVE.DECAY_MUL;
      if (o.progress <= 0) {
        o.owner = null;
        o.progress = 0;
        o.progressBy = side;
      }
      continue;
    }

    if (o.progressBy !== side) {
      // 中立の拠点で確保側が入れ替わった。積み上げは引き継がない
      o.progressBy = side;
      o.progress = 0;
    }
    o.progress = Math.min(1, o.progress + perTick);
    if (o.progress >= 1) o.owner = side;
  }

  // ── 2. 決着の判定 ──
  if (world.victory) return;

  // 殲滅: 戦闘可能な兵士が尽きた側の負け。拠点がないシナリオでも決着がつく
  const effective = (side: Side): number =>
    world.soldiers.filter((s) => s.side === side && counts(s)).length;
  const blueLeft = effective("blue");
  const redLeft = effective("red");
  if (blueLeft === 0 || redLeft === 0) {
    if (blueLeft !== redLeft) {
      world.victory = {
        winner: blueLeft > 0 ? "blue" : "red",
        reason: "annihilation",
        tick: world.tick,
      };
    }
    return;
  }

  // 拠点確保: 過半数を一定時間維持し続けた側の勝ち
  if (world.objectives.length === 0) return;
  const held = (side: Side): number => world.objectives.filter((o) => o.owner === side).length;
  const majority = Math.floor(world.objectives.length / 2) + 1;

  // ── 攻防非対称戦(仕様 §12「モード別の追加条件」)`[v6.8]` ──
  // 防御側は最初から過半数を保有しているので、遭遇戦と同じ規則をそのまま当てると
  // 開始45秒で防御側が勝ってしまう。攻防戦の勝ち筋は左右で違う:
  //   攻撃側 = 制限時間内に過半数を奪い、`HOLD_TO_WIN_SEC` 保持する
  //   防御側 = それまで持ちこたえる(時間切れ)
  if (world.mode === "assault") {
    const attacker = world.attacker;
    const defender: Side = attacker === "blue" ? "red" : "blue";
    if (held(attacker) >= majority) {
      if (world.majoritySince[attacker] === null) world.majoritySince[attacker] = world.tick;
      if (world.tick - world.majoritySince[attacker]! >= HOLD_TO_WIN_TICKS) {
        world.victory = { winner: attacker, reason: "objectives", tick: world.tick };
        return;
      }
    } else {
      world.majoritySince[attacker] = null;
    }
    if (world.timeLimitTicks > 0 && world.tick >= world.timeLimitTicks) {
      world.victory = { winner: defender, reason: "timeout", tick: world.tick };
    }
    return;
  }

  for (const side of ["blue", "red"] as Side[]) {
    if (held(side) >= majority) {
      if (world.majoritySince[side] === null) world.majoritySince[side] = world.tick;
      if (world.tick - world.majoritySince[side]! >= HOLD_TO_WIN_TICKS) {
        world.victory = { winner: side, reason: "objectives", tick: world.tick };
        return;
      }
    } else {
      world.majoritySince[side] = null;
    }
  }
}
