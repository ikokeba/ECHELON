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
import { callReinforcement, topCommandOf } from "./systems/reinforcement.ts";
import { requestFireMission, type FireMissionResult } from "./systems/indirect.ts";
import { throwSmoke, type SmokeResult } from "./systems/smoke.ts";

/*
 * `[v7.0]` どの命令も**座席**(`seat`)を引数に取る。既定は人間の操作枠
 * (`world.control`)で、外部エージェント(LLM、src/llm/)は自分の座席を渡す。
 * 命令の中身と適用経路は人間と完全に同じ — 座席が違うだけ(仕様 §4)。
 */

/** 操作中の分隊へ「ここへ移動せよ」と指示する(分隊長として)。 */
export function orderSquadTo(
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
export function orderPlatoonTo(
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
export function orderCompanyTo(
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
export function orderCasevac(
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

/** 操作中の階層に応じて、目的地指示を適切な経路へ振り分ける。 */
export function orderControlledTo(
  world: World,
  target: Vec2,
  seat: ControlState | null = world.control,
): boolean {
  const c = seat;
  if (!c) return false;
  if (c.echelon === "company") return orderCompanyTo(world, target, c);
  if (c.echelon === "platoon") return orderPlatoonTo(world, target, c);
  if (c.echelon === "squad") return orderSquadTo(world, target, c);
  return false;
}

/**
 * 中隊長として、麾下の1個小隊へ任務(WHAT)を下ろす(`[v7.0]`)。
 *
 * AI中隊長(`c2/company.ts`)が毎周期やっているのと同じ書き込み — `platoonMissions` と
 * 小隊の `objective` / `mission`。任務の種別も AI と同じ3種(seize / support_by_fire /
 * screen)だけで、人間・LLM専用の命令は増やしていない(仕様 §4/§13)。
 */
export function assignPlatoonMission(
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
export function assignSquadMission(
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
export function orderReinforcement(
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
export function orderFireMission(
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
export function orderSmoke(
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
