/**
 * 中隊長AI(仕様 §3 ①、§11)。
 *
 * **情報上の立ち位置**: 小隊長からの報告の集約のみ。小隊長がすでに「やや古い地図」を
 * 見ているのに対し、中隊長はそれをさらに1ホップ遅らせ粒度を粗くしたものを見る
 * (仕様 §5)。したがって中隊長の判断は本質的に「個々の交戦には間に合わない」。
 * これは欠陥ではなく、§3① が言う「個々の交戦には関与しないが、複数の小隊が同時に
 * 崩れかけたときの優先順位づけが主軸」というプレイ感そのもの。
 *
 * やること(仕様 §3 ①):
 *   - 小隊への任務(WHAT)割り当て = 担当区域の配分
 *   - 予備戦力の投入判断 = 損耗した小隊を見て正面幅を絞り、相互支援を厚くする
 *   - CASEVAC(後送)アセットの配分判断 = トリアージ(仕様 §9)
 *
 * 中隊長は指揮所(CP)を拠点とし前線には出ない(仕様 §11)。身体は持つので排除は
 * 可能で、排除されればXOが繰り上がる(仕様 §12、c2/succession.ts)。
 *
 * 戦力対称性(仕様 §2/§13): 両陣営で完全に同一のロジックが動く。
 */

