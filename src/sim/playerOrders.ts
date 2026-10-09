/**
 * 人間が操作中のノードから出す命令(仕様 §4)。
 *
 * ここが提供するのは**AIが出せるのと同じ命令だけ**である(仕様 §1・§13:
 * 「操作しても、AIが持たない能力は得られない」)。プレイヤー専用の強化された命令や、
 * 通常の情報階層を迂回する手段は一切用意しない。
 *
 * 命令はタクティカル・ポーズ中でも発行でき、ポーズ解除後はタイムラグなしで
 * 即座に実行される(仕様 §6)。これはポーズが単にティックを止めているだけで、
 * 命令の適用経路がAIと共通だから自動的に成り立つ。
 */

import { PLATOON_FRONTAGE } from "./constants.ts";
import type { ControlState } from "./control.ts";
import type { Mission, Vec2 } from "./types.ts";
import type { World } from "./world.ts";
import type { OrderFn } from "./replay.ts";
import { callReinforcement, topCommandOf } from "./systems/reinforcement.ts";
import { requestFireMission, type FireMissionResult } from "./systems/indirect.ts";
import { throwSmoke, type SmokeResult } from "./systems/smoke.ts";
import { fireAntiArmor, type AntiArmorResult } from "./systems/antiArmor.ts";
import { commandSoldier } from "./c2/fireteam.ts";
import type { Soldier } from "./types.ts";

/*
 * `[v7.0]` どの命令も**座席**(`seat`)を引数に取る。既定は人間の操作枠
 * (`world.control`)で、外部エージェント(LLM、src/llm/)は自分の座席を渡す。
 * 命令の中身と適用経路は人間と完全に同じ — 座席が違うだけ(仕様 §4)。
 */

/** 操作中の分隊へ「ここへ移動せよ」と指示する(分隊長として)。 */
function orderSquadToImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "squad") return false;
  const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
  if (!sq) return false;
  sq.objective = { ...target };
  // 麾下FTへも即座に下ろす(AIの分隊長がやるのと同じ経路)
  for (const ft of world.fireteams) {
    if (ft.side === sq.side && ft.squadId === sq.squadId) {
      ft.objective = { ...target };
    }
  }
  return true;
}

/** 操作中の小隊へ「ここへ移動せよ」と指示する(小隊長として)。 */
function orderPlatoonToImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "platoon") return false;
  const pl = world.platoons.find((p) => p.side === c.side && p.platoonId === c.unitId);
  if (!pl) return false;
  pl.objective = { ...target };
  // 小隊長が担当区域を割り当て直す。分隊を横に展開させる規則はAIと同一。
  const squads = world.squads.filter((s) => s.side === pl.side && s.platoonId === pl.platoonId);
  squads.forEach((sq, i) => {
    const lateral = (i - (squads.length - 1) / 2) * 26;
    const dest = { x: target.x + lateral, z: target.z };
    pl.squadObjectives.set(sq.squadId, dest);
    sq.objective = dest;
  });
  return true;
}

/**
 * 操作中の中隊へ「ここを取れ」と指示する(中隊長として)。`[v6.2]`
 *
 * 仕様 §3① の指揮系統どおり、**中隊長が触れるのは麾下小隊の担当区域までで、
 * 個々の兵には一切命令が行かない**。目標軸に直交する方向へ小隊を並べる規則は
 * AI中隊長(`c2/company.ts`)と同一で、人間だからといって細かく動かせるようにはしない。
 */
function orderCompanyToImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "company") return false;
  const co = world.companies.find((x) => x.side === c.side && x.companyId === c.unitId);
  if (!co) return false;
  co.objective = { ...target };

  const platoons = world.platoons.filter((p) => p.side === co.side && p.companyId === co.companyId);
  // 前進方向に直交する軸へ並べる(AI中隊長と同じ間隔 PLATOON_FRONTAGE)
  const dir = co.advanceDir;
  const right = { x: -dir.z, z: dir.x };
  platoons.forEach((pl, i) => {
    const lateral = (i - (platoons.length - 1) / 2) * PLATOON_FRONTAGE;
    const dest = { x: target.x + right.x * lateral, z: target.z + right.z * lateral };
    co.platoonObjectives.set(pl.platoonId, dest);
    co.platoonMissions.set(pl.platoonId, { kind: "seize", target: { ...dest } });
    pl.objective = dest;
    pl.mission = { kind: "seize", target: { ...dest } };
  });
  return true;
}

