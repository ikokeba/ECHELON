/**
 * 発煙(`[v7.2]` ロードマップ S-2)。
 *
 * **煙は視線だけを遮る。** 壁と違って人も弾も経路探索も通す。遮るのは索敵(仕様 §5)で、
 * 射撃は `sees` に載った相手にしか向かないので、見えなければ撃たれない — 新しい
 * 命中の倍率は作らない(ロードマップ P2)。
 *
 * 使い方は「煙で隠して渡る」。開けた街路を、敵に見られながら横切るときに、敵と自分の
 * あいだへ焚く。盤面「大通りと市場」の幅40mの道で特に効く。
 *
 * ── 誰が焚くか(ロードマップ P4)──
 * 投げるのは分隊長。AIの分隊長は `decideSmoke` で判断し、人間・LLM は分隊長の座席から
 * 地点を選ぶ。どちらも `throwSmoke` を通るので、残数・間隔・投げられる距離・投げる者が
 * 戦えること、は全員に同じに掛かる。
 *
 * ── 情報(ロードマップ P1)──
 * AIの判断材料は分隊長の belief(麾下FTの視界の合算)だけ。煙そのものは双方に見える
 * 出来事なので、`world.smokes` を読むのは構わない(迫撃砲の着弾が両軍に見えるのと同じ)。
 */

import { SIM_HZ, SMOKE } from "../constants.ts";
import { hasLineOfSightIndexed } from "../wallIndex.ts";
import { isOffField } from "./litter.ts";
import type { Contact, Smoke, SquadState, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const BUILD_TICKS = Math.round(SMOKE.BUILD_SEC * SIM_HZ);
const DURATION_TICKS = Math.round(SMOKE.DURATION_SEC * SIM_HZ);
const COOLDOWN_TICKS = Math.round(SMOKE.COOLDOWN_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** いまの半径 m。投げてから BUILD_SEC かけて広がる */
export function smokeRadius(s: Smoke, tick: number): number {
  if (tick >= s.untilTick) return 0;
  const t = Math.min(1, Math.max(0, tick - s.sinceTick) / Math.max(1, BUILD_TICKS));
  return SMOKE.RADIUS * t;
}

/** 線分 a-b と点 c の最短距離 */
function segDist(ax: number, az: number, bx: number, bz: number, c: Vec2): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t - c.x, az + dz * t - c.z);
}

/**
 * a から b への視線が煙で遮られているか。目の前(SEE_THROUGH 以内)の相手は見える。
 * 煙の中にいる者は外が見えず、外からも見えない(線分が円に入るので自然にそうなる)。
 */
export function smokeBlocks(world: World, ax: number, az: number, bx: number, bz: number): boolean {
  if (world.smokes.length === 0) return false;
  if (Math.hypot(bx - ax, bz - az) <= SMOKE.SEE_THROUGH) return false;
  for (const s of world.smokes) {
    const r = smokeRadius(s, world.tick);
    if (r <= 0) continue;
    if (segDist(ax, az, bx, bz, s.pos) < r) return true;
  }
  return false;
}

/** 毎ティック: 消えた煙を片づける。索敵より前に呼ぶ */
export function smokeSystem(world: World): void {
  if (world.smokes.length === 0) return;
  world.smokes = world.smokes.filter((s) => world.tick < s.untilTick);
}

/**
 * 焚けない理由(`[v7.2]`)。人間・LLM へそのまま返す。
 *   no_smoke      : 撃ち尽くした
 *   no_thrower    : 分隊長(指揮を執っている者)が戦えない
 *   cooldown      : 前の発煙から間隔が明けていない
 *   out_of_range  : 投げる者から THROW_RANGE より遠い
 */
export type SmokeBlock = "no_smoke" | "no_thrower" | "cooldown" | "out_of_range";

export const SMOKE_BLOCK_TEXT: Record<SmokeBlock, string> = {
  no_smoke: "発煙弾を使い切った",
  no_thrower: "投げられる分隊長がいない",
  cooldown: "前の発煙から間隔が明けていない",
  out_of_range: `遠すぎる(分隊長から ${SMOKE.THROW_RANGE}m 以内)`,
};

export type SmokeResult = { ok: true; smokeId: number } | { ok: false; reason: SmokeBlock };

/** 次に焚けるまでの残りティック(0 なら今すぐ) */
export function smokeCooldownLeft(world: World, sq: SquadState): number {
  return Math.max(0, sq.lastSmokeTick + COOLDOWN_TICKS - world.tick);
}

