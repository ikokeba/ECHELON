/**
 * 後援部隊(増援)の要請と到着(`[v7.0]`)。
 *
 * 流れは3段だけ:
 *   1. **要請** — 陣営の最上位の指揮官(中隊長、いなければ小隊長)が呼ぶ。AIなら
 *      戦闘可能者の割合が `autoCallBelow` を割ったとき、人間・LLM なら任意のとき
 *      (`playerOrders.orderReinforcement`)。回数には上限がある
 *   2. **待ち** — `delaySec` 後に着く。そのあいだ盤上には何も無い
 *   3. **到着** — `entry` の位置に分隊/小隊が現れ、既存の指揮系統へ組み込まれる。
 *      分隊は最も消耗した小隊の麾下へ、小隊は中隊の麾下へ。以後はふつうのAIが動かす
 *
 * 数・規模・出現位置・待ち時間は `ReinforcementSpec` の値で、**詳細は相談のうえ確定する
 * 前提の暫定値**。仕組みはどの値でも同じに動く。
 *
 * ── 対称性(仕様 §2/§13)──
 * 陣営で分岐しない。要請の判断も出現位置も「その陣営自身の」状態と前進方向から決まり、
 * 新しい部隊の個体差の種は到着の通し番号から取る(両陣営で同じ順に同じ種)。
 */

import { SIM_HZ } from "../constants.ts";
import { aiSuppressed } from "../control.ts";
import { collidesWallIndexed } from "../wallIndex.ts";
import { makeReinforcementUnit } from "../scenario.ts";
import { DEFAULT_FORCE, type ForceSpec } from "../force.ts";
import { buildFireteams, buildPlatoons, buildSquads, type World } from "../world.ts";
import { isOffField } from "./litter.ts";
import type { Echelon, Scenario, Side, Soldier, Vec2 } from "../types.ts";

/** 出現位置を盤の縁からどれだけ内側に取るか m */
const EDGE_MARGIN = 8;
/** 壁にかからない地点を探す範囲 m */
const FREE_SEARCH = 30;

export interface TopCommand {
  echelon: Extract<Echelon, "company" | "platoon">;
  unitId: number;
  commanderId: number | null;
  advanceDir: Vec2;
  /** 中隊なら指揮所、小隊なら集結地点 */
  rear: Vec2;
}

/** 陣営の最上位の指揮ノード。後援を呼べるのはここだけ */
export function topCommandOf(world: World, side: Side): TopCommand | null {
  const co = world.companies.find((c) => c.side === side);
  if (co) {
    return {
      echelon: "company",
      unitId: co.companyId,
      commanderId: co.commanderId,
      advanceDir: co.advanceDir,
      rear: co.cp,
    };
  }
  const pls = world.platoons
    .filter((p) => p.side === side)
    .sort((a, b) => a.platoonId - b.platoonId);
  const pl = pls[0];
  if (!pl) return null;
  return {
    echelon: "platoon",
    unitId: pl.platoonId,
    commanderId: pl.commanderId,
    advanceDir: pl.advanceDir,
    rear: world.ccp[side],
  };
}

/** あと何回呼べるか(後援なしなら 0) */
export function reinforcementsLeft(world: World, side: Side): number {
  const r = world.reinforcement[side];
  return r.spec ? Math.max(0, r.spec.calls - r.callsUsed) : 0;
}

/**
 * 後援を要請する。呼べたら true。
 * 呼べないのは: 後援なし・回数切れ・最上位の指揮官が不在(仕様 §12)。
 */
export function callReinforcement(world: World, side: Side): boolean {
  const r = world.reinforcement[side];
  if (!r.spec || reinforcementsLeft(world, side) <= 0) return false;
  const top = topCommandOf(world, side);
  if (!top || top.commanderId === null) return false;
  r.callsUsed += 1;
  r.pending.push({
    calledTick: world.tick,
    arriveTick: world.tick + Math.round(r.spec.delaySec * SIM_HZ),
    size: r.spec.size,
  });
  return true;
}