/**
 * 操作中の分隊で、止血済みの負傷者に後送(担架搬送)を命じる(仕様 §9)。
 *
 * AI分隊長と**同じ経路**を通す — プレイヤーだけが担架班を無条件に編成できたり、
 * 分隊の戦力を無視して後送できたりはしない(仕様 §13 の公平性)。違いは
 * 「AIは戦力の残りを見て自制するが、人間は自分の判断で命じられる」点だけで、
 * 実際に担架班が組めるかどうかは同じ litterSystem の条件に従う。
 */
function orderCasevacImpl(
  world: World,
  patientId?: number,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "squad") return false;
  const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
  if (!sq) return false;

  const candidates = world.soldiers.filter(
    (s) =>
      s.side === sq.side &&
      s.squadId === sq.squadId &&
      s.status === "wia" &&
      s.stabilized &&
      s.evac === "none" &&
      (patientId === undefined || s.id === patientId),
  );
  if (candidates.length === 0) return false;

  for (const p of candidates) {
    p.evac = "requested";
    sq.casevacOrders.push(p.id);
  }
  return true;
}

/**
 * `[v7.3]` FTリーダー・一兵卒の座席(ロードマップ A-7)が動かす兵士。
 * FTの座席は「リーダー本人の兵士ID」で持つ(control.ts)。リーダーが倒れたら座席は空になる。
 */
function seatedFireteam(world: World, c: ControlState): { leader: Soldier; members: Soldier[] } | null {
  const leader = world.soldierById.get(c.unitId);
  if (!leader || leader.side !== c.side || leader.status !== "ok" || leader.fireteamId < 0) return null;
  const members = world.soldiers.filter(
    (s) =>
      s.side === leader.side &&
      s.squadId === leader.squadId &&
      s.fireteamId === leader.fireteamId &&
      s.status === "ok",
  );
  // リーダーを先頭に(隊列の先頭が目的地そのものへ向かう)
  members.sort((a, b) => (a.id === leader.id ? -1 : b.id === leader.id ? 1 : 0));
  return { leader, members };
}

/**
 * FTリーダーとして、自分のFTを「ここへ」動かす(`[v7.3]` A-7)。
 *
 * AIのFTリーダーが4名に出しているのと同じ兵士単位の `move` 命令を、同じ書き込み
 * (`commandSoldier`)で出す。リーダーが目的地へ、残りは進行方向に直交して1.6m間隔で
 * 横に並ぶ(AIの躍進の並びと同じ)。交戦は各員が自分の目で見た相手に自動で行う —
 * 狙いを個別に付けるのは一兵卒の直接操作(ロードマップ C-7)の範囲。
 * FTの任務目標も書き換えるので、座席を離れたあとAIはそこから引き継ぐ(仕様 §4)。
 */
function orderFireteamToImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "fireteam") return false;
  const team = seatedFireteam(world, c);
  if (!team) return false;
  const ft = world.fireteams.find(
    (f) => f.side === c.side && f.squadId === team.leader.squadId && f.ftIndex === team.leader.fireteamId,
  );
  if (ft) ft.objective = { ...target };
  const dx = target.x - team.leader.pos.x;
  const dz = target.z - team.leader.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  const dir = { x: dx / d, z: dz / d };
  const perp = { x: -dir.z, z: dir.x };
  const n = team.members.length;
  team.members.forEach((u, i) => {
    // 横並びの位置。0 番(リーダー)を中央に置くため、並び順を中央から左右へ振り分ける
    const k = i === 0 ? 0 : i % 2 === 1 ? Math.ceil(i / 2) : -Math.ceil(i / 2);
    const slot = n > 1 ? k * 1.6 : 0;
    commandSoldier(world, u, "move", { x: target.x + perp.x * slot, z: target.z + perp.z * slot }, dir);
  });
  return true;
}