/** 投げる者(分隊の指揮を執っている兵士)。戦えなければ null */
export function smokeThrower(world: World, sq: SquadState) {
  if (sq.commanderId === null) return null;
  const s = world.soldierById.get(sq.commanderId);
  if (!s || s.status !== "ok" || s.routed || isOffField(s)) return null;
  return s;
}

/**
 * 分隊が `target` へ発煙弾を投げる(`[v7.2]`)。**AI・人間・LLM が全員この関数を通る**。
 * ここにあるのは規則だけで、「どこへ・いつ焚くか」は呼ぶ側が決める。
 */
export function throwSmoke(world: World, sq: SquadState, target: Vec2): SmokeResult {
  if (sq.smokes <= 0) return { ok: false, reason: "no_smoke" };
  const thrower = smokeThrower(world, sq);
  if (!thrower) return { ok: false, reason: "no_thrower" };
  if (smokeCooldownLeft(world, sq) > 0) return { ok: false, reason: "cooldown" };
  if (dist(thrower.pos, target) > SMOKE.THROW_RANGE) return { ok: false, reason: "out_of_range" };
  sq.smokes -= 1;
  sq.lastSmokeTick = world.tick;
  const id = world.nextSmokeId++;
  world.smokes.push({
    id,
    side: sq.side,
    pos: { x: target.x, z: target.z },
    sinceTick: world.tick,
    untilTick: world.tick + DURATION_TICKS,
  });
  return { ok: true, smokeId: id };
}

/** belief の中で最も確度の高い接触(確度0のゴーストは使わない、仕様 §5) */
function primaryThreat(belief: Map<string, Contact>): Contact | null {
  let best: Contact | null = null;
  for (const c of belief.values()) {
    if (c.confidence <= 0) continue;
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
}

/**
 * AIの分隊長の判断: 「煙で隠して渡る」(`[v7.2]`)。焚いたら true。
 *
 * 焚くのは次のすべてが揃ったとき。材料は分隊長の belief と自分の分隊の状態だけ:
 *   1. 確度の高い敵の接触が、撃ち合いには遠く・小銃の届く距離にいる
 *   2. 分隊の過半数が移動中(止まって撃ち合っているなら煙はむしろ邪魔)
 *   3. その敵の位置から分隊の重心まで、壁に遮られない射線が通っている(=見られている)
 *   4. その射線をまだ煙が遮っていない
 * 焚く地点は、分隊の重心から敵の方へ STANDOFF だけ出たところ。投げられる距離へ収める。
 */
export function decideSmoke(world: World, sq: SquadState): boolean {
  if (sq.smokes <= 0 || smokeCooldownLeft(world, sq) > 0) return false;
  const thrower = smokeThrower(world, sq);
  if (!thrower) return false;
  const threat = primaryThreat(sq.belief);
  if (!threat || threat.confidence < SMOKE.MIN_CONFIDENCE) return false;

  const men = world.soldiers.filter(
    (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok" && !isOffField(s),
  );
  if (men.length === 0) return false;
  const moving = men.filter((s) => s.pathIdx < s.path.length).length;
  if (moving * 2 < men.length) return false;

  let cx = 0;
  let cz = 0;
  for (const m of men) {
    cx += m.pos.x;
    cz += m.pos.z;
  }
  const c = { x: cx / men.length, z: cz / men.length };
  const d = dist(c, threat.pos);
  if (d < SMOKE.MIN_THREAT_DIST || d > SMOKE.MAX_THREAT_DIST) return false;
  if (!hasLineOfSightIndexed(world.wallIndex, threat.pos.x, threat.pos.z, c.x, c.z)) return false;
  if (smokeBlocks(world, threat.pos.x, threat.pos.z, c.x, c.z)) return false;

  const ux = (threat.pos.x - c.x) / d;
  const uz = (threat.pos.z - c.z) / d;
  let target = { x: c.x + ux * SMOKE.STANDOFF, z: c.z + uz * SMOKE.STANDOFF };
  // 投げる者から届く距離へ寄せる(分隊長は隊の後ろにいることがある)
  const td = dist(thrower.pos, target);
  if (td > SMOKE.THROW_RANGE) {
    const k = (SMOKE.THROW_RANGE - 0.01) / td;
    target = {
      x: thrower.pos.x + (target.x - thrower.pos.x) * k,
      z: thrower.pos.z + (target.z - thrower.pos.z) * k,
    };
  }
  return throwSmoke(world, sq, target).ok;
}
