/**
 * 死傷とバディエイド(仕様 §9)。
 *
 * 流れ:
 *   被弾 → 30% KIA / 70% WIA(combat.ts で判定)
 *   WIA → 出血タイマー45秒。未処置でこれを過ぎるとKIAへ
 *   最寄りの健常な隊員が応急手当担当(assignedAider)として動的に割り当てられる
 *   担当者は「制圧射撃継続」と「応急手当着手」を状況で切り替える
 *   手当完了 → 止血・安定化。出血は止まるが行動不能のまま(後送を要する)
 *
 * `[v6]` 処置時間はFT単位MOS 2段階モデル: 通常3秒 / 衛生要員兼任1.5秒。
 * (分隊単位3段階モデルは破棄済み。詳細は仕様 §9 の決定経緯を参照)
 *
 * 未実装: 担架搬送によるCCPへの後送(仕様 §9 の後半)。止血までを本スライスの範囲とする。
 */

import {
  AID_RADIUS,
  AID_SWITCH_BLEED_REMAIN_SEC,
  BUDDY_AID_SEC,
  SIM_DT,
  SIM_HZ,
} from "../constants.ts";
import type { Soldier } from "../types.ts";
import type { World } from "../world.ts";

const AID_SWITCH_REMAIN_TICKS = Math.round(AID_SWITCH_BLEED_REMAIN_SEC * SIM_HZ);
const AID_RADIUS_SQ = AID_RADIUS * AID_RADIUS;

/** この兵士が1件の応急手当に要するティック数(仕様 §9 `[v6]`)。 */
export function aidTicksFor(aider: Soldier): number {
  const sec = aider.quals.medicalCrossTrained
    ? BUDDY_AID_SEC.crossTrained
    : BUDDY_AID_SEC.normal;
  return Math.round(sec / SIM_DT);
}

function dist2(a: Soldier, b: Soldier): number {
  const dx = a.pos.x - b.pos.x;
  const dz = a.pos.z - b.pos.z;
  return dx * dx + dz * dz;
}

/** 手当を要する状態か(WIAで、まだ止血されていない)。 */
function needsAid(s: Soldier): boolean {
  return s.status === "wia" && !s.stabilized;
}

/**
 * この兵士がいま応急手当に拘束されているか。
 *
 * 仕様 §9 は応急手当を「各隊員が個別判断で行える(命令不要、自律トリガー)」と
 * 定めている。つまり手当は命令系統の外側で発生する行動であり、C2層の命令より
 * 優先される。C2層(c2/fireteam.ts の issue)はこの判定を見て、手当中の隊員へは
 * 命令を出さない。そうしないと0.3秒ごとの命令更新で手当が中断され続ける。
 */
export function isCommittedToAid(world: World, s: Soldier): boolean {
  if (s.treating === null || s.status !== "ok") return false;
  const patient = world.soldierById.get(s.treating);
  if (!patient || !needsAid(patient)) return false;
  // 交戦中で、かつ出血タイマーに余裕があるうちは制圧射撃を優先する(拘束されていない)
  const remain = patient.bleedOutTick - world.tick;
  const engaged = s.sees.length > 0;
  const urgent = remain <= AID_SWITCH_REMAIN_TICKS;
  return !engaged || urgent;
}

export function casualtiesSystem(world: World): void {
  // ── 1. 出血の進行。未処置のまま45秒経過でKIAへ ──
  for (const s of world.soldiers) {
    if (s.status === "wia" && !s.stabilized && s.bleedOutTick > 0 && world.tick >= s.bleedOutTick) {
      s.status = "kia";
      s.bleedOutTick = 0;
      s.assignedAider = null;
    }
  }

  // ── 2. 無効になった担当割り当ての解除 ──
  for (const s of world.soldiers) {
    if (s.treating === null) continue;
    const patient = world.soldierById.get(s.treating);
    // 手当対象が死亡/止血済み、あるいは自分が戦闘不能になったら中断
    if (!patient || !needsAid(patient) || s.status !== "ok") {
      if (patient && patient.assignedAider === s.id) patient.assignedAider = null;
      s.treating = null;
      s.aidProgressTicks = 0;
    }
  }
  for (const s of world.soldiers) {
    if (s.assignedAider === null) continue;
    const aider = world.soldierById.get(s.assignedAider);
    if (!aider || aider.status !== "ok" || !needsAid(s)) {
      s.assignedAider = null;
    }
  }

  // ── 3. 担当の割り当て: 最寄りの健常な同分隊員(仕様 §9) ──
  for (const patient of world.soldiers) {
    if (!needsAid(patient) || patient.assignedAider !== null) continue;

    let best: Soldier | null = null;
    let bestD = Infinity;
    for (const cand of world.soldiers) {
      if (cand.side !== patient.side || cand.squadId !== patient.squadId) continue;
      if (cand.status !== "ok" || cand.treating !== null) continue;
      // 担架搬送に就いている隊員は手当に回せない(仕様 §9: 搬送要員は搬送に専念)
      if (cand.bearing !== null) continue;
      const d = dist2(cand, patient);
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
    if (best) {
      patient.assignedAider = best.id;
      best.treating = patient.id;
      best.aidProgressTicks = 0;
    }
  }

  // ── 4. 手当の実行 ──
  for (const aider of world.soldiers) {
    if (aider.treating === null || aider.status !== "ok") continue;
    const patient = world.soldierById.get(aider.treating);
    if (!patient) continue;

    // 交戦中は、出血タイマーに余裕があるかぎり制圧射撃を継続する(仕様 §9)。
    // 残りが15秒を切ったら射撃を中断して手当へ移行する。
    const remain = patient.bleedOutTick - world.tick;
    const engaged = aider.sees.length > 0;
    const urgent = remain <= AID_SWITCH_REMAIN_TICKS;
    if (engaged && !urgent) {
      aider.aidProgressTicks = 0;
      continue;
    }

    // 手当実行半径2.0m以内でなければ、まず近づく
    if (dist2(aider, patient) > AID_RADIUS_SQ) {
      aider.aidProgressTicks = 0;
      aider.order = {
        kind: "move",
        target: { ...patient.pos },
        facing: { ...aider.facing },
        issuedTick: world.tick,
      };
      continue;
    }

    // 手当中。処置者は露出度が上がる(仕様 §9: 対象は処置者のみ)
    aider.order = {
      kind: "hold",
      facing: { ...aider.facing },
      issuedTick: world.tick,
    };
    aider.path = [];
    aider.pathIdx = 0;
    aider.aidProgressTicks += 1;

    if (aider.aidProgressTicks >= aidTicksFor(aider)) {
      // 止血・安定化完了。出血は止まるが行動不能のままで後送を要する
      patient.stabilized = true;
      patient.bleedOutTick = 0;
      patient.assignedAider = null;
      aider.treating = null;
      aider.aidProgressTicks = 0;
    }
  }
}
