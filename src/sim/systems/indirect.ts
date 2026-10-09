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
import { distToFlot } from "../c2/flot.ts";
import { aiSuppressed } from "../control.ts";
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
 * 中隊長の belief から射撃目標を選ぶ(AIの判断)。
 *
 * 選ぶ基準は「確度の高い接触が固まっているところ」。1名を狙うのではなく**一帯を叩く**
 * のが迫撃砲の使い方で、これは同時に「古い像に無駄弾を撃たない」ための足切りにもなる。
 * 走査順は belief の挿入順(決定論的)で、乱数は引かない。
 *
 * 射程・危険近接は**ここでは見ない**。それは誰が要請しても掛かる規則なので
 * `fireMissionBlocker` が持つ(`[v7.2]`)。
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
  return best;
}

/**
 * 射撃要請が通らない理由(`[v7.2]`)。人間・LLM へそのまま返す。
 *   no_fire_support : ドクトリン上、火力支援を持たない(自律群)
 *   no_rounds       : 撃ち尽くした
 *   no_command_post : 中隊本部(中隊長・副中隊長・無線手)が戦えない
 *   cooldown        : 前の要請から間隔が明けていない
 *   in_flight       : すでに飛翔中の任務がある
 *   out_of_range    : 指揮所から 40〜400m の外
 *   no_flot         : 前線の報告が無く、統制線が引けない
 *   danger_close    : 前線(または指揮所)から危険近接の内側
 */
export type FireMissionBlock =
  | "no_fire_support"
  | "no_rounds"
  | "no_command_post"
  | "cooldown"
  | "in_flight"
  | "out_of_range"
  | "no_flot"
  | "danger_close";

/** 理由の日本語(UI・LLM の `lastResult` 用) */
export const FIRE_MISSION_BLOCK_TEXT: Record<FireMissionBlock, string> = {
  no_fire_support: "このドクトリンは火力支援を持たない",
  no_rounds: "迫撃砲弾を撃ち尽くした",
  no_command_post: "中隊本部が機能していない",
  cooldown: "前の要請から間隔が明けていない",
  in_flight: "前の射撃がまだ飛翔中",
  out_of_range: `射程外(指揮所から ${MORTAR.MIN_RANGE}〜${MORTAR.MAX_RANGE}m)`,
  no_flot: "前線の報告が無く、統制線が引けない",
  danger_close: `危険近接(前線から ${MORTAR.DANGER_CLOSE}m 以内)`,
};

/** 中隊の保有弾数。ドクトリンの `fireSupport` に掛かる */
export function mortarMagazine(world: World, co: CompanyState): number {
  return Math.round(MORTAR.ROUNDS_PER_COMPANY * sideDoctrine(world, co.side).fireSupport);
}

/** 次の要請ができるまでの残りティック(0 なら今すぐ)。ドクトリンの無線遅延で伸びる */
export function fireMissionCooldownLeft(world: World, co: CompanyState): number {
  const cd = COOLDOWN_TICKS * sideDoctrine(world, co.side).radioLatencyMul;
  // 開始(tick 0)も「直前の要請」と同じに数える — 開戦直後の45秒は砲の展開中
  return Math.max(0, Math.ceil(co.lastFireMissionTick + cd - world.tick));
}

/**
 * この中隊がいま `target` へ射撃を要請できるか(`[v7.2]`)。できるなら null。
 *
 * **AI・人間・LLM が全員この1つの関数を通る**(ロードマップ P4 / 仕様 §4)。ここにあるのは
 * 組織と規則の制約 — 弾・指揮所・要請間隔・射程・火力の統制線 — だけで、
 * 「どこを撃つか」「いま撃つべきか」という判断は呼ぶ側が持つ。
 */
