/**
 * 分隊長AI(仕様 §3 ③ — FSWのコア層)。
 *
 * 情報の立ち位置(仕様 §5): 分隊長は麾下2個FTの視界の**合算**を直接得る。
 * 無線を介さずに生の視界を得られるのはこの階層までで、小隊長より上は報告のみになる。
 * belief の構築自体は radio.ts が行い、ここではそれを読んで判断する。
 *
 * やること:
 *   - 小隊長から受けた任務目標と移動技術を、麾下FTへ翻訳して渡す(下向きの情報流)
 *   - 接敵時、2個FTへベース・オブ・ファイア役と機動役を割り当てる(仕様 §6)
 *   - 分隊長自身の位置取り(指揮を執れる位置に留まり、突撃の先頭には立たない)
 */

import { SIM_HZ } from "../constants.ts";
import type { Contact, Soldier, SquadState, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/** 分隊の先端から分隊長が後方に位置する距離 m。 */
const TRAIL_DIST = 4;
/** 意思決定周期。毎ティックではない。 */
const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);
/** 現在の目的地からこの距離以内なら再発行しない m。 */
const DEST_EPS = 1.2;

function centroid(units: readonly Soldier[]): Vec2 {
  if (units.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const u of units) {
    x += u.pos.x;
    z += u.pos.z;
  }
  return { x: x / units.length, z: z / units.length };
}

function dirTo(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
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
 * 分隊長が麾下FTへ意図を下ろす。
 *
 * 移動技術は小隊長の指示をそのまま流す。接敵時のベース・オブ・ファイア/機動役の
 * 割り当ては分隊長の裁量(仕様 §6 Fire and Movement の実行判断は分隊長の責務)。
 */
function directFireteams(world: World, sq: SquadState): void {
  const fireteams = world.fireteams.filter(
    (f) => f.side === sq.side && f.squadId === sq.squadId,
  );
  if (fireteams.length === 0) return;

  // 各FTの生存者数を数え、全滅したFTには役割を割り当てない
  const strength = new Map<number, number>();
  for (const ft of fireteams) {
    strength.set(
      ft.ftIndex,
      world.soldiers.filter(
        (s) =>
          s.side === ft.side &&
          s.squadId === ft.squadId &&
          s.fireteamId === ft.ftIndex &&
          s.status === "ok",
      ).length,
    );
  }

  const threat = primaryThreat(sq.belief);

  for (const ft of fireteams) {
    // 任務目標と移動技術は上から下へそのまま伝播する
    ft.objective = { ...sq.objective };
    ft.technique = sq.technique;
    ft.assignedRole = null;
  }

  if (!threat) return;

  // 接敵時: 敵に近い側のFTをベース・オブ・ファイア、もう一方を機動役にする。
  // 近い側が既に射撃位置についている可能性が高く、遠い側のほうが回り込む余地があるため。
  const alive = fireteams.filter((ft) => (strength.get(ft.ftIndex) ?? 0) > 0);
  if (alive.length < 2) {
    // 1個FTしか残っていない分隊では、FT間で火力と機動を分けられない。
    // 役割を割り当てず null のままにし、FT内部の2バディペアで自律的に
    // Fire and Movement をさせる(assignedRole が null のときのFT側の分岐)。
    // ここで "base" を割り当ててしまうと、残存FT全員が制圧に張り付いたまま
    // 誰も前進しなくなり、両軍が睨み合ったまま永久に膠着する。
    return;
  }

  const withDist = alive.map((ft) => {
    const members = world.soldiers.filter(
      (s) =>
        s.side === ft.side &&
        s.squadId === ft.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.status === "ok",
    );
    const c = centroid(members);
    return { ft, d: Math.hypot(c.x - threat.pos.x, c.z - threat.pos.z) };
  });
  withDist.sort((a, b) => a.d - b.d);
  withDist[0]!.ft.assignedRole = "base";
  for (let i = 1; i < withDist.length; i++) withDist[i]!.ft.assignedRole = "maneuver";
}

export function squadAI(world: World): void {
  if (world.tick % DECIDE_EVERY_TICKS !== 0) return;

  for (const sq of world.squads) {
    directFireteams(world, sq);
  }

  // ── 分隊長自身の位置取り ──
  for (const sl of world.soldiers) {
    if (!sl.isSquadLeader || sl.status !== "ok") continue;

    const squad = world.soldiers.filter(
      (s) =>
        s.side === sl.side && s.squadId === sl.squadId && s.fireteamId >= 0 && s.status === "ok",
    );
    if (squad.length === 0) continue;

    const sq = world.squads.find((s) => s.side === sl.side && s.squadId === sl.squadId);
    const threat = sq ? primaryThreat(sq.belief) : null;

    const mc = centroid(squad);
    const forward = threat ? dirTo(mc, threat.pos) : { ...sl.facing };
    // 脅威の軸線上で、分隊の先端から後退した位置に構える
    const post: Vec2 = { x: mc.x - forward.x * TRAIL_DIST, z: mc.z - forward.z * TRAIL_DIST };
    const look = threat ? dirTo(sl.pos, threat.pos) : forward;

    const arrived = Math.hypot(sl.pos.x - post.x, sl.pos.z - post.z) < DEST_EPS;
    if (arrived) {
      sl.order = { kind: "hold", facing: { ...look }, issuedTick: world.tick };
      sl.path = [];
      sl.pathIdx = 0;
      continue;
    }

    const prev = sl.order.target;
    const sameDest = prev && Math.hypot(prev.x - post.x, prev.z - post.z) < DEST_EPS;
    sl.order = {
      kind: "move",
      target: { ...post },
      facing: { ...look },
      issuedTick: world.tick,
    };
    if (!sameDest) {
      sl.path = [];
      sl.pathIdx = 0;
    }
  }
}