function freeSpot(world: World, p: Vec2): Vec2 {
  const b = world.bounds;
  const inside = (q: Vec2): boolean =>
    q.x > b.minX + 2 && q.x < b.maxX - 2 && q.z > b.minZ + 2 && q.z < b.maxZ - 2;
  if (inside(p) && !collidesWallIndexed(world.moveIndex, p.x, p.z, 0.8)) return p;
  for (let r = 2; r <= FREE_SEARCH; r += 2) {
    const n = Math.max(8, Math.round(r * 2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = { x: p.x + Math.sin(a) * r, z: p.z + Math.cos(a) * r };
      if (inside(q) && !collidesWallIndexed(world.moveIndex, q.x, q.z, 0.8)) return q;
    }
  }
  return p;
}

/** 出現位置。`rear` は後方の拠点、`edge` はそこから前進方向の真後ろへ盤の縁まで下がった点 */
export function reinforcementEntry(world: World, side: Side): Vec2 | null {
  const r = world.reinforcement[side];
  const top = topCommandOf(world, side);
  if (!r.spec || !top) return null;
  const rear = top.rear;
  if (r.spec.entry === "rear") return freeSpot(world, rear);
  const d = Math.hypot(top.advanceDir.x, top.advanceDir.z) || 1;
  const back = { x: -top.advanceDir.x / d, z: -top.advanceDir.z / d };
  const b = world.bounds;
  // rear から back 方向へ、盤の縁(EDGE_MARGIN 内側)に当たるまでの距離
  const lim = (p: number, v: number, lo: number, hi: number): number =>
    v > 1e-9 ? (hi - EDGE_MARGIN - p) / v : v < -1e-9 ? (lo + EDGE_MARGIN - p) / v : Infinity;
  const t = Math.max(
    0,
    Math.min(lim(rear.x, back.x, b.minX, b.maxX), lim(rear.z, back.z, b.minZ, b.maxZ)),
  );
  return freeSpot(world, { x: rear.x + back.x * t, z: rear.z + back.z * t });
}

/** 戦闘可能者 / これまでに盤に出た総数。AIの要請判断に使う(自軍の状態だけを見る) */
function strengthRatio(world: World, side: Side): number {
  let total = 0;
  let fit = 0;
  for (const s of world.soldiers) {
    if (s.side !== side) continue;
    total++;
    if (s.status === "ok" && !isOffField(s)) fit++;
  }
  return total > 0 ? fit / total : 1;
}

/** 新しい部隊を盤に載せ、指揮系統へ組み込む */
function spawn(world: World, side: Side, size: "squad" | "platoon"): void {
  const r = world.reinforcement[side];
  const top = topCommandOf(world, side);
  const at = reinforcementEntry(world, side);
  if (!top || !at) return;
  const dir = top.advanceDir;
  const co = world.companies.find((c) => c.side === side) ?? null;
  const own = <T extends { side: Side }>(list: readonly T[]): T[] =>
    list.filter((x) => x.side === side);

  const maxSquad = Math.max(-1, ...own(world.squads).map((s) => s.squadId));
  const squadIds = size === "platoon" ? [maxSquad + 1, maxSquad + 2, maxSquad + 3] : [maxSquad + 1];

  // 分隊は「最も消耗した小隊」の麾下へ。小隊は新しく立てて中隊の麾下へ
  let platoonId: number;
  let objective: Vec2;
  if (size === "squad") {
    const ratioOf = (platoonId: number): number => {
      const men = world.soldiers.filter((s) => s.side === side && s.platoonId === platoonId);
      return men.length ? men.filter((s) => s.status === "ok").length / men.length : 1;
    };
    const pls = own(world.platoons)
      .filter((p) => p.commanderId !== null)
      .sort((a, b) => ratioOf(a.platoonId) - ratioOf(b.platoonId) || a.platoonId - b.platoonId);
    const pl = pls[0] ?? own(world.platoons)[0];
    if (!pl) return;
    platoonId = pl.platoonId;
    objective = { ...pl.objective };
  } else {
    platoonId = Math.max(-1, ...own(world.platoons).map((p) => p.platoonId)) + 1;
    objective = co ? { ...co.objective } : { ...(own(world.platoons)[0]?.objective ?? at) };
  }

  const companyId = co?.companyId ?? own(world.platoons)[0]?.companyId ?? 0;
  // 編成オプション(選抜射手・擲弾手・盾持ち)はその陣営の初期編成を引き継ぐ。
  // 世界は ForceSpec を持たないので、生き残っている兵から読み取る
  const spec: ForceSpec = {
    ...DEFAULT_FORCE,
    marksman: world.soldiers.some((s) => s.side === side && s.quals.designatedMarksman),
    grenadier: world.soldiers.some((s) => s.side === side && s.role === "grenadier"),
    shield: world.soldiers.some((s) => s.side === side && s.role === "shield"),
    antiArmor: world.soldiers.some((s) => s.side === side && s.quals.antiArmor === true),
  };
  const unit = makeReinforcementUnit({
    side,
    size,
    platoonId,
    squadIds,
    companyId,
    center: at,
    dir,
    objective,
    variant: 40 + r.arrived * 4,
    spec,
  });

  // id を世界の通し番号で振り直し、壁にかかった兵は近くの空き地へ
  const soldiers: Soldier[] = unit.soldiers.map((s, i) => {
    const id = world.nextSoldierId++;
    const pos = freeSpot(world, s.pos);
    return {
      ...s,
      id,
      pos,
      eye: { ...pos },
      ordinal: 10_000 + r.arrived * 64 + i,
      order: { kind: "hold", facing: { ...dir }, issuedTick: world.tick },
    };
  });
  for (const s of soldiers) {
    world.soldiers.push(s);
    world.soldierById.set(s.id, s);
  }

  const sc = {
    name: "reinforcement",
    seed: 0,
    bounds: world.bounds,
    walls: [],
    soldiers,
    fireteamPlans: unit.plans.fireteamPlans,
    squadPlans: unit.plans.squadPlans,
    platoonPlans: unit.plans.platoonPlans,
  } as Scenario;

  for (const ft of buildFireteams(sc, soldiers)) {
    world.fireteams.push({ ...ft, id: world.fireteams.length });
  }
  for (const sq of buildSquads(sc, soldiers)) {
    const leader = soldiers.find((s) => s.squadId === sq.squadId && s.isSquadLeader);
    world.squads.push({
      ...sq,
      id: world.squads.length,
      // 着任は継承ではない — 判断の質を落とさない(仕様 §12 の劣化は継承のときだけ)
      commanderId: leader?.id ?? null,
      lastDecisionTick: world.tick,
      lastReportTick: world.tick,
    });
  }
  if (size === "platoon") {
    for (const pl of buildPlatoons(sc, soldiers)) {
      const leader = soldiers.find((s) => s.platoonId === pl.platoonId && s.hqRole === "pl");
      world.platoons.push({
        ...pl,
        id: world.platoons.length,
        commanderId: leader?.id ?? null,
        lastDecisionTick: world.tick,
        lastReportTick: world.tick,
      });
    }
  }
  r.arrived += 1;
}

/**
 * 毎ティック: 到着した要請を盤に載せ、AIの最上位指揮官が要請を判断する。
 * stepWorld の先頭(索敵より前)で呼ぶ — 着いた部隊がそのティックから見て動けるように。
 */
export function reinforcementSystem(world: World): void {
  for (const side of ["blue", "red"] as const) {
    const r = world.reinforcement[side];
    if (!r.spec) continue;

    // 到着
    while (r.pending.length > 0 && r.pending[0]!.arriveTick <= world.tick) {
      const call = r.pending.shift()!;
      spawn(world, side, call.size);
    }

    // AIの要請判断(1秒に1回)。人間・LLM が最上位に座っていればAIは呼ばない
    if (world.tick % SIM_HZ !== 0) continue;
    if (r.spec.autoCallBelow <= 0 || r.pending.length > 0) continue;
    if (reinforcementsLeft(world, side) <= 0) continue;
    const top = topCommandOf(world, side);
    if (!top || aiSuppressed(world, top.echelon, side, top.unitId)) continue;
    if (strengthRatio(world, side) < r.spec.autoCallBelow) callReinforcement(world, side);
  }
}
