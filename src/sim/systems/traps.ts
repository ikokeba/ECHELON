/**
 * 仕掛け爆弾(`[v7.7]` ロードマップ B-4 混成型の編成)。
 *
 * 混成型の防御側の中隊長が、立案のときに拠点の建物の入口の外(拠点が屋外なら接近路)に置く
 * 1回きりの罠(c2/defense.ts `planDefense`)。**攻撃側には見えない**(陣地と同じ、P1)。
 *
 *   - 敵が `TRAP.TRIGGER` m まで来たら炸裂する。踏んだ者は `KILL_CHANCE`、まわりの敵は `SPLASH_CHANCE`。
 *     損害は敵にだけ、制圧は敵味方とも(迫撃砲・自爆ドローンと同じ、仕様 §8.2/§8.6)
 *   - **気づけば外せる**。罠から `SPOT_RANGE` m 以内で、罠が見える向きにいて視線の通る敵は、
 *     毎秒 `SPOT_RATE`(躍進前進で慎重に進む班は `SPOT_RATE_CAREFUL`)の確率で気づき、避けて通る
 *     (罠は無くなる)。罠への対抗は「急がない」こと — 速さと安全の駆け引きになる
 *
 * 気づくのは見た者の陣営の乱数列から引く(P3)。陣営で分岐しない(P2)。
 */

import { HEARING, SIM_DT, SIM_HZ, SUPPRESSION_GRACE_TICKS, TRAP } from "../constants.ts";
import { chance, ratePerTick } from "../rng.ts";
import { hasLineOfSightIndexed } from "../wallIndex.ts";
import { isOffField } from "./litter.ts";
import type { DefensivePosition, Soldier } from "../types.ts";
import type { World } from "../world.ts";

const SUPPRESS_TICKS = Math.round(1.5 * SIM_HZ) + SUPPRESSION_GRACE_TICKS;

function armed(p: DefensivePosition): boolean {
  return p.kind === "trap" && p.stage !== "sprung" && p.stage !== "released";
}

function standing(s: Soldier): boolean {
  return s.status === "ok" && !isOffField(s);
}

function detonate(world: World, p: DefensivePosition, trigger: Soldier): void {
  const rng = world.rngBySide[p.side];
  let victims = 0;
  for (const s of world.soldiers) {
    if (!standing(s)) continue;
    const r = Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z);
    if (r > TRAP.SUPPRESS_RADIUS) continue;
    s.suppressedUntilTick = Math.max(s.suppressedUntilTick, world.tick + SUPPRESS_TICKS);
    if (s.side === p.side) continue;
    const prob = s.id === trigger.id ? TRAP.KILL_CHANCE : r <= TRAP.BLAST_RADIUS ? TRAP.SPLASH_CHANCE : 0;
    if (prob > 0 && chance(rng, prob)) {
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = 0;
      victims++;
    }
  }
  p.stage = "sprung";
  p.stageTick = world.tick;
  world.fx.push({ kind: "trap", at: { ...p.pos }, side: p.side, radius: TRAP.BLAST_RADIUS, victims });
  world.gunshots.push({ sourceId: trigger.id, side: p.side, pos: { ...p.pos }, range: HEARING.RANGE.grenade });
}

/** 慎重に進んでいるか(その兵のFTが躍進前進) */
function careful(world: World, s: Soldier): boolean {
  if (s.fireteamId < 0) return false;
  const ft = world.fireteams.find(
    (f) => f.side === s.side && f.squadId === s.squadId && f.ftIndex === s.fireteamId,
  );
  return ft?.technique === "bounding_overwatch";
}

/** 毎ティック: 移動のあと(位置が決まってから)、戦闘の前に呼ぶ */
export function trapSystem(world: World): void {
  for (const p of world.defense) {
    if (!armed(p)) continue;
    let trigger: Soldier | null = null;
    for (const s of world.soldiers) {
      if (s.side === p.side || !standing(s)) continue;
      const r = Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z);
      if (r <= TRAP.TRIGGER) {
        trigger = s;
        break;
      }
    }
    if (trigger) {
      detonate(world, p, trigger);
      continue;
    }
    // 気づく。罠の方を向いていて(視界の前半分)、視線が通る者だけ
    for (const s of world.soldiers) {
      if (s.side === p.side || !standing(s)) continue;
      const dx = p.pos.x - s.pos.x;
      const dz = p.pos.z - s.pos.z;
      const r = Math.hypot(dx, dz);
      if (r > TRAP.SPOT_RANGE || r < 1e-6) continue;
      if ((s.facing.x * dx + s.facing.z * dz) / r < 0) continue;
      if (!hasLineOfSightIndexed(world.wallIndex, s.pos.x, s.pos.z, p.pos.x, p.pos.z)) continue;
      const rate = careful(world, s) ? TRAP.SPOT_RATE_CAREFUL : TRAP.SPOT_RATE;
      if (chance(world.rngBySide[s.side], ratePerTick(rate, SIM_DT))) {
        p.stage = "released";
        p.stageTick = world.tick;
        break;
      }
    }
  }
}