export function fireMissionBlocker(
  world: World,
  co: CompanyState,
  target: Vec2,
): FireMissionBlock | null {
  const doc = sideDoctrine(world, co.side);
  // ドクトリンで持ち弾が変わる(仕様 §13)。自律群は火力支援を持たない
  if (doc.fireSupport <= 0) return "no_fire_support";
  if (co.mortarRoundsUsed >= mortarMagazine(world, co)) return "no_rounds";
  if (!hasCommandPost(world, co)) return "no_command_post";
  // 判断周期・要請間隔ともドクトリンで鈍る。非正規軍は「呼べるが遅い」
  if (world.tick - co.lastFireMissionTick < COOLDOWN_TICKS * doc.radioLatencyMul) {
    return "cooldown";
  }
  // すでに飛翔中の任務があるなら重ねない
  if (world.fireMissions.some((m) => m.side === co.side && m.companyId === co.companyId)) {
    return "in_flight";
  }

  // 射程の窓に入っているか(指揮所から測る)
  const range = dist(co.cp, target);
  if (range < MORTAR.MIN_RANGE || range > MORTAR.MAX_RANGE) return "out_of_range";

  // ── 火力の統制線(FSCM、`[v6.16]` 仕様 §5/§8.2)──
  //
  // 危険近接の判断は、**中隊長が報告で把握している前線**に照らして行う。射撃の
  // 可否を決めるのは指揮官の持っている線であって盤面の事実ではない、というのが
  // FSCM の要点で、実際の射撃要請でも「前線はどこか」は報告で決まる。
  //
  // 以前はここで `world.soldiers` を舐めて全隊員の真の位置を見ていた。判定としては
  // 完璧だが、それは**中隊長が全隊員の位置を遅延ゼロで知っている**ということで、
  // 仕様 §5 が破れていた。線は無線2ホップぶん古いので、前へ出た部隊の頭越しに
  // 落ちることがある — その代償は自軍の**制圧**であって損害ではない(仕様 §8.2、
  // `resolveImpact` を参照)。
  //
  // 報告が無ければ線が引けない。**線が引けないなら撃たない** — 実際の射撃統制でも
  // クリアランスの取れない射撃は行わない。
  //
  // `[v6.17]` **前線からの距離で測る。前後の半平面ではない。** 前進フレームの前方
  // 成分だけで見ていたときは、**側面へ張り出した部隊の頭上が抜けていた** — 前線より
  // 前でありさえすれば、真横に自軍がいても撃ててしまう。折れ線からの距離なら、
  // 線がどう曲がっていても、その近傍はすべて危険近接として弾かれる。
  //
  // `[v7.2]` 人間・LLM の要請もこの線で弾く。画面で自軍が見えていても、射撃の可否を
  // 決めるのは中隊長の持っている線であって、プレイヤーの目ではない。
  if (co.flot.sources === 0) return "no_flot";
  if (distToFlot(co.flot, target) < MORTAR.DANGER_CLOSE) return "danger_close";
  // 指揮所は前線の折れ線に乗らない(部下の報告で引くので)。自分の位置は自分で
  // 知っているから、ここだけは中隊長自身の座標で見てよい(仕様 §5)。
  if (dist(co.cp, target) < MORTAR.DANGER_CLOSE) return "danger_close";
  return null;
}

export type FireMissionResult =
  | { ok: true; missionId: number; rounds: number }
  | { ok: false; reason: FireMissionBlock };

/**
 * 射撃を要請する(`[v7.2]`)。通れば任務を飛ばし、通らなければ理由を返す。
 *
 * 照準点は呼んだ側が決める。AIの中隊長は belief の塊(`pickTarget`)、人間とLLMは
 * 自分の画面・観測に出ている像から選ぶ。どちらも**要請した時点の点で凍結され**、
 * 飛翔時間のあいだに敵が動けば外れる(仕様 §5)。
 */
