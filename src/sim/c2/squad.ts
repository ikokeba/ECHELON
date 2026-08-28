/**
 * 分隊長AI(仕様 §3 ③ — FSWのコア層)。
 *
 * 現在の実装範囲: 分隊長自身の身体のみ。隷下2個FTの視界の合算(仕様 §5)を持ち、
 * 突撃の先頭に立つのではなく指揮を執れる位置 — 先頭FTの後方で脅威方向を向いた位置 —
 * に自らを置く。接敵時は遮蔽をとって観測し、ベース・オブ・ファイアには加わらない。
 *
 * **未実装**(次スライス): 分隊長が隷下FTを**指揮する**部分 —
 * 移動技術の選択(仕様 §6 前進/警戒前進/躍進前進)と、FT間へのベース・オブ・ファイア/
 * 機動役の割り当て。現状はこれを各FTが c2/fireteam.ts 内で自分で決めている。
 */

import { SIM_HZ } from "../constants.ts";
import type { Soldier, Vec2 } from "../types.ts";
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

export function squadAI(world: World): void {
  if (world.tick % DECIDE_EVERY_TICKS !== 0) return;

  for (const sl of world.soldiers) {
    if (!sl.isSquadLeader || sl.status !== "ok") continue;

    const squad = world.soldiers.filter(
      (s) => s.side === sl.side && s.squadId === sl.squadId && s.fireteamId >= 0 && s.status === "ok",
    );
    if (squad.length === 0) continue;

    // 分隊長の world picture: 隷下FTの視界の合算(仕様 §5)
    const fireteams = world.fireteams.filter(
      (f) => f.side === sl.side && f.squadId === sl.squadId,
    );
    let threat: Vec2 | null = null;
    let bestConfidence = 0;
    for (const ft of fireteams) {
      for (const c of ft.memory.values()) {
        if (c.confidence > bestConfidence) {
          bestConfidence = c.confidence;
          threat = c.pos;
        }
      }
    }

    const mc = centroid(squad);
    const forward = threat ? dirTo(mc, threat) : { ...sl.facing };
    // 脅威の軸線上で、分隊の先端から後退した位置に構える
    const post: Vec2 = { x: mc.x - forward.x * TRAIL_DIST, z: mc.z - forward.z * TRAIL_DIST };
    const look = threat ? dirTo(sl.pos, threat) : forward;

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
