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
  WINDOW,
  SUPPRESS_TRIGGER_RATE_PER_SEC,
  SOLDIER_RADIUS,
  SHIELD,
  INDIVIDUAL,
  TRACER_EVERY_TICKS,
  CLOSE_RANGE_BOOST,
  HEARING,
} from "../constants.ts";
import { shieldAccMul, shieldUp, turnMulOf } from "../shield.ts";
import { angleOf, dirFromAngle, turnToward } from "../geometry.ts";
import { isOffField } from "./litter.ts";
import { weaponKindOf, weaponRangeOf } from "../weapons.ts";
import { inSector } from "../c2/defense.ts";
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
  /** 射手が盾持ちで、盾を支えながら片手で撃っている(`[v7.1]`)。命中 ×SHIELD.PISTOL_ACC_MUL */
  shooterOneHanded?: boolean;
  /** 射手が窓に就いている(`[v6.10]` 仕様 §7/§8)。命中 +30% */
  shooterAtWindow?: boolean;
  /** 目標が窓に就いている。撃つ側の命中 −60% */
  targetAtWindow?: boolean;
  /**
   * 盾による命中率倍率(`[v7.0]` constants `SHIELD`)。省略時は 1(盾なし)。
   * 盾持ち本人を正面から撃つ、または盾の陰の隊員を撃つと 1 未満になる。
   */
  targetShieldMul?: number;
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

/**
 * 近距離の命中率の上乗せ倍率(`[v7.1]` constants `CLOSE_RANGE_BOOST`)。
 * 表の最初の距離より近ければ最初の値、最後より遠ければ最後の値、あいだは線形補間。
 */