/** 一兵卒として、自分の身体を「ここへ」動かす(`[v7.3]` A-7)。AIと同じ兵士単位の `move` */
function orderSoldierToImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "soldier") return false;
  const s = world.soldierById.get(c.unitId);
  if (!s || s.side !== c.side || s.status !== "ok") return false;
  const dx = target.x - s.pos.x;
  const dz = target.z - s.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  commandSoldier(world, s, "move", target, { x: dx / d, z: dz / d });
  return true;
}

/**
 * その場で止まって構える(`[v7.3]` A-7)。FTの座席なら4名全員、一兵卒なら本人。
 * `toward` を渡せばそちらを向いて警戒する(AIの `hold` と同じ命令)。
 */
function orderHoldImpl(
  world: World,
  toward: Vec2 | null,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c) return false;
  let men: Soldier[];
  if (c.echelon === "fireteam") {
    const team = seatedFireteam(world, c);
    if (!team) return false;
    men = team.members;
  } else if (c.echelon === "soldier") {
    const s = world.soldierById.get(c.unitId);
    if (!s || s.side !== c.side || s.status !== "ok") return false;
    men = [s];
  } else {
    return false;
  }
  for (const u of men) {
    let look = u.facing;
    if (toward) {
      const dx = toward.x - u.pos.x;
      const dz = toward.z - u.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) look = { x: dx / d, z: dz / d };
    }
    commandSoldier(world, u, "hold", null, look);
    u.path = [];
    u.pathIdx = 0;
  }
  return true;
}

/** 操作中の階層に応じて、目的地指示を適切な経路へ振り分ける。 */
function orderControlledToImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c) return false;
  if (c.echelon === "company") return orderCompanyTo(world, target, c);
  if (c.echelon === "platoon") return orderPlatoonTo(world, target, c);
  if (c.echelon === "squad") return orderSquadTo(world, target, c);
  if (c.echelon === "fireteam") return orderFireteamTo(world, target, c);
  if (c.echelon === "soldier") return orderSoldierTo(world, target, c);
  return false;
}

/**
 * 中隊長として、麾下の1個小隊へ任務(WHAT)を下ろす(`[v7.0]`)。
 *
 * AI中隊長(`c2/company.ts`)が毎周期やっているのと同じ書き込み — `platoonMissions` と
 * 小隊の `objective` / `mission`。任務の種別も AI と同じ3種(seize / support_by_fire /
 * screen)だけで、人間・LLM専用の命令は増やしていない(仕様 §4/§13)。
 */
function assignPlatoonMissionImpl(
  world: World,
  platoonId: number,
  mission: Mission,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "company") return false;
  const co = world.companies.find((x) => x.side === c.side && x.companyId === c.unitId);
  if (!co) return false;
  const pl = world.platoons.find(
    (p) => p.side === co.side && p.companyId === co.companyId && p.platoonId === platoonId,
  );
  if (!pl) return false;
  co.platoonObjectives.set(pl.platoonId, { ...mission.target });
  co.platoonMissions.set(pl.platoonId, { kind: mission.kind, target: { ...mission.target } });
  pl.objective = { ...mission.target };
  pl.mission = { kind: mission.kind, target: { ...mission.target } };
  return true;
}

/**
 * 小隊長として、麾下の1個分隊へ任務を下ろす(`[v7.0]`)。AI小隊長(`c2/platoon.ts`)と
 * 同じ書き込み — `squadObjectives` / `squadMissions` と分隊の `objective` / `mission`。
 */
function assignSquadMissionImpl(
  world: World,
  squadId: number,
  mission: Mission,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c || c.echelon !== "platoon") return false;
  const pl = world.platoons.find((p) => p.side === c.side && p.platoonId === c.unitId);
  if (!pl) return false;
  const sq = world.squads.find(
    (s) => s.side === pl.side && s.platoonId === pl.platoonId && s.squadId === squadId,
  );
  if (!sq) return false;
  pl.squadObjectives.set(sq.squadId, { ...mission.target });
  pl.squadMissions.set(sq.squadId, { kind: mission.kind, target: { ...mission.target } });
  sq.objective = { ...mission.target };
  sq.mission = { kind: mission.kind, target: { ...mission.target } };
  return true;
}

