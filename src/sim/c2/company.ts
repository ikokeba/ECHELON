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
  CASEVAC_ASSET_CAPACITY,
  CASEVAC_ASSET_SPEED,
  CASEVAC_QUEUE_PENALTY_SEC,
  COMPANY_DECIDE_SEC,
  PLATOON_FRONTAGE,
  SIM_HZ,
} from "../constants.ts";
import { aiSuppressed } from "../control.ts";
import { clamp } from "../geometry.ts";
import { next } from "../rng.ts";
import { commandFactor } from "./succession.ts";
import type { CompanyState, Contact, Soldier, Vec2 } from "../types.ts";
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

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** belief の中で最も確度の高い接触。確度0のゴーストは判断に使わない(仕様 §5 `[v6]`)。 */
function primaryThreat(belief: Map<string, Contact>): Contact | null {
  let best: Contact | null = null;
  for (const c of belief.values()) {
    if (c.confidence <= 0) continue;
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
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
    sees: [],
    suppressor: false,
    traits: {
      aggressiveness: next(rng),
      boldness: next(rng),
      caution: next(rng),
    },
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

    // 人間がこの中隊長を操作しているなら、AIの意思決定は行わない(仕様 §4)
    if (aiSuppressed(world, "company", co.side, co.companyId)) continue;

    // 指揮継承直後は判断周期が伸びる(仕様 §12)。中隊は影響が最も長く続く階層
    const factor = commandFactor(co, world.tick, "company");
    if (world.tick - co.lastDecisionTick < Math.round(DECIDE_BASE_TICKS / factor)) continue;
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

    living.forEach((pl, i) => {
      const lateral = (i - (living.length - 1) / 2) * frontage;
      const objective: Vec2 = {
        x: aim.x + right.x * lateral,
        z: aim.z + right.z * lateral,
      };
      co.platoonObjectives.set(pl.platoonId, objective);

      // 人間が操作している小隊には再割り当てを行わない(仕様 §4 `[v6]`)
      if (aiSuppressed(world, "platoon", pl.side, pl.platoonId)) return;
      pl.objective = objective;
    });
  }
}