export function closeRangeBoost(range: number): number {
  const t = CLOSE_RANGE_BOOST;
  if (range <= t[0]![0]) return t[0]![1];
  for (let i = 1; i < t.length; i++) {
    const [r1, m1] = t[i]!;
    if (range <= r1) {
      const [r0, m0] = t[i - 1]!;
      return m0 + ((m1 - m0) * (range - r0)) / (r1 - r0);
    }
  }
  return t[t.length - 1]![1];
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
    // `[v7.1]` 近距離ほど当たる(近接戦は数秒で決着する)
    accMul *= closeRangeBoost(ctx.range);
  }
  // 窓(`[v6.10]` 仕様 §7/§8)。銃眼から撃つ側の非対称を、他の修正と同じく**乗算**で。
  // 撃つ側と撃たれる側の両方が窓にいる場合、両方の係数が掛かる(窓越しの撃ち合い)。
  if (ctx.shooterAtWindow) accMul *= WINDOW.SHOOTER_ACC_MUL;
  if (ctx.shooterOneHanded) accMul *= SHIELD.PISTOL_ACC_MUL;
  if (ctx.targetAtWindow) accMul *= WINDOW.TARGET_ACC_MUL;
  // 盾(`[v7.0]`)。他の修正と同じく乗算で重ねる
  if (ctx.targetShieldMul !== undefined) accMul *= ctx.targetShieldMul;
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
    // `[v7.0]` すぐ前に立つ盾持ちは障害にしない — 盾の後ろの隊員は肩越し・脇から撃つ。
    // これが無いと、盾の陰に入った隊員が誰も撃てなくなる
    if (
      f.role === "shield" &&
      Math.hypot(f.pos.x - sx, f.pos.z - sz) <= SHIELD.SHOOT_PAST_DIST
    ) {
      continue;
    }
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
  // `[v6.3]` FTリーダーが指定した目標を最優先する(火力の配分、ATP 3-21.8)。
  // 指定が古くなっている(戦死・後送・見失った)場合だけ各自の判断へ落ちる。
  if (shooter.assignedTarget !== null) {
    const a = world.soldierById.get(shooter.assignedTarget);
    if (
      a &&
      a.status === "ok" &&
      !isOffField(a) &&
      shooter.sees.includes(a.id) &&
      inSector(shooter, a.pos)
    ) {
      return a;
    }
  }
  let best: Soldier | null = null;
  let bestD = Infinity;
  let downed: Soldier | null = null;
  let downedD = Infinity;
  for (const id of shooter.sees) {
    const t = world.soldierById.get(id);
    if (!t || t.status === "kia" || isOffField(t)) continue;
    // `[v7.2]` 機関銃陣地に就いている射手は射界の外を撃たない(S-1)
    if (!inSector(shooter, t.pos)) continue;
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
  /** 制圧が成立する距離(=射手の有効射程内)で撃たれたか。`[v6.3]` */
  withinEffective: boolean;
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

  // 盾を構えている兵士(`[v7.0]`)。陣営ごとに分けておき、撃たれる側のぶんだけ見る
  const shieldsBySide: Record<Soldier["side"], Soldier[]> = { blue: [], red: [] };
  for (const s of world.soldiers) if (shieldUp(s)) shieldsBySide[s.side].push(s);

  for (const s of world.soldiers) {
    // `[v7.0]` 盾の密集隊形の隊員は、隊形位置へ追従しながら制圧射撃もする
    s.suppressor =
      s.order.kind === "suppress" || (s.order.kind === "follow" && s.order.suppress === true);
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
    // `[v7.1]` 反射射撃(TC 3-22.9 reflexive fire)。至近では照準を詰めきらずに撃つ
    const alignRad =
      tlen <= INDIVIDUAL.REFLEX_RANGE ? fireAlignRad * INDIVIDUAL.REFLEX_ALIGN_MUL : fireAlignRad;
    if (!moving && angleBetween(s.facing, toTarget) > alignRad) {
      const na = turnToward(angleOf(s.facing), angleOf(toTarget), maxTurn * turnMulOf(s));
      s.facing = dirFromAngle(na);
      continue; // このティックは照準のみで発砲しない
    }

    if (angleBetween(s.facing, toTarget) > alignRad) continue; // 移動中かつ正対していない
    // 見えていても武器が届かない(`[v7.0]` 盾持ちの拳銃。目は小銃と同じだけ見える)
    if (tlen > weaponRangeOf(s).detect) continue;
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
      // 窓(`[v6.10]` 仕様 §7/§8)。`windowsSystem` がこのティックの位置から確定済み
      shooterAtWindow: s.atWindow,
      shooterOneHanded: s.role === "shield",
      targetAtWindow: target.atWindow,
      targetShieldMul: shieldAccMul(s, target, shieldsBySide[target.side]),
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
      // `[v6.3]` 制圧は**有効射程内でのみ成立**する(仕様 §8.6)。射程を150mへ戻した
      // 結果、これが無いと遠距離から撃っているだけで敵を恒久的に釘付けにでき、
      // 潰走からの立て直し(AD-29)が永久に閉じる、という形で実際に壊れた。
      withinEffective: tlen <= weaponRangeOf(s).effective,
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

  for (const {
    shooter,
    target,
    outcome,
    suppressing,
    withinEffective,
    triggersEvade,
    targetWasDowned,
  } of pending) {
    // 発砲(`[v6.1]` / `[v7.1]` 弾道表現)。戦闘は移動の後なので pos は確定済み。
    // シムの判断には使わない。外れ弾は武器ごとの見た目のレートで間引く(乱数は引かない —
    // 位相は編成上の通し番号から取るので、鏡像の2人は同じティックに撃って見える)
    const weapon =
      shooter.role === "mg"
        ? "mg"
        : shooter.role === "saw"
          ? "saw"
          : (weaponKindOf(shooter) as "rifle" | "dm" | "pistol");
    world.gunshots.push({
      sourceId: shooter.id,
      side: shooter.side,
      pos: { x: shooter.pos.x, z: shooter.pos.z },
      range: HEARING.RANGE[weapon],
    });
    const every = TRACER_EVERY_TICKS[weapon];
    if (outcome.hit || (world.tick + shooter.ordinal) % every === 0) {
      world.fx.push({
        kind: "shot",
        from: { x: shooter.pos.x, z: shooter.pos.z },
        to: { x: target.pos.x, z: target.pos.z },
        side: shooter.side,
        hit: outcome.hit,
        shooterId: shooter.id,
        targetId: target.id,
        weapon,
      });
    }
    // `[v7.1]` 撃たれた者は撃ってきた方向を覚える(個人の戦闘動作: 撃たれたら撃ってきた方を向く)。
    // 当たったかどうかに関係なく、弾が飛んできたこと自体で分かる
    if (target.status === "ok") {
      target.alertFrom = { x: shooter.pos.x, z: shooter.pos.z };
      target.alertUntilTick = world.tick + Math.round(INDIVIDUAL.ALERT_SEC * SIM_HZ);
    }
    if (outcome.hit) {
      // 即死ルール(仕様 §9): 行動不能中の兵士への追加被弾は、安定化・後送状況に
      // 関係なく即時戦死。倒れた味方を無防備に放置するリスクを明確化するための規則。
      applyHit(target, targetWasDowned, outcome.lethal);
    }
    // 制圧は、制圧役が目標へ発砲し続けている間だけ持続する(§8.6)。
    // `[v6.3]` かつ有効射程内であること — 遠距離の散発的な射撃は制圧にならない。
    if (suppressing && withinEffective && target.status === "ok") {
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
    // 爆発音は着弾点から響く(`[v7.3]` A-5)。投げた者の位置ではない
    world.gunshots.push({
      sourceId: -1,
      side: g.side,
      pos: { x: g.impact.x, z: g.impact.z },
      range: HEARING.RANGE.grenade,
    });
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