/**
 * 後援部隊を要請する(`[v7.0]` systems/reinforcement.ts)。
 *
 * 呼べるのは**陣営の最上位の指揮官の座席**だけ(中隊長、中隊が無ければ小隊長)。
 * AIの最上位指揮官が自動で呼ぶのと同じ関数を通るので、回数の上限・到着までの時間・
 * 指揮官不在なら呼べない、はすべて人間・LLM にも同じに掛かる(仕様 §4/§13)。
 */
function orderReinforcementImpl(
  world: World,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c) return false;
  const top = topCommandOf(world, c.side);
  if (!top || top.echelon !== c.echelon || top.unitId !== c.unitId) return false;
  return callReinforcement(world, c.side);
}

/**
 * 迫撃砲の射撃を要請する(`[v7.2]` ロードマップ S-5)。
 *
 * 要請できるのは**中隊長の座席**だけ(迫撃砲は中隊のC2資源、仕様 §10/§11)。
 * 通る関数はAIの中隊長と同じ `requestFireMission` なので、弾数・指揮所・要請間隔・
 * 射程・火力の統制線(危険近接)はすべて同じに掛かる(仕様 §4/§13)。
 *
 * AIとの違いは**どこを撃つかを自分で選ぶ**ことだけ。照準点は要請した時点で凍結され、
 * 飛翔時間のあいだに敵が動けば外れる — 人間の画面に出ている像もまた中隊長の像で
 * あって、敵の現在位置ではない(仕様 §5)。
 */
function orderFireMissionImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): FireMissionResult | null {
  const c = seat;
  if (!c || c.echelon !== "company") return null;
  const co = world.companies.find((x) => x.side === c.side && x.companyId === c.unitId);
  if (!co) return null;
  return requestFireMission(world, co, target);
}

/**
 * 発煙弾を焚く(`[v7.2]` ロードマップ S-2)。
 *
 * 焚けるのは**分隊長の座席**だけ(投げるのは分隊長本人)。AIの分隊長と同じ `throwSmoke` を
 * 通るので、残数・間隔・投げられる距離は同じに掛かる(仕様 §4/§13)。違いは「どこへ・いつ」を
 * 自分で選ぶことだけ。
 */
function orderSmokeImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): SmokeResult | null {
  const c = seat;
  if (!c || c.echelon !== "squad") return null;
  const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
  if (!sq) return null;
  return throwSmoke(world, sq, target);
}

/**
 * 対戦車・対構造物火器を撃たせる(`[v7.3]` ロードマップ A-3)。
 *
 * 撃たせられるのは**分隊長の座席**だけ(射手は分隊の1名)。AIの射手と同じ `fireAntiArmor` を
 * 通るので、弾数・間隔・射程・射線は同じに掛かる(仕様 §4/§13)。違うのは狙う点を自分で選ぶことだけ。
 */
function orderAntiArmorImpl(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): AntiArmorResult | null {
  const c = seat;
  if (!c || c.echelon !== "squad") return null;
  const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
  if (!sq) return null;
  return fireAntiArmor(world, sq, target);
}

// ─────────────────────────────────────────────────────────────────────────────
// `[v7.2]` 命令の記録(ロードマップ S-4 振り返り・リプレイ)
//
// 上の命令はすべてここの薄い包みを通して公開する。`world.log` が有効なら、実際に
// 呼ばれた命令を「どのティックに・どの座席から・どの引数で」記録する。シムは決定論的
// (ロードマップ P3)なので、初期条件コード + この記録だけで同じ戦闘を最初から再生できる。
// 包みの中で別の命令を呼ぶ(orderControlledTo → orderCompanyTo)ときは、外側の1件
// だけを記録する — 再生で外側を呼べば内側も同じに呼ばれる。
// ─────────────────────────────────────────────────────────────────────────────

let depth = 0;

function recorded<T>(world: World, fn: OrderFn, seat: ControlState | null, args: unknown[], run: () => T): T {
  if (world.log && depth === 0) {
    world.log.push({
      tick: world.tick,
      kind: "order",
      fn,
      seat: seat ? { ...seat } : null,
      args: JSON.parse(JSON.stringify(args)) as unknown[],
    });
  }
  depth++;
  try {
    return run();
  } finally {
    depth--;
  }
}

