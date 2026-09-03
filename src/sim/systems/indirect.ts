/**
 * 火力支援 — 60mm 迫撃砲(仕様 §10 装備 / §11 中隊長のアセット投入)。`[v6.9]`
 *
 * **これは §8(戦闘)の機能ではなく §5(情報)の機能である。** 砲は敵を見ていない。
 * 中隊長が持っている像 — 小隊長からの報告を無線2ホップぶん遅れて集約した、確度の
 * 落ちた接触情報 — に向けて撃つ。要請から着弾までの飛翔時間のあいだに敵は動くので、
 * **古い情報がそのまま「誰もいない街路への着弾」として目に見える**。
 * したがって照準点は必ず `co.belief` から採る。`world.soldiers` を読んだ瞬間に
 * この機能の値打ちは消え、ただの範囲攻撃になる。
 *
 * 中隊のC2資源なので、**中隊本部を持たない編成では要請できない**(仕様 §2)。
 * 小隊規模・分隊規模を選ぶことの意味がここで一段増える。
 *
 * 同士討ちは仕様 §8.2 が「起きない」ものとして抽象化しているので、迫撃砲でも
 * 同士討ちは実装せず、**危険近接では撃たない判断**として表現する。
 */

import { MORTAR, SIM_HZ, SUPPRESSION_GRACE_TICKS } from "../constants.ts";
import { chance, next, type Rng } from "../rng.ts";
import { decayedConfidence } from "../belief.ts";
import { isOffField } from "./litter.ts";
import { sideDoctrine } from "../world.ts";
import type { CompanyState, Side, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const TOF_TICKS = Math.round(MORTAR.TIME_OF_FLIGHT_SEC * SIM_HZ);
const INTERVAL_TICKS = Math.round(MORTAR.ROUND_INTERVAL_SEC * SIM_HZ);
const COOLDOWN_TICKS = Math.round(MORTAR.COOLDOWN_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 戦闘に数えられる兵士か(倒れている者・後送済みは対象外)。 */
function standing(s: Soldier): boolean {
  return s.status === "ok" && !isOffField(s);
}

/**
 * 中隊が指揮所を機能させているか(仕様 §2/§11)。
 * 中隊本部のいない編成 — 小隊規模・分隊規模 — は火力支援を持たない。
 */
function hasCommandPost(world: World, co: CompanyState): boolean {
  return world.soldiers.some(
    (s) =>
      s.side === co.side &&
      s.companyId === co.companyId &&
      (s.hqRole === "co" || s.hqRole === "xo" || s.hqRole === "coRto") &&
      s.status === "ok",
  );
}

/**
 * 中隊長の belief から射撃目標を選ぶ。
 *
 * 選ぶ基準は「確度の高い接触が固まっているところ」。1名を狙うのではなく**一帯を叩く**
 * のが迫撃砲の使い方で、これは同時に「古い像に無駄弾を撃たない」ための足切りにもなる。
 * 走査順は belief の挿入順(決定論的)で、乱数は引かない。
 */
function pickTarget(world: World, co: CompanyState): Vec2 | null {
  const hot: Vec2[] = [];
  for (const c of co.belief.values()) {
    const age = (world.tick - c.lastSeenTick) / SIM_HZ;
    if (decayedConfidence(age) < MORTAR.CONFIDENCE_FLOOR) continue;
    hot.push(c.pos);
  }
  if (hot.length < MORTAR.MIN_CLUSTER) return null;

  let best: Vec2 | null = null;
  let bestN = 0;
  for (const seed of hot) {
    let n = 0;
    let sx = 0;
    let sz = 0;
    for (const p of hot) {
      if (dist(seed, p) > MORTAR.CLUSTER_RADIUS) continue;
      n++;
      sx += p.x;
      sz += p.z;
    }
    if (n > bestN) {
      bestN = n;
      best = { x: sx / n, z: sz / n };
    }
  }
  if (!best || bestN < MORTAR.MIN_CLUSTER) return null;

  // 射程の窓に入っているか(指揮所から測る)
  const range = dist(co.cp, best);
  if (range < MORTAR.MIN_RANGE || range > MORTAR.MAX_RANGE) return null;

  // 危険近接 — 自軍が近い目標へは撃たない(仕様 §8.2 の同士討ち抽象化に合わせる)
  for (const s of world.soldiers) {
    if (s.side !== co.side || !standing(s)) continue;
    if (dist(s.pos, best) < MORTAR.DANGER_CLOSE) return null;
  }
  return best;
}

/** 散布を1発ぶん引く。陣営ごとのストリームなので、鏡像の状況は同じ目を引く。 */
function disperse(rng: Rng, at: Vec2, spread: number): Vec2 {
  // 一様乱数2本から極座標へ。決定論的で、方向にも距離にも偏りが出ない
  const ang = next(rng) * Math.PI * 2;
  const r = Math.sqrt(next(rng)) * spread;
  return { x: at.x + Math.cos(ang) * r, z: at.z + Math.sin(ang) * r };
}

/**
 * 着弾1発の解決。殺傷半径の内側は判定を引き、制圧半径の内側は仕様 §8.6 の
 * 制圧(-40%)を受ける。**敵味方を問わない** — 砲弾は陣営を見ない。
 * 危険近接の判断で自軍を近づけないことが、同士討ちを起こさない仕組みになっている。
 */
function resolveImpact(world: World, side: Side, at: Vec2): number {
  const rng = world.rngBySide[side];
  let victims = 0;
  for (const s of world.soldiers) {
    if (!standing(s)) continue;
    const d = dist(s.pos, at);
    if (d <= MORTAR.SUPPRESS_RADIUS) {
      // 仕様 §8.6「制圧に余韻はない」を守る。砲撃が**続いているあいだ**だけ制圧が乗る
      // ように、次弾の間隔ぶんだけ押し直す(小銃の制圧が毎ティック押し直すのと同じ形)。
      // 斉射が終われば 1.6 秒あまりで自然に切れる — 持続タイマーではない。
      s.suppressedUntilTick = Math.max(
        s.suppressedUntilTick,
        world.tick + INTERVAL_TICKS + SUPPRESSION_GRACE_TICKS,
      );
    }
    if (d <= MORTAR.BLAST_RADIUS && chance(rng, MORTAR.CASUALTY_CHANCE)) {
      // 擲弾と同じ扱い。負傷か戦死かは casualties 側の既定の分岐へ委ねる
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = 0;
      victims++;
    }
  }
  world.fx.push({
    kind: "mortar",
    at: { x: at.x, z: at.z },
    side,
    radius: MORTAR.BLAST_RADIUS,
    suppressRadius: MORTAR.SUPPRESS_RADIUS,
    victims,
  });
  return victims;
}

/**
 * 毎ティック呼ばれる。順序は step.ts のとおり**戦闘判定の前** — 着弾による制圧が
 * その同じティックの射撃に効くようにするため(仕様 §8.6)。
 */
export function indirectSystem(world: World): void {
  // ── 1. 飛翔中の弾を着弾させる ──
  if (world.fireMissions.length > 0) {
    const live = [];
    for (const m of world.fireMissions) {
      if (world.tick >= m.nextImpactTick) {
        resolveImpact(world, m.side, disperse(world.rngBySide[m.side], m.target, MORTAR.DISPERSION));
        m.roundsLeft -= 1;
        m.nextImpactTick = world.tick + INTERVAL_TICKS;
      }
      if (m.roundsLeft > 0) live.push(m);
    }
    world.fireMissions = live;
  }

  // ── 2. 中隊長の要請 ──
  for (const co of world.companies) {
    const doc = sideDoctrine(world, co.side);
    // ドクトリンで持ち弾が変わる(仕様 §13)。自律群は火力支援を持たない
    if (doc.fireSupport <= 0) continue;
    const allowance = Math.round(MORTAR.ROUNDS_PER_COMPANY * doc.fireSupport);
    if (co.mortarRoundsUsed >= allowance) continue;
    if (!hasCommandPost(world, co)) continue;
    // 判断周期・要請間隔ともドクトリンで鈍る。非正規軍は「呼べるが遅い」
    if (world.tick - co.lastFireMissionTick < COOLDOWN_TICKS * doc.radioLatencyMul) continue;
    // すでに飛翔中の任務があるなら重ねない
    if (world.fireMissions.some((m) => m.side === co.side && m.companyId === co.companyId)) continue;

    const target = pickTarget(world, co);
    if (!target) continue;

    const rounds = Math.min(MORTAR.ROUNDS_PER_MISSION, allowance - co.mortarRoundsUsed);
    co.mortarRoundsUsed += rounds;
    co.lastFireMissionTick = world.tick;
    world.fireMissions.push({
      id: world.nextFireMissionId++,
      side: co.side,
      companyId: co.companyId,
      target: { ...target },
      requestedTick: world.tick,
      roundsLeft: rounds,
      // 飛翔時間もドクトリンの無線遅延を受ける — 要請が上るのに時間が掛かるほど遅い
      nextImpactTick: world.tick + Math.round(TOF_TICKS * doc.radioLatencyMul),
    });
  }
}
