/**
 * 対戦車・対構造物火器(`[v7.3]` ロードマップ A-3)。AT4 / カールグスタフ級。
 *
 * 装甲車(ロードマップ B-1)の前提であると同時に、**機関銃陣地・窓・射撃壕にこもった敵を
 * 崩す手段**として単独で意味がある。防御側の陣地(S-1)は窓・壕の補正(被命中 −60%)で
 * 小銃には強いが、ロケットの爆風は遮蔽の補正を受けない。
 *
 * ── 規則(ロードマップ P2/P4)──
 *   - 分隊に射手1名。弾は数える(`Soldier.atRounds`、擲弾と同じ扱い)
 *   - 撃てるのは射手が**自分の目で見えている点**だけ(射線が通っていること)。距離 10〜200m
 *   - 命中率は距離で落ちる。外れると照準点のまわりに散る(陣営ごとの乱数、P2/P3)
 *   - 着弾: 殺傷半径の敵は遮蔽に関係なく高い確率で倒れ、まわりは制圧される。
 *     射撃壕・機関銃陣地の上に落ちれば陣地が壊れる(以後その補正・射界は無い)
 *   - 分隊ごとに撃つ間隔の下限がある
 *   AI の分隊長(射手)・人間・LLM はすべて `fireAntiArmor` を通る。違うのは狙う点の選び方だけ
 *
 * ── 情報(ロードマップ P1)──
 * AI が狙うのは**射手が今見えている敵**のうち、機関銃手・窓や壕に就いている者・建物の中の者。
 * どれも見ている者に分かる事実(銃の形、窓から撃っている姿)で、世界の真の配置を覗かない。
 */