export function orderSquadTo(world: World, target: Vec2, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderSquadTo", seat, [target], () => orderSquadToImpl(world, target, seat));
}
export function orderPlatoonTo(world: World, target: Vec2, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderPlatoonTo", seat, [target], () => orderPlatoonToImpl(world, target, seat));
}
export function orderCompanyTo(world: World, target: Vec2, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderCompanyTo", seat, [target], () => orderCompanyToImpl(world, target, seat));
}
export function orderFireteamTo(world: World, target: Vec2, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderFireteamTo", seat, [target], () => orderFireteamToImpl(world, target, seat));
}
export function orderSoldierTo(world: World, target: Vec2, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderSoldierTo", seat, [target], () => orderSoldierToImpl(world, target, seat));
}
export function orderHold(world: World, toward: Vec2 | null = null, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderHold", seat, [toward], () => orderHoldImpl(world, toward, seat));
}
export function orderCasevac(
  world: World,
  patientId?: number,
  seat: ControlState | null = world.control,
): boolean {
  return recorded(world, "orderCasevac", seat, [patientId ?? null], () =>
    orderCasevacImpl(world, patientId, seat),
  );
}
export function orderControlledTo(world: World, target: Vec2, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderControlledTo", seat, [target], () => orderControlledToImpl(world, target, seat));
}
export function assignPlatoonMission(
  world: World,
  platoonId: number,
  mission: Mission,
  seat: ControlState | null = world.control,
): boolean {
  return recorded(world, "assignPlatoonMission", seat, [platoonId, mission], () =>
    assignPlatoonMissionImpl(world, platoonId, mission, seat),
  );
}
export function assignSquadMission(
  world: World,
  squadId: number,
  mission: Mission,
  seat: ControlState | null = world.control,
): boolean {
  return recorded(world, "assignSquadMission", seat, [squadId, mission], () =>
    assignSquadMissionImpl(world, squadId, mission, seat),
  );
}
export function orderReinforcement(world: World, seat: ControlState | null = world.control): boolean {
  return recorded(world, "orderReinforcement", seat, [], () => orderReinforcementImpl(world, seat));
}
export function orderFireMission(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): FireMissionResult | null {
  return recorded(world, "orderFireMission", seat, [target], () => orderFireMissionImpl(world, target, seat));
}
export function orderSmoke(world: World, target: Vec2, seat: ControlState | null = world.control): SmokeResult | null {
  return recorded(world, "orderSmoke", seat, [target], () => orderSmokeImpl(world, target, seat));
}

export function orderAntiArmor(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): AntiArmorResult | null {
  return recorded(world, "orderAntiArmor", seat, [target], () => orderAntiArmorImpl(world, target, seat));
}

/** 記録された命令を同じ引数でもう一度出す(再生用。`world.log` が null なら記録はしない) */
export function replayOrder(world: World, fn: OrderFn, seat: ControlState | null, args: unknown[]): void {
  const v = (i: number) => args[i] as Vec2;
  switch (fn) {
    case "orderSquadTo":
      orderSquadTo(world, v(0), seat);
      return;
    case "orderPlatoonTo":
      orderPlatoonTo(world, v(0), seat);
      return;
    case "orderCompanyTo":
      orderCompanyTo(world, v(0), seat);
      return;
    case "orderFireteamTo":
      orderFireteamTo(world, v(0), seat);
      return;
    case "orderSoldierTo":
      orderSoldierTo(world, v(0), seat);
      return;
    case "orderHold":
      orderHold(world, (args[0] as Vec2 | null) ?? null, seat);
      return;
    case "orderCasevac":
      orderCasevac(world, (args[0] as number | null) ?? undefined, seat);
      return;
    case "orderControlledTo":
      orderControlledTo(world, v(0), seat);
      return;
    case "assignPlatoonMission":
      assignPlatoonMission(world, args[0] as number, args[1] as Mission, seat);
      return;
    case "assignSquadMission":
      assignSquadMission(world, args[0] as number, args[1] as Mission, seat);
      return;
    case "orderReinforcement":
      orderReinforcement(world, seat);
      return;
    case "orderFireMission":
      orderFireMission(world, v(0), seat);
      return;
    case "orderSmoke":
      orderSmoke(world, v(0), seat);
      return;
    case "orderAntiArmor":
      orderAntiArmor(world, v(0), seat);
      return;
  }
}
