/**
 * 戦闘判定(仕様 §8)— 命中と制圧を決定する唯一の場所。
 * `rollShot` は純粋関数なので、バランス検証ハーネス(src/balance/)は実シムと
 * 完全に同一の計算を回すことになる。
 *
 * 仕様 §8 に従い抽象化はシンプルに保つ:
 *   - 弾薬管理なし(擲弾のみ後に例外扱い);
 *   - 同士討ちなし — 射線上に味方がいる場合は「射線が通らない」として撃たない(§8.2);
 *   - 制圧は一律 −40%(選抜射手は −10%)の命中率低下で、**余韻なし**:
 *     制圧側が発砲を止めた瞬間(1ティック以内)に解除される(§8.6)。
 *     また効果が発生するのは発砲側が「制圧役」ステートにある場合のみ。
 */

import { chance, ratePerTick, type Rng } from "../rng.ts";
import {
  BLEED_OUT_SEC,
  FIRE_ALIGN_RAD,
  HIT_RATE_PER_SEC,
  KIA_ON_HIT_CHANCE,
  SIM_DT,
  SUPPRESSION_ACC_PENALTY,
  SUPPRESSION_ACC_PENALTY_MARKSMAN,
  SUPPRESSION_GRACE_TICKS,
  SOLDIER_RADIUS,
  TURN_RATE,
} from "../constants.ts";
import type { World } from "../world.ts";
import type { Soldier, Vec2 } from "../types.ts";

export function isSuppressed(s: Soldier, tick: number): boolean {
  return s.suppressedUntilTick > tick;
}

export interface ShotContext {
  /** 射手自身がいま制圧を受けている(自分の命中率が下がる) */
  shooterSuppressed: boolean;
  /** 射手が分隊の選抜射手である(制圧ペナルティが軽い) */
  shooterIsMarksman: boolean;
}

export type ShotOutcome = { hit: false } | { hit: true; lethal: boolean };

/** 有効かつLOSが通り正対済みの目標に対する、1ティック分の射撃判定(純粋関数)。 */
export function rollShot(rng: Rng, ctx: ShotContext): ShotOutcome {
  let accMul = 1;
  if (ctx.shooterSuppressed) {
    accMul = 1 - (ctx.shooterIsMarksman ? SUPPRESSION_ACC_PENALTY_MARKSMAN : SUPPRESSION_ACC_PENALTY);
  }
  const hitP = ratePerTick(HIT_RATE_PER_SEC * accMul, SIM_DT);
  if (!chance(rng, hitP)) return { hit: false };
  return { hit: true, lethal: chance(rng, KIA_ON_HIT_CHANCE) };
}

function angleBetween(a: Vec2, b: Vec2): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
  return Math.acos(dot);
}

/** 射手→目標の線分上に味方がいる場合、射線が通らないとして射撃を中止する(§8.2)。 */
function friendlyBlocksFire(world: World, shooter: Soldier, target: Soldier): boolean {
  const sx = shooter.pos.x;
  const sz = shooter.pos.z;
  const dx = target.pos.x - sx;
  const dz = target.pos.z - sz;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const clearance = SOLDIER_RADIUS * 1.6;

  for (const f of world.soldiers) {
    if (f.side !== shooter.side || f.id === shooter.id || f.status === "kia") continue;
    const t = (f.pos.x - sx) * ux + (f.pos.z - sz) * uz;
    if (t <= 0.4 || t >= len - 0.4) continue;
    const perp = Math.hypot(f.pos.x - sx - ux * t, f.pos.z - sz - uz * t);
    if (perp < clearance) return true;
  }
  return false;
}

function nearestVisibleTarget(world: World, shooter: Soldier): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of shooter.sees) {
    const t = world.soldierById.get(id);
    if (!t || t.status !== "ok") continue;
    const d = Math.hypot(t.pos.x - shooter.pos.x, t.pos.z - shooter.pos.z);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

interface PendingShot {
  shooter: Soldier;
  target: Soldier;
  outcome: ShotOutcome;
  suppressing: boolean;
}

/**
 * 戦闘は**2フェーズ**で解決する — 全射手がティック開始時点の状態に対して判定を行い、
 * そのあとで効果をまとめて適用する。逐次に解決してしまうと、走査順が先の陣営が
 * 一方的に有利になる(mos-balance プロトタイプが検証中に踏んだ「先手バイアス」)。
 * これは戦力対称性(仕様 §2/§13)を静かに破壊する。
 */
export function combatSystem(world: World): void {
  const maxTurn = TURN_RATE * SIM_DT;
  const pending: PendingShot[] = [];

  for (const s of world.soldiers) {
    s.suppressor = s.order.kind === "suppress";
    if (s.status !== "ok") continue;

    const target = nearestVisibleTarget(world, s);
    if (!target) continue;

    const tx = target.pos.x - s.pos.x;
    const tz = target.pos.z - s.pos.z;
    const tlen = Math.hypot(tx, tz) || 1;
    const toTarget = { x: tx / tlen, z: tz / tlen };
    const moving = s.pathIdx < s.path.length;

    // 反射的な照準: 静止中の兵士は発砲前に目標へ正対する
    if (!moving && angleBetween(s.facing, toTarget) > FIRE_ALIGN_RAD) {
      const cur = Math.atan2(s.facing.x, s.facing.z);
      const want = Math.atan2(toTarget.x, toTarget.z);
      let diff = want - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const na = Math.abs(diff) <= maxTurn ? want : cur + Math.sign(diff) * maxTurn;
      s.facing = { x: Math.sin(na), z: Math.cos(na) };
      continue; // このティックは照準のみで発砲しない
    }

    if (angleBetween(s.facing, toTarget) > FIRE_ALIGN_RAD) continue; // 移動中かつ正対していない
    if (friendlyBlocksFire(world, s, target)) continue;

    // 発砲 — 射手が属する陣営のストリームから引く。鏡像の状況では両陣営が
    // 同一の乱数を引くことになる(仕様 §2/§13 戦力対称性)
    const outcome = rollShot(world.rngBySide[s.side], {
      shooterSuppressed: isSuppressed(s, world.tick),
      shooterIsMarksman: false, // 選抜射手スロットの実装後に設定する(仕様 §14)
    });
    pending.push({ shooter: s, target, outcome, suppressing: s.suppressor });
  }

  // ── 適用フェーズ ──
  for (const { target, outcome, suppressing } of pending) {
    if (outcome.hit) {
      if (outcome.lethal) {
        target.status = "kia";
        target.path = [];
        target.pathIdx = 0;
        target.bleedOutTick = 0;
      } else if (target.status === "ok") {
        target.status = "wia";
        target.path = [];
        target.pathIdx = 0;
        target.bleedOutTick = world.tick + Math.round(BLEED_OUT_SEC / SIM_DT);
      }
    }
    // 制圧は、制圧役が目標へ発砲し続けている間だけ持続する(§8.6)
    if (suppressing && target.status === "ok") {
      target.suppressedUntilTick = world.tick + 1 + SUPPRESSION_GRACE_TICKS;
    }
  }
}