import { ANTI_ARMOR, BLEED_OUT_SEC, EVADE_SEC, KIA_ON_HIT_CHANCE, SIM_DT, SIM_HZ } from "../constants.ts";
import { chance, next, ratePerTick } from "../rng.ts";
import { hasLineOfSightIndexed } from "../wallIndex.ts";
import { insideBounds } from "../cqb.ts";
import { aiSuppressed, soldierSeated } from "../control.ts";
import { isOffField } from "./litter.ts";
import { smokeBlocks } from "./smoke.ts";
import type { Soldier, SquadState, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const COOLDOWN_TICKS = Math.round(ANTI_ARMOR.COOLDOWN_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 撃てない理由。人間・LLM へそのまま返す。
 *   no_gunner    : 撃てる射手がいない(射手が倒れた・手当や担架に就いている)
 *   no_rounds    : 撃ち尽くした
 *   cooldown     : 前の発射から間隔が明けていない
 *   out_of_range : 射手から 10〜200m の外
 *   no_line      : 射手からその点へ射線が通らない(壁・煙)
 */
export type AntiArmorBlock = "no_gunner" | "no_rounds" | "cooldown" | "out_of_range" | "no_line";

export const ANTI_ARMOR_BLOCK_TEXT: Record<AntiArmorBlock, string> = {
  no_gunner: "撃てる射手がいない",
  no_rounds: "対戦車弾を撃ち尽くした",
  cooldown: "前の発射から間隔が明けていない",
  out_of_range: `射程外(射手から ${ANTI_ARMOR.MIN_RANGE}〜${ANTI_ARMOR.MAX_RANGE}m)`,
  no_line: "射手からその点へ射線が通らない",
};

export type AntiArmorResult = { ok: true; hit: boolean; victims: number } | { ok: false; reason: AntiArmorBlock };

/** 分隊の射手(資格を持ち、いま撃てる者)。弾の有無は問わない */
export function gunnerOf(world: World, sq: SquadState): Soldier | null {
  for (const s of world.soldiers) {
    if (s.side !== sq.side || s.squadId !== sq.squadId || !s.quals.antiArmor) continue;
    if (s.status !== "ok" || isOffField(s) || s.bearing !== null || s.treating !== null) continue;
    return s;
  }
  return null;
}

/** 分隊が持っている残弾(射手が倒れていても、生きている射手の弾を数える) */
export function antiArmorRoundsOf(world: World, sq: SquadState): number {
  let n = 0;
  for (const s of world.soldiers) {
    if (s.side === sq.side && s.squadId === sq.squadId && s.status !== "kia") n += s.atRounds ?? 0;
  }
  return n;
}

/** 次に撃てるまでの残りティック */
export function antiArmorCooldownLeft(world: World, sq: SquadState): number {
  return Math.max(0, (sq.lastAntiArmorTick ?? -1_000_000) + COOLDOWN_TICKS - world.tick);
}

/** 撃てない理由(null なら撃てる) */
export function antiArmorBlocker(world: World, sq: SquadState, target: Vec2): AntiArmorBlock | null {
  const g = gunnerOf(world, sq);
  if (!g) return "no_gunner";
  if ((g.atRounds ?? 0) <= 0) return "no_rounds";
  if (antiArmorCooldownLeft(world, sq) > 0) return "cooldown";
  const d = dist(g.pos, target);
  if (d < ANTI_ARMOR.MIN_RANGE || d > ANTI_ARMOR.MAX_RANGE) return "out_of_range";
  if (!hasLineOfSightIndexed(world.wallIndex, g.eye.x, g.eye.z, target.x, target.z)) return "no_line";
  if (smokeBlocks(world, g.eye.x, g.eye.z, target.x, target.z)) return "no_line";
  return null;
}

/** 距離による命中率 */
export function antiArmorHitChance(range: number): number {
  if (range <= ANTI_ARMOR.NEAR_RANGE) return ANTI_ARMOR.NEAR_HIT;
  const t = Math.min(1, (range - ANTI_ARMOR.NEAR_RANGE) / (ANTI_ARMOR.MAX_RANGE - ANTI_ARMOR.NEAR_RANGE));
  return ANTI_ARMOR.NEAR_HIT + (ANTI_ARMOR.FAR_HIT - ANTI_ARMOR.NEAR_HIT) * t;
}

/** 発射した1発(着弾の前)。AI は全分隊ぶん発射してから、まとめて着弾させる */
interface Launched {
  side: SquadState["side"];
  from: Vec2;
  gunnerId: number;
  at: Vec2;
  hit: boolean;
}

/** 発射する: 弾を1発使い、当たり外れと着弾点を決める(効果はまだ与えない) */
function launch(world: World, sq: SquadState, target: Vec2): Launched {
  const g = gunnerOf(world, sq)!;
  const rng = world.rngBySide[sq.side];
  g.atRounds = (g.atRounds ?? 0) - 1;
  sq.lastAntiArmorTick = world.tick;
  // 撃つ方を向く(後方噴射を背に)
  const d = dist(g.pos, target) || 1;
  g.facing = { x: (target.x - g.pos.x) / d, z: (target.z - g.pos.z) / d };
  const hit = chance(rng, antiArmorHitChance(d));
  let at = { ...target };
  if (!hit) {
    const a = next(rng) * Math.PI * 2;
    const r = (0.5 + next(rng) * 0.5) * ANTI_ARMOR.MISS_SPREAD;
    at = { x: target.x + Math.cos(a) * r, z: target.z + Math.sin(a) * r };
  }
  return { side: sq.side, from: { x: g.pos.x, z: g.pos.z }, gunnerId: g.id, at, hit };
}

/** 着弾させる: 殺傷・制圧・陣地の破壊。倒した人数を返す */
function detonate(world: World, shot: Launched): number {
  const rng = world.rngBySide[shot.side];
  const at = shot.at;
  // 殺傷・制圧(敵だけ — 同士討ちは「撃たない判断」で表す、仕様 §8.2)
  let victims = 0;
  for (const t of world.soldiers) {
    if (t.side === shot.side || t.status === "kia" || isOffField(t)) continue;
    const r = dist(t.pos, at);
    if (r <= ANTI_ARMOR.BLAST_RADIUS && chance(rng, ANTI_ARMOR.CASUALTY_CHANCE)) {
      victims++;
      if (t.status !== "ok" || chance(rng, KIA_ON_HIT_CHANCE)) {
        t.status = "kia";
        t.bleedOutTick = 0;
        t.assignedAider = null;
      } else {
        t.status = "wia";
        t.bleedOutTick = world.tick + Math.round(BLEED_OUT_SEC * SIM_HZ);
      }
      t.path = [];
      t.pathIdx = 0;
      continue;
    }
    if (r <= ANTI_ARMOR.SUPPRESS_RADIUS && t.status === "ok") {
      t.suppressedUntilTick = Math.max(t.suppressedUntilTick, world.tick + Math.round(2 * SIM_HZ));
      t.evadeUntilTick = Math.max(t.evadeUntilTick, world.tick + Math.round(EVADE_SEC * SIM_HZ));
      t.alertFrom = { ...shot.from };
      t.alertUntilTick = world.tick + Math.round(3 * SIM_HZ);
    }
  }
  // 陣地を壊す(射撃壕・機関銃陣地)。壊れた陣地は補正も射界も失う
  world.defense = world.defense.filter(
    (p) =>
      p.side === shot.side ||
      (p.kind !== "fighting" && p.kind !== "mg") ||
      dist(p.pos, at) > ANTI_ARMOR.STRUCTURE_RADIUS,
  );
  world.fx.push({
    kind: "rocket",
    from: { ...shot.from },
    at: { x: at.x, z: at.z },
    side: shot.side,
    radius: ANTI_ARMOR.BLAST_RADIUS,
    victims,
    hit: shot.hit,
  });
  world.gunshots.push({ sourceId: shot.gunnerId, side: shot.side, pos: { ...shot.from }, range: ANTI_ARMOR.HEARING_RANGE });
  return victims;
}

/**
 * 撃つ(人間・LLM の座席から、P4)。通れば弾を1発使い、その場で着弾させる
 * (命令はティックとティックのあいだに出るので、同じティックの他の射撃と競わない)。
 */
export function fireAntiArmor(world: World, sq: SquadState, target: Vec2): AntiArmorResult {
  const block = antiArmorBlocker(world, sq, target);
  if (block) return { ok: false, reason: block };
  const shot = launch(world, sq, target);
  const victims = detonate(world, shot);
  return { ok: true, hit: shot.hit, victims };
}

/** 固い目標か: 機関銃手、窓・射撃壕に就いている者、建物の中の者(見ている者に分かる事実) */
function hardTarget(world: World, t: Soldier): number {
  if (t.role === "mg") return 3;
  if (t.atWindow) return 2;
  if (world.buildings.some((b) => insideBounds(b.bounds, t.pos))) return 1;
  return 0;
}

/**
 * AI の射手の判断(毎ティック、戦闘判定の前)。見えている固い目標があれば、一定の率で撃つ。
 * 人間・LLM が座っている分隊(またはその射手本人)では撃たない — 座席の命令で撃つ
 */
export function antiArmorSystem(world: World): void {
  const shots: Launched[] = [];
  for (const sq of world.squads) {
    const g = gunnerOf(world, sq);
    if (!g || (g.atRounds ?? 0) <= 0 || g.routed) continue;
    if (aiSuppressed(world, "squad", sq.side, sq.squadId) || soldierSeated(world, g)) continue;
    if (antiArmorCooldownLeft(world, sq) > 0) continue;
    let best: Soldier | null = null;
    let bestScore = 0;
    for (const id of g.sees) {
      const t = world.soldierById.get(id);
      if (!t || t.status !== "ok") continue;
      const d = dist(g.pos, t.pos);
      if (d < ANTI_ARMOR.MIN_RANGE || d > ANTI_ARMOR.MAX_RANGE) continue;
      const score = hardTarget(world, t);
      if (score > bestScore || (score === bestScore && score > 0 && best && d < dist(g.pos, best.pos))) {
        best = t;
        bestScore = score;
      }
    }
    if (!best || bestScore === 0) continue;
    if (!chance(world.rngBySide[sq.side], ratePerTick(ANTI_ARMOR.ATTEMPT_RATE_PER_SEC, SIM_DT))) continue;
    if (antiArmorBlocker(world, sq, best.pos) !== null) continue;
    shots.push(launch(world, sq, best.pos));
  }
  // **2フェーズで解決する**(combat.ts と同じ)。全分隊が撃ってから、まとめて着弾させる。
  // 撃つたびに着弾させると、走査順が先の陣営のロケットが相手の射手を先に倒し、
  // 同じティックに撃てたはずの反撃を消す(走査順の有利、仕様 §2/§13)
  for (const shot of shots) detonate(world, shot);
}