import {
  CASEVAC_ARRIVAL_SEC,
  GRENADE,
  CASEVAC_ASSET_CAPACITY,
  CASEVAC_ASSET_SPEED,
  CASEVAC_QUEUE_PENALTY_SEC,
  COMPANY_DECIDE_SEC,
  DEFENSE,
  PLATOON_FRONTAGE,
  SIM_HZ,
} from "../constants.ts";
import { aiSuppressed, soldierSeated } from "../control.ts";
import { flotFrom } from "./flot.ts";
import { clamp } from "../geometry.ts";
import { next } from "../rng.ts";
import { commandFactor } from "./succession.ts";
import { assignHolders, clampToObjective } from "./objectiveHold.ts";
import { activeTaskOf, isDefender } from "./planning.ts";
import { executePlan, planLeg } from "./planEdit.ts";
import { sideDoctrine } from "../world.ts";
import type { CompanyState, Contact, Mission, Objective, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const DECIDE_BASE_TICKS = Math.round(COMPANY_DECIDE_SEC * SIM_HZ);

/**
 * 小隊がこの割合まで損耗すると、中隊長は正面幅を絞って相互支援を厚くする。
 * 仕様 §3①「複数の小隊が同時に崩れかけたときの優先順位づけ」を、
 * 予備兵力を持たない現在の編成で表現できる最小の判断として実装した `[v6]`。
 */
const CONSOLIDATE_STRENGTH_RATIO = 0.6;
/** 集約時に正面幅へ掛ける係数。 */
const CONSOLIDATE_FRONTAGE_MUL = 0.55;
/**
 * 拠点を守る小隊の持ち場を、拠点中心からこれだけは広げてよい m。`[v6.2]`
 * 拠点が建物内の1室(半径3m)でも、小隊36名は建物と周囲の遮蔽に散って守る。
 * これが無いと「半径2mの点に36名集合」という指示になる。
 */
const PLATOON_HOLD_SPREAD = 16;
/**
 * 未確保拠点を担当区域へ引き込む距離。正面幅に対する倍率。`[v6.2]`
 * 1.0 だと隣の小隊の区域まで手を伸ばし、0.5 だと少し外れた拠点を誰も取りに行かない。
 */
const OBJECTIVE_CLAIM_MUL = 0.9;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * belief の中で最も確度の高い接触。確度0のゴーストは判断に使わない(仕様 §5 `[v6]`)。
 * `[v7.3]` 聞いただけの接触(A-5)も使わない — 担当区域の向きは見た敵で決める
 */
function primaryThreat(belief: Map<string, Contact>): Contact | null {
  let best: Contact | null = null;
  for (const c of belief.values()) {
    if (c.confidence <= 0 || c.heard) continue;
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
}

/**
 * 逆襲の判断(`[v7.3]` ロードマップ A-4)。攻防戦の防御側の中隊長だけが行う。
 *
 * 防御は張り付くだけでは崩される。ドクトリン(ADP 3-90)は、奪われた陣地を**敵が統合・再編を
 * 終える前に**予備で取り返すことを防御の一部としている。ここではそれを次の規則にした:
 *
 *   1. 作戦で受け持った拠点のうち、自軍の所有でなくなったもの(奪われた・奪われかけて中立)を
 *      作戦の順(主陣地が先)に1つ選ぶ
 *   2. 差し向ける小隊: 作戦の予備があればそれ。無ければ、自分の拠点を保持できていて、
 *      そのまわりの敵(中隊長の像)が少なく(`COUNTER_MAX_LOCAL_THREAT`)、残存率が十分な小隊。
 *      保持できている拠点が1つしか無いなら、そこは空けない(予備が無ければ逆襲しない)
 *   3. 取り返したら(=所有に戻ったら)解除し、小隊は自分の持ち場へ戻る
 *
 * 材料は拠点の所有(全員に見える事実)と、中隊長の belief と麾下の兵力だけ(P1)。
 * 人間の中隊長は同じことを `assignPlatoonMission`(seize)でできる(P4)。
 */
function decideCounterattack(
  world: World,
  co: CompanyState,
  living: ReadonlyArray<{ platoonId: number; side: CompanyState["side"] }>,
): { platoonId: number; objective: Objective } | null {
  const plan = co.plan;
  if (!plan || !isDefender(world, co.side)) {
    co.counterattack = null;
    return null;
  }
  const objOf = (id: number | null): Objective | null =>
    id === null ? null : (world.objectives.find((o) => o.id === id) ?? null);
  const strength = (platoonId: number): number => {
    const men = world.soldiers.filter((s) => s.side === co.side && s.platoonId === platoonId);
    return men.length === 0 ? 0 : men.filter((s) => s.status === "ok").length / men.length;
  };
  const isLiving = (platoonId: number): boolean => living.some((p) => p.platoonId === platoonId);

  // 続行中の逆襲: 拠点がまだ取り返せておらず、小隊が戦える間は続ける
  if (co.counterattack) {
    const o = objOf(co.counterattack.objectiveId);
    if (
      o &&
      o.owner !== co.side &&
      isLiving(co.counterattack.platoonId) &&
      strength(co.counterattack.platoonId) > 0.25
    ) {
      return { platoonId: co.counterattack.platoonId, objective: o };
    }
    co.counterattack = null;
  }

  const lost = plan.tasks
    .map((t) => objOf(t.objectiveId))
    .filter((o): o is Objective => o !== null && o.owner !== co.side);
  const target = lost[0];
  if (!target) return null;

  const heldTasks = plan.tasks.filter((t) => objOf(t.objectiveId)?.owner === co.side);
  const threatNear = (p: Vec2): number => {
    let n = 0;
    for (const c of co.belief.values()) {
      if (c.confidence <= 0 || c.heard) continue;
      if (dist(c.pos, p) <= DEFENSE.COUNTER_THREAT_RADIUS) n++;
    }
    return n;
  };

  let pick: number | null = null;
  const reserve = plan.tasks.find((t) => t.role === "reserve" && isLiving(t.platoonId));
  if (reserve && strength(reserve.platoonId) >= DEFENSE.COUNTER_MIN_STRENGTH) {
    pick = reserve.platoonId;
  } else if (heldTasks.length >= 2) {
    let best: { id: number; threat: number; str: number } | null = null;
    for (const t of heldTasks) {
      if (!isLiving(t.platoonId)) continue;
      const o = objOf(t.objectiveId)!;
      const threat = threatNear(o.pos);
      const str = strength(t.platoonId);
      if (threat > DEFENSE.COUNTER_MAX_LOCAL_THREAT || str < DEFENSE.COUNTER_MIN_STRENGTH) continue;
      // 敵が少ないほど、同じなら兵力が多いほど、同じなら作戦の順(決定論)
      if (!best || threat < best.threat || (threat === best.threat && str > best.str + 1e-9)) {
        best = { id: t.platoonId, threat, str };
      }
    }
    pick = best?.id ?? null;
  }
  if (pick === null) return null;
  co.counterattack = { objectiveId: target.id, platoonId: pick, sinceTick: world.tick };
  return { platoonId: pick, objective: target };
}

/**
 * 補充兵の合流(仕様 §9)。
 *
 * 「アセットがCCPに到着し負傷者を収容すると同時に、**同じMOSを継承した補充兵1名**が
 * CCPで即座に分隊へ合流する」。移動の往復手間は発生させない、という仕様の指定どおり
 * その場で編成に戻す。個体差パラメータは新規ランダム(MOSのみ継承)。
 *
 * 階級章(分隊長・FTリーダーのフラグ)は継承しない。補充で送られてくるのは
 * 一兵卒であって下士官ではなく、指揮は既に §12 の継承で次席者へ渡っているため。
 */
function joinReplacement(world: World, casualty: Soldier): void {
  const rng = world.rngBySide[casualty.side];
  const ccp = world.ccp[casualty.side];
  const id = world.nextSoldierId++;
  const replacement: Soldier = {
    id,
    side: casualty.side,
    companyId: casualty.companyId,
    platoonId: casualty.platoonId,
    squadId: casualty.squadId,
    fireteamId: casualty.fireteamId,
    isFireteamLeader: false,
    isSquadLeader: false,
    pos: { x: ccp.x, z: ccp.z },
    facing: { ...casualty.facing },
    status: "ok",
    role: casualty.role,
    hqRole: null,
    quals: { ...casualty.quals },
    suppressedUntilTick: 0,
    evadeUntilTick: 0,
    observedByEnemy: false,
    assaultingUntilTick: 0,
    holdFireUntilTick: 0,
    grenades: casualty.role === "grenadier" ? GRENADE.CHARGES : 0,
    routed: false,
    bleedOutTick: 0,
    assignedAider: null,
    treating: null,
    aidProgressTicks: 0,
    stabilized: false,
    evac: "none",
    bearers: [],
    bearing: null,
    speedMul: 1,
    order: { kind: "hold", facing: { ...casualty.facing }, issuedTick: world.tick },
    path: [],
    pathIdx: 0,
    stuckTicks: 0,
    sees: [],
    suppressor: false,
    assignedTarget: null,
    eye: { x: ccp.x, z: ccp.z },
    peeking: false,
    atWindow: false,
    traits: {
      aggressiveness: next(rng),
      boldness: next(rng),
      caution: next(rng),
    },
    // 編成上の位置は戦死者から引き継ぐ。鏡像の補充兵どうしが一致する(仕様 §2/§13)
    ordinal: casualty.ordinal,
    seesFar: [],
    alertFrom: null,
    alertUntilTick: 0,
  };
  world.soldiers.push(replacement);
  world.soldierById.set(id, replacement);
}

/**
 * 後送アセットの運用(仕様 §9)。
 *
 * 到着時間は「CCPからアセット発進地点(CP)までの距離」と「抱えている他の要請数」の
 * 組み合わせで3〜8分の幅に収まる。これがいわゆるゴールデンアワーのプレッシャーで、
 * 中隊長が複数箇所の要請へ限られた台数を配分するトリアージの材料になる。
 */
function runCasevacAssets(world: World, co: CompanyState): void {
  const ccp = world.ccp[co.side];

  // ── 到着したアセットが負傷者を収容し、同数の補充兵が合流する ──
  for (const asset of co.assets) {
    if (asset.arriveTick === null || world.tick < asset.arriveTick) continue;
    asset.arriveTick = null;

    const waiting = world.soldiers.filter(
      (s) => s.side === co.side && s.companyId === co.companyId && s.evac === "evacuated",
    );
    for (const casualty of waiting.slice(0, CASEVAC_ASSET_CAPACITY)) {
      casualty.evac = "collected";
      joinReplacement(world, casualty);
    }
  }

  // ── 待機中の要請があれば、空いているアセットを発進させる ──
  const pending = world.soldiers.filter(
    (s) => s.side === co.side && s.companyId === co.companyId && s.evac === "evacuated",
  ).length;
  if (pending === 0) return;

  // 発進済みのアセットが収容しきれる分は、追加で出しても意味がない。
  // ここを見ないと、負傷者1名に対して保有台数すべてを飛ばしてしまい、
  // 次の要請に応えるアセットが残らない(トリアージの逆)。
  const inFlight = co.assets.filter((a) => a.arriveTick !== null).length;
  if (pending <= inFlight * CASEVAC_ASSET_CAPACITY) return;

  const free = co.assets.find((a) => a.arriveTick === null);
  if (!free) return; // 全台が出払っている。要請は次の判断周期まで待つ

  const travelSec = clamp(
    CASEVAC_ARRIVAL_SEC.min +
      dist(co.cp, ccp) / CASEVAC_ASSET_SPEED +
      Math.max(0, pending - 1) * CASEVAC_QUEUE_PENALTY_SEC,
    CASEVAC_ARRIVAL_SEC.min,
    CASEVAC_ARRIVAL_SEC.max,
  );
  free.arriveTick = world.tick + Math.round(travelSec * SIM_HZ);
}

/** 中隊本部要員の位置取り(仕様 §11: 中隊長はCPを拠点、1SGはCCP常駐)。 */
function postCompanyHq(world: World, co: CompanyState): void {
  for (const s of world.soldiers) {
    if (s.side !== co.side || s.companyId !== co.companyId) continue;
    if (s.hqRole === null || s.status !== "ok") continue;
    if (s.hqRole === "pl" || s.hqRole === "plRto") continue; // 小隊本部は小隊長AIの担当

    // 中隊長本人を人間が操作している間はAIの位置取りを止める(仕様 §4)
    if (s.hqRole === "co" && aiSuppressed(world, "company", co.side, co.companyId)) continue;
    // 本部要員に一兵卒として座っている間も止める(`[v7.3]` A-7)
    if (soldierSeated(world, s)) continue;

    const post = s.hqRole === "firstSergeant" ? world.ccp[co.side] : co.cp;
    const arrived = dist(s.pos, post) < 2.0;
    s.order = arrived
      ? { kind: "hold", facing: { ...co.advanceDir }, issuedTick: world.tick }
      : { kind: "move", target: { ...post }, facing: { ...co.advanceDir }, issuedTick: world.tick };
  }
}

export function companyAI(world: World): void {
  for (const co of world.companies) {
    // 後送アセットは中隊長の意思決定周期に関係なく走らせる。これは指揮判断ではなく
    // 「発進済みのアセットが到着する」という物理現象なので、指揮が劣化しても止まらない
    runCasevacAssets(world, co);
    postCompanyHq(world, co);

    // 作戦の実行(`[v7.3]` A-1: 開始時刻・経由点・調整線・射撃計画)。誰が座っていても走る
    executePlan(world, co);
    // 人間がこの中隊長を操作しているなら、AIの意思決定は行わない(仕様 §4)
    if (aiSuppressed(world, "company", co.side, co.companyId)) continue;

    // 指揮継承直後は判断周期が伸びる(仕様 §12)。中隊は影響が最も長く続く階層
    const factor = commandFactor(co, world.tick, "company");
    // ドクトリンで判断周期が伸びる(仕様 §13)。正規軍は倍率1で現行と一致 `[v6.8]`
    const decideMul = sideDoctrine(world, co.side).decideMul.company;
    if (world.tick - co.lastDecisionTick < Math.round((DECIDE_BASE_TICKS * decideMul) / factor)) {
      continue;
    }
    co.lastDecisionTick = world.tick;
    if (co.commanderId === null) continue; // 指揮を執れる者がいない

    const platoons = world.platoons.filter(
      (p) => p.side === co.side && p.companyId === co.companyId,
    );
    const living = platoons.filter((pl) =>
      world.soldiers.some(
        (s) => s.side === pl.side && s.platoonId === pl.platoonId && s.status === "ok",
      ),
    );
    if (living.length === 0) continue;

    // 中隊の位置は麾下小隊の重心の平均。中隊長も報告経由でしか麾下の位置を知らない
    const anchor = { x: 0, z: 0 };
    let weakest = 1;
    for (const pl of living) {
      const men = world.soldiers.filter((s) => s.side === pl.side && s.platoonId === pl.platoonId);
      const fit = men.filter((s) => s.status === "ok");
      let sx = 0;
      let sz = 0;
      for (const m of fit) {
        sx += m.pos.x;
        sz += m.pos.z;
      }
      anchor.x += sx / Math.max(1, fit.length);
      anchor.z += sz / Math.max(1, fit.length);
      const ratio = men.length > 0 ? fit.length / men.length : 0;
      if (ratio < weakest) weakest = ratio;
    }
    anchor.x /= living.length;
    anchor.z /= living.length;

    // ── 前線(FLOT、`[v6.16]` 仕様 §5/§11)──
    // 中隊長は麾下小隊からの**報告だけ**で引く。無線2ホップぶん古いので、小隊長が
    // 持っている線よりさらに遅れる — それが指揮階層を分けていることの意味そのもの。
    // 火力の統制(`systems/indirect.ts`)がこの線を使う。
    co.flot = flotFrom(co.platoonReports.values(), co.advanceDir, world.tick);

    const threat = primaryThreat(co.belief);
    const aim = threat ? threat.pos : co.objective;
    const dx = aim.x - anchor.x;
    const dz = aim.z - anchor.z;
    const d = Math.hypot(dx, dz) || 1;
    const forward = { x: dx / d, z: dz / d };
    const right = { x: -forward.z, z: forward.x };

    // 予備投入の代わりの判断: どこかの小隊が崩れかけていれば正面幅を絞り、
    // 小隊同士が相互に支援できる距離まで寄せる(仕様 §3①)
    const frontage =
      weakest < CONSOLIDATE_STRENGTH_RATIO
        ? PLATOON_FRONTAGE * CONSOLIDATE_FRONTAGE_MUL
        : PLATOON_FRONTAGE;

    // 攻勢分遣(F-2, `[v6.1]` 任務種別 §3①): 兵力が敵の `offensiveRatio` 倍以上あり、まだ確保
    // していない拠点があれば、1個小隊をそこへ差し向ける。しきい値はデバッグ調整可。
    const myEff = world.soldiers.filter((s) => s.side === co.side && s.status === "ok").length;
    const enemyEff = world.soldiers.filter((s) => s.side !== co.side && s.status === "ok").length;
    const canDetach = enemyEff > 0 && myEff / enemyEff >= world.posture[co.side].offensiveRatio;
    const openObj = world.objectives.filter(
      (o) => o.owner !== co.side && !(o.owner === null && o.progressBy === co.side),
    );
    // 差し向ける小隊 = その未確保拠点に最も近い小隊(かつ最弱ではない)
    let detachPlatoonId: number | null = null;
    let detachTarget: Vec2 | null = null;
    if (canDetach && openObj.length > 0) {
      const plCentroid = (pl: (typeof living)[number]): Vec2 => {
        const men = world.soldiers.filter(
          (s) => s.side === pl.side && s.platoonId === pl.platoonId && s.status === "ok",
        );
        let sx = 0;
        let sz = 0;
        for (const m of men) {
          sx += m.pos.x;
          sz += m.pos.z;
        }
        return men.length ? { x: sx / men.length, z: sz / men.length } : { ...co.cp };
      };
      let bestD = Infinity;
      for (const pl of living) {
        // 作戦(`[v6.5]`)で任務が決まっている小隊は引き抜かない。攻勢分遣は
        // 「手が空いている小隊を追加で差し向ける」判断であって、主攻の付け替えではない
        if (activeTaskOf(world, co, pl.platoonId)) continue;
        const c = plCentroid(pl);
        for (const o of openObj) {
          const dd = dist(c, o.pos);
          if (dd < bestD) {
            bestD = dd;
            detachPlatoonId = pl.platoonId;
            detachTarget = { ...o.pos };
          }
        }
      }
    }

    // 確保済み拠点の保持(`[v6.1]`、`[v6.2]` で最寄り1個小隊に限定)。拠点ごとに
    // **最寄りの1個小隊だけ**が守備に付く。全員を掛けると、拠点が小さいときに
    // 中隊まるごとが1点へ吸い寄せられて戦線が消える(詳細は c2/objectiveHold.ts)。
    const plCentroidOf = (pl: (typeof living)[number]): Vec2 | null => {
      const men = world.soldiers.filter(
        (s) => s.side === pl.side && s.platoonId === pl.platoonId && s.status === "ok",
      );
      if (men.length === 0) return null;
      let sx = 0;
      let sz = 0;
      for (const m of men) {
        sx += m.pos.x;
        sz += m.pos.z;
      }
      return { x: sx / men.length, z: sz / men.length };
    };
    const holders = assignHolders(
      world,
      co.side,
      living
        .map((pl) => ({ key: pl.platoonId, centroid: plCentroidOf(pl) }))
        .filter((e): e is { key: number; centroid: Vec2 } => e.centroid !== null),
    );

    // 未確保拠点の割り当て(`[v6.2]`)。中隊長が小隊へ与えるのは幾何的な「点」ではなく
    // **取るべき拠点**であるべき(仕様 §3① / §12 の複数拠点同時争奪)。
    // 担当区域を脅威まわりの等間隔だけで決めていたため、脅威から離れた拠点は
    // どの小隊の担当にもならず、最後まで中立で残っていた(ヘッドレスで確認)。
    // 幾何的な区域を出発点に、その近くの未確保拠点へ1個小隊ずつ割り当てる。
    const sectorOf = (i: number): Vec2 => {
      const lateral = (i - (living.length - 1) / 2) * frontage;
      return { x: aim.x + right.x * lateral, z: aim.z + right.z * lateral };
    };
    /** 拠点をこの距離まで引き寄せて担当に含める m。正面幅に比例させる */
    const claimRange = frontage * OBJECTIVE_CLAIM_MUL;
    const unclaimed = world.objectives.filter(
      (o) => !(o.owner === co.side || (o.owner === null && o.progressBy === co.side)),
    );
    const claimed = new Map<number, Vec2>(); // platoonId → 拠点位置
    const takenObj = new Set<number>();
    // 作戦(`[v6.5]`)で既に割り当て済みの拠点は、他の小隊に二重に claim させない
    for (const pl of living) {
      const t = activeTaskOf(world, co, pl.platoonId);
      if (t?.objectiveId != null) takenObj.add(t.objectiveId);
    }
    living.forEach((pl, i) => {
      if (holders.has(pl.platoonId)) return; // すでに守備に付いている小隊は動かさない
      if (activeTaskOf(world, co, pl.platoonId)) return; // 計画で任務が決まっている
      const sector = sectorOf(i);
      let best: (typeof unclaimed)[number] | null = null;
      let bestD = Infinity;
      for (const o of unclaimed) {
        if (takenObj.has(o.id)) continue;
        const d = dist(sector, o.pos);
        if (d > claimRange || d >= bestD) continue;
        bestD = d;
        best = o;
      }
      if (best) {
        takenObj.add(best.id);
        claimed.set(pl.platoonId, { ...best.pos });
      }
    });

    // 逆襲(`[v7.3]` ロードマップ A-4)。攻防戦の防御側が、奪われた拠点へ1個小隊を差し向ける
    const counter = decideCounterattack(world, co, living);

    living.forEach((pl, i) => {
      // 戦闘前に立てた作戦(`[v6.5]` c2/planning.ts)。対象の拠点を取り終えるまでは
      // 計画の割り当てを維持する — 接敵のたびに担当区域が脅威の方向へ振れて、
      // 側面の拠点が最後まで誰の担当にもならない、という問題(F-9)への答えでもある。
      // 完了した任務は `activeTaskOf` が null を返し、以後は従来の割り当てへ戻る。
      const task = activeTaskOf(world, co, pl.platoonId);
      let objective: Vec2 = task
        ? { ...task.mission.target }
        : (claimed.get(pl.platoonId) ?? sectorOf(i));

      const held = holders.get(pl.platoonId) ?? null;

      // 0.7: 守備の小隊を拠点中心に固めず、拠点内の遮蔽へ広めに散らす(`[v6.1]`)。
      // 下限 PLATOON_HOLD_SPREAD: 拠点が1室でも小隊が点に固まらないだけの床を残す。
      if (held) objective = clampToObjective(objective, held, 0.7, PLATOON_HOLD_SPREAD);

      // 任務種別(§3①):
      //   攻勢分遣に指名された小隊 → 未確保拠点へ seize
      //   担当区域に脅威も拠点も無い側面の小隊 → screen(掩護・監視)
      //   それ以外 → seize(担当区域の確保 / 保持)
      let mkind: Mission["kind"] = task ? task.mission.kind : "seize";
      // 作戦の段階(`[v7.3]` A-1)。開始時刻まで待つ・経由点を通る・調整線で揃う
      const leg = task ? planLeg(world, co, task) : null;
      if (task) task.legKey = leg?.key ?? "mission";
      if (leg && !(counter && pl.platoonId === counter.platoonId)) {
        objective = { ...leg.target };
        mkind = leg.kind;
      } else if (counter && pl.platoonId === counter.platoonId) {
        // 逆襲に出る小隊は、奪われた拠点そのものを取り返しに行く(守備の持ち場へは引き戻さない)
        objective = { ...counter.objective.pos };
        mkind = "seize";
      } else if (pl.platoonId === detachPlatoonId && detachTarget) {
        objective = detachTarget;
        mkind = "seize";
      } else if (
        !task &&
        living.length >= 3 &&
        !held &&
        !threat &&
        (i === 0 || i === living.length - 1)
      ) {
        // 3個小隊以上あるときだけ、両端の1個ずつを掩護に回す(中央は確保前進)
        mkind = "screen";
      }
      const mission: Mission = { kind: mkind, target: { ...objective } };

      co.platoonObjectives.set(pl.platoonId, objective);
      co.platoonMissions.set(pl.platoonId, mission);

      // 人間が操作している小隊には再割り当てを行わない(仕様 §4 `[v6]`)
      if (aiSuppressed(world, "platoon", pl.side, pl.platoonId)) return;
      pl.objective = objective;
      pl.mission = mission;
    });
  }
}
