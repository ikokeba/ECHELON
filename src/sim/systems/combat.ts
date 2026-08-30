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
  CONTACT_DRILL,
  EVADE_SEC,
  GRENADE,
  GRENADE_ATTEMPT_RATE_PER_SEC,
  HIT_RATE_PER_SEC,
  RANGE_FALLOFF,
  KIA_ON_HIT_CHANCE,
  MG,
  MOVING_ACC_PENALTY,
  SAW_MOVING_ACC_MUL,
  SAW_SUPPRESS_MUL,
  SIM_DT,
  SIM_HZ,
  SUPPRESSION_ACC_PENALTY,
  SUPPRESSION_ACC_PENALTY_MARKSMAN,
  SUPPRESSION_GRACE_TICKS,
  SUPPRESS_TRIGGER_RATE_PER_SEC,
  SOLDIER_RADIUS,
} from "../constants.ts";
import { angleOf, dirFromAngle, turnToward } from "../geometry.ts";
import { isOffField } from "./litter.ts";
import { weaponRangeOf } from "../weapons.ts";
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
  /** 射手が移動しながら撃っている(命中率が下がる) */
  shooterMoving: boolean;
  /** 射手が自動火器手である(移動時ペナルティが1.3倍に悪化。仕様 §14) */
  shooterIsSaw: boolean;
  /** 射手が火器分隊の機関銃射手である(移動時ペナルティがさらに悪化。`[v6.1]` §2) */
  shooterIsMg?: boolean;
  /** 射手が突撃フェーズにある(近接での決定的打撃 — 命中率上昇。`[v6.1]` §6 F-6) */
  shooterAssaulting?: boolean;
  /**
   * 目標までの距離 m と、射手の武器の索敵/射撃上限 m。`[v6.3]`
   * 省略した場合は距離減衰なし(=従来どおり)。`src/balance/` の抽象交戦モデルは
   * 位置を持たない設計なので省略する — あちらが測るのはMOS構成比であって射距離ではない。
   */
  range?: number;
  maxRange?: number;
}

/**
 * 距離による命中率の倍率(仕様 §8 `[v6.3]`)。`POINT_BLANK` までは 1.0、
 * そこから `maxRange` に向けて `MIN_MUL` まで落ちる。
 */
export function rangeAccMul(range: number, maxRange: number): number {
  if (maxRange <= RANGE_FALLOFF.POINT_BLANK) return 1;
  const over = range - RANGE_FALLOFF.POINT_BLANK;
  if (over <= 0) return 1;
  const t = Math.min(1, over / (maxRange - RANGE_FALLOFF.POINT_BLANK));
  return Math.max(RANGE_FALLOFF.MIN_MUL, 1 - Math.pow(t, RANGE_FALLOFF.EXPONENT));
}

export type ShotOutcome = { hit: false } | { hit: true; lethal: boolean };

/**
 * 有効かつLOSが通り正対済みの目標に対する、1ティック分の射撃判定(純粋関数)。
 *
 * 命中率への修正はすべて**乗算**で重なる。仕様 §14 の「MOSはユニット固有の
 * ステータス修正として扱い、命令の種類そのものは変更しない」という方針どおり、
 * ここに MOS ごとの分岐は存在せず、係数だけが違う。
 */