export function requestFireMission(
  world: World,
  co: CompanyState,
  target: Vec2,
): FireMissionResult {
  const block = fireMissionBlocker(world, co, target);
  if (block) return { ok: false, reason: block };
  const doc = sideDoctrine(world, co.side);
  const rounds = Math.min(MORTAR.ROUNDS_PER_MISSION, mortarMagazine(world, co) - co.mortarRoundsUsed);
  co.mortarRoundsUsed += rounds;
  co.lastFireMissionTick = world.tick;
  const id = world.nextFireMissionId++;
  world.fireMissions.push({
    id,
    side: co.side,
    companyId: co.companyId,
    target: { x: target.x, z: target.z },
    requestedTick: world.tick,
    roundsLeft: rounds,
    // 飛翔時間もドクトリンの無線遅延を受ける — 要請が上るのに時間が掛かるほど遅い
    nextImpactTick: world.tick + Math.round(TOF_TICKS * doc.radioLatencyMul),
  });
  return { ok: true, missionId: id, rounds };
}

/** 散布を1発ぶん引く。陣営ごとのストリームなので、鏡像の状況は同じ目を引く。 */
function disperse(rng: Rng, at: Vec2, spread: number): Vec2 {
  // 一様乱数2本から極座標へ。決定論的で、方向にも距離にも偏りが出ない
  const ang = next(rng) * Math.PI * 2;
  const r = Math.sqrt(next(rng)) * spread;
  return { x: at.x + Math.cos(ang) * r, z: at.z + Math.sin(ang) * r };
}

/**
 * 着弾1発の解決。
 *
 * **制圧は敵味方を問わない**(仕様 §8.6)。砲弾は陣営を見ないので、自軍の頭越しに
 * 落ちれば自軍も伏せる。統制線が古いことの代償はここに出る(`[v6.16]`)。
 *
 * **損害は敵にしか出さない**(仕様 §8.2)。仕様は同士討ちを「起きないもの」として
 * 抽象化しているので、砲でも例外を作らない。統制線を報告由来にした `[v6.16]` から
 * は自軍の上に落ちることが実際に起こるため、この分岐が §8.2 を保つ最後の砦になる
 * (それ以前は危険近接の判定が盤面の真値だったので、そもそも起こらなかった)。
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
    if (s.side === side) continue; // 仕様 §8.2 同士討ちは起こさない。制圧までは受ける
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
 * いまの時点で使ってよい弾数(`[v6.10]`)。
 *
 * 中隊長は戦闘の長さを見積もって弾を配分する。開幕に1回ぶんの斉射を手元に置き、
 * 残りを地平までかけて放出する。攻防戦は制限時間そのものが地平になる。
 *
 * **この関数が無いと前半で撃ち尽くす。** 要請間隔だけで抑えても、間隔が明けた瞬間に
 * 必ず撃つので同じこと(実測: 12発が開始150秒で空、後半は火力支援なし)。
 */
function releasedRounds(world: World, magazine: number): number {
  const horizonTicks =
    world.timeLimitTicks > 0
      ? world.timeLimitTicks
      : Math.round(MORTAR.PLAN_HORIZON_SEC * SIM_HZ);
  const t = Math.min(1, world.tick / Math.max(1, horizonTicks));
  return Math.round(magazine * (MORTAR.OPENING_FRACTION + (1 - MORTAR.OPENING_FRACTION) * t));
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

  // ── 2. 中隊長(AI)の要請 ──
  for (const co of world.companies) {
    // 人間・LLM が中隊長に座っていれば、撃つかどうかはその人が決める(仕様 §4)
    if (aiSuppressed(world, "company", co.side, co.companyId)) continue;
    // 射撃計画(`[v6.10]`)。いまの時点で使ってよい弾数まで。
    // これが無いと間隔が明けるたびに撃ち、前半で撃ち尽くす。**これはAIの配分の判断**
    // であって規則ではないので、人間・LLM には掛けない(撃ち急ぐのも指揮官の裁量)
    const magazine = mortarMagazine(world, co);
    if (co.mortarRoundsUsed >= releasedRounds(world, magazine)) continue;

    const target = pickTarget(world, co);
    if (!target) continue;
    requestFireMission(world, co, target);
  }
}
