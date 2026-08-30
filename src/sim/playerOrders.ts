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
import type { Vec2 } from "./types.ts";
import type { World } from "./world.ts";

/** 操作中の分隊へ「ここへ移動せよ」と指示する(分隊長として)。 */
export function orderSquadTo(world: World, target: Vec2): boolean {
  const c = world.control;
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
export function orderPlatoonTo(world: World, target: Vec2): boolean {
  const c = world.control;
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
export function orderCompanyTo(world: World, target: Vec2): boolean {
  const c = world.control;
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
export function orderCasevac(world: World, patientId?: number): boolean {
  const c = world.control;
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
export function orderControlledTo(world: World, target: Vec2): boolean {
  const c = world.control;
  if (!c) return false;
  if (c.echelon === "company") return orderCompanyTo(world, target);
  if (c.echelon === "platoon") return orderPlatoonTo(world, target);
  if (c.echelon === "squad") return orderSquadTo(world, target);
  return false;
}