export function rollShot(rng: Rng, ctx: ShotContext): ShotOutcome {
  let accMul = 1;
  if (ctx.shooterSuppressed) {
    accMul *=
      1 - (ctx.shooterIsMarksman ? SUPPRESSION_ACC_PENALTY_MARKSMAN : SUPPRESSION_ACC_PENALTY);
  }
  if (ctx.shooterMoving) {
    // 重火器ほど移動しながらの射撃が苦手(SAW 1.3倍 / MG 1.7倍。仕様 §14 / `[v6.1]` §2)
    const mul = ctx.shooterIsMg ? MG.MOVING_ACC_MUL : ctx.shooterIsSaw ? SAW_MOVING_ACC_MUL : 1;
    accMul *= 1 - Math.min(0.95, MOVING_ACC_PENALTY * mul);
  }
  // 突撃フェーズ: 近接で詰めた機動組は数秒間、決定的に当てやすくなる(F-6, `[v6.1]`)
  if (ctx.shooterAssaulting) accMul *= CONTACT_DRILL.ASSAULT_ACC_MUL;
  // 距離減衰(`[v6.3]` 仕様 §8)。射程を §10 の本来の値へ戻したことと不可分。
  if (ctx.range !== undefined && ctx.maxRange !== undefined) {
    accMul *= rangeAccMul(ctx.range, ctx.maxRange);
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

/**
 * 交戦対象の選択。**戦闘可能な敵を常に優先する**。
 *
 * 倒れている敵(WIA)も撃てるが、それは他に撃つべき相手がいない場合に限る。
 * 仕様 §9 の即死ルール(「倒れている兵士を無防備に放置するリスクを明確化」)は
 * この後回しの選択で成立する — 通常の撃ち合いの最中に負傷者へ火力が逸れると、
 * 逆に「倒せば安全」という誤った圧力が生まれてしまう。
 */
function nearestVisibleTarget(world: World, shooter: Soldier): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  let downed: Soldier | null = null;
  let downedD = Infinity;
  for (const id of shooter.sees) {
    const t = world.soldierById.get(id);
    if (!t || t.status === "kia" || isOffField(t)) continue;
    const d = Math.hypot(t.pos.x - shooter.pos.x, t.pos.z - shooter.pos.z);
    if (t.status === "ok") {
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    } else if (d < downedD) {
      downedD = d;
      downed = t;
    }
  }
  return best ?? downed;
}

interface PendingShot {
  shooter: Soldier;
  target: Soldier;
  outcome: ShotOutcome;
  suppressing: boolean;
  /** このティックに回避行動を誘発したか(仕様 §14: SAWは誘発率1.5倍) */
  triggersEvade: boolean;
  /** 判定時点で目標が既に行動不能だったか(仕様 §9 の即死ルール) */
  targetWasDowned: boolean;
}

/** 擲弾の着弾。遮蔽を無視して範囲で効く(仕様 §14) */
interface PendingGrenade {
  side: Soldier["side"];
  impact: Vec2;
  victims: Soldier[];
}

/**
 * 擲弾手の行動(仕様 §14)。
 *
 * 「遮蔽物越しの範囲攻撃が可能(通常のLOS要件を無視、着弾半径2.0m)。使用回数上限3発」。
 * LOS要件を無視する以上、**目標は自分の視界ではなくFTの world picture から採る**
 * — 見えていない相手に投げられるのが擲弾の値打ちだが、それでも情報階層(仕様 §5)は
 * 迂回させない。知らない敵には投げられない。
 */
function tryGrenade(
  world: World,
  shooter: Soldier,
  aimPoints: readonly Vec2[],
): PendingGrenade | null {
  if (shooter.role !== "grenadier" || shooter.grenades <= 0) return null;
  const rng = world.rngBySide[shooter.side];
  if (!chance(rng, ratePerTick(GRENADE_ATTEMPT_RATE_PER_SEC, SIM_DT))) return null;

  let aim: Vec2 | null = null;
  let bestD = Infinity;
  for (const p of aimPoints) {
    const d = Math.hypot(p.x - shooter.pos.x, p.z - shooter.pos.z);
    if (d < GRENADE.MIN_RANGE || d > GRENADE.MAX_RANGE) continue;
    if (d < bestD) {
      bestD = d;
      aim = p;
    }
  }
  if (!aim) return null;

  shooter.grenades -= 1;
  if (!chance(rng, GRENADE.SUCCESS_RATE)) return null;

  const victims = world.soldiers.filter(
    (t) =>
      t.side !== shooter.side &&
      t.status !== "kia" &&
      !isOffField(t) &&
      Math.hypot(t.pos.x - aim.x, t.pos.z - aim.z) <= GRENADE.BLAST_RADIUS,
  );
  return { side: shooter.side, impact: aim, victims };
}

/**
 * 戦闘は**2フェーズ**で解決する — 全射手がティック開始時点の状態に対して判定を行い、
 * そのあとで効果をまとめて適用する。逐次に解決してしまうと、走査順が先の陣営が
 * 一方的に有利になる(mos-balance プロトタイプが検証中に踏んだ「先手バイアス」)。
 * これは戦力対称性(仕様 §2/§13)を静かに破壊する。
 */
export function combatSystem(world: World): void {
  // 旋回速度・正対精度は実行時チューニング可(`[v6.1]`)。既定は定数と一致。
  const maxTurn = world.tuning.turnRate * SIM_DT;
  const fireAlignRad = world.tuning.fireAlignRad;
  const pending: PendingShot[] = [];
  const grenades: PendingGrenade[] = [];

  // 擲弾手の照準点はFTの world picture から採る(LOS不要でも情報階層は迂回しない)
  const aimPointsByFt = new Map<string, Vec2[]>();
  for (const ft of world.fireteams) {
    const pts: Vec2[] = [];
    for (const c of ft.memory.values()) {
      if (c.confidence > 0.5) pts.push(c.pos);
    }
    aimPointsByFt.set(`${ft.side}:${ft.squadId}:${ft.ftIndex}`, pts);
  }

  for (const s of world.soldiers) {
    s.suppressor = s.order.kind === "suppress";
    if (s.status !== "ok") continue;
    // 応急手当の実行中は射撃できない(仕様 §9: 処置中は両者とも無防備)
    if (s.treating !== null && s.aidProgressTicks > 0) continue;
    // 担架搬送中は武器を使用できない(仕様 §9)
    if (s.bearing !== null) continue;
    // 潰走中は自分からは撃たない(仕様 §12: 隊形崩壊、武装放棄もあり得る)。
    // ただし**交戦対象にはなる** — 逃走中でも攻撃可能、と仕様が明記している
    if (s.routed) continue;
    // 協調一斉射の火力溜め(F-6, 仕様 §6 `[v6.1]`)。FTリーダーAIが機動組へ短時間セットする。
    // 制圧・被弾・回避など受け身の処理は上で済んでいる。
    if (s.holdFireUntilTick > world.tick) continue;

    // 擲弾(仕様 §14)。遮蔽越しに効くので通常射撃とは別枠で判定する
    const g = tryGrenade(world, s, aimPointsByFt.get(`${s.side}:${s.squadId}:${s.fireteamId}`) ?? []);
    if (g) grenades.push(g);

    const target = nearestVisibleTarget(world, s);
    if (!target) continue;

    const tx = target.pos.x - s.pos.x;
    const tz = target.pos.z - s.pos.z;
    const tlen = Math.hypot(tx, tz) || 1;
    const toTarget = { x: tx / tlen, z: tz / tlen };
    const moving = s.pathIdx < s.path.length;

    // 反射的な照準: 静止中の兵士は発砲前に目標へ正対する。
    // 旋回は geometry.ts の共通実装を使う — ±π の畳み方が対称性に効くため、
    // ここで独自実装を持つと片側だけ有利になる(実際にその不具合を起こした)。
    if (!moving && angleBetween(s.facing, toTarget) > fireAlignRad) {
      const na = turnToward(angleOf(s.facing), angleOf(toTarget), maxTurn);
      s.facing = dirFromAngle(na);
      continue; // このティックは照準のみで発砲しない
    }

    if (angleBetween(s.facing, toTarget) > fireAlignRad) continue; // 移動中かつ正対していない
    if (friendlyBlocksFire(world, s, target)) continue;

    // 発砲 — 射手が属する陣営のストリームから引く。鏡像の状況では両陣営が
    // 同一の乱数を引くことになる(仕様 §2/§13 戦力対称性)
    const outcome = rollShot(world.rngBySide[s.side], {
      shooterSuppressed: isSuppressed(s, world.tick),
      // 選抜射手は制圧下でも命中率低下が軽い(仕様 §8.6 [v5], §14)
      shooterIsMarksman: s.quals.designatedMarksman,
      shooterMoving: moving,
      shooterIsSaw: s.role === "saw",
      shooterIsMg: s.role === "mg",
      shooterAssaulting: s.assaultingUntilTick > world.tick,
      range: tlen,
      maxRange: weaponRangeOf(s).detect,
    });

    // 制圧役は行動抑制(evade)も誘発する。SAW 1.5倍 / MG 2.0倍(仕様 §14 / `[v6.1]` §2)
    // `[v6.3]` 制圧も距離で減衰する。しないと 150m から撃っているだけで敵を
    // 釘付けにできてしまい、近接して制圧を作る意味が消える
    let triggersEvade = false;
    if (s.suppressor) {
      const mul = s.role === "mg" ? MG.SUPPRESS_MUL : s.role === "saw" ? SAW_SUPPRESS_MUL : 1;
      const rMul = rangeAccMul(tlen, weaponRangeOf(s).detect);
      triggersEvade = chance(
        world.rngBySide[s.side],
        ratePerTick(SUPPRESS_TRIGGER_RATE_PER_SEC * mul * rMul, SIM_DT),
      );
    }

    pending.push({
      shooter: s,
      target,
      outcome,
      suppressing: s.suppressor,
      triggersEvade,
      targetWasDowned: target.status !== "ok",
    });
  }

  // ── 適用フェーズ ──
  /** 被弾の適用。行動不能中への追加被弾は即死(仕様 §9)。 */
  const applyHit = (target: Soldier, wasDowned: boolean, lethal: boolean): void => {
    if (wasDowned) {
      target.status = "kia";
      target.bleedOutTick = 0;
      target.assignedAider = null;
      return;
    }
    if (lethal) {
      target.status = "kia";
      target.path = [];
      target.pathIdx = 0;
      target.bleedOutTick = 0;
      return;
    }
    if (target.status === "ok") {
      target.status = "wia";
      target.path = [];
      target.pathIdx = 0;
      target.bleedOutTick = world.tick + Math.round(BLEED_OUT_SEC / SIM_DT);
    }
  };

  for (const { shooter, target, outcome, suppressing, triggersEvade, targetWasDowned } of pending) {
    // 発砲線(`[v6.1]`)。戦闘は移動の後なので pos は確定済み。シムの判断には使わない。
    world.fx.push({
      kind: "shot",
      from: { x: shooter.pos.x, z: shooter.pos.z },
      to: { x: target.pos.x, z: target.pos.z },
      side: shooter.side,
      hit: outcome.hit,
    });
    if (outcome.hit) {
      // 即死ルール(仕様 §9): 行動不能中の兵士への追加被弾は、安定化・後送状況に
      // 関係なく即時戦死。倒れた味方を無防備に放置するリスクを明確化するための規則。
      applyHit(target, targetWasDowned, outcome.lethal);
    }
    // 制圧は、制圧役が目標へ発砲し続けている間だけ持続する(§8.6)
    if (suppressing && target.status === "ok") {
      target.suppressedUntilTick = world.tick + 1 + SUPPRESSION_GRACE_TICKS;
      // 行動抑制(仕様 §14)。制圧そのものに余韻はない(§8.6)が、誘発された
      // 回避行動には持続がある — 遮蔽へ飛び込む動作は途中では止まらない
      if (triggersEvade) {
        target.evadeUntilTick = Math.max(
          target.evadeUntilTick,
          world.tick + Math.round(EVADE_SEC * SIM_HZ),
        );
      }
    }
  }

  // ── 擲弾の適用(仕様 §14: 遮蔽物越しの範囲攻撃)──
  for (const g of grenades) {
    for (const v of g.victims) {
      const wasDowned = v.status !== "ok";
      applyHit(v, wasDowned, chance(world.rngBySide[g.side], KIA_ON_HIT_CHANCE));
    }
    // 着弾円(`[v6.1]`)。範囲攻撃であることが分かるよう半径ごと渡す(指摘: 擲弾を可視化)
    world.fx.push({
      kind: "grenade",
      at: { x: g.impact.x, z: g.impact.z },
      side: g.side,
      radius: GRENADE.BLAST_RADIUS,
      victims: g.victims.length,
    });
  }
}
