/**
 * 戦闘後の振り返り(AAR、`[v7.2]` ロードマップ S-4)。
 *
 * 見せたいのは仕様 §5 の情報の階層そのもの: **各指揮官がそのとき信じていた敵の位置**と、
 * **実際の敵の位置**を同じ時刻で並べる。分隊長(麾下の目の合算)→ 小隊長(無線1ホップ)
 * → 中隊長(2ホップ)と上がるほど、像が古く粗くなることが、ずれの大きさで見える。
 *
 * ここは**読むだけ**で、シムには一切書き込まない。一定間隔で盤面の要約(フレーム)を取り、
 * 画面がそれを時刻スライダーで見せる。記録と再生(replay.ts)で同じ戦闘を作り直せるので、
 * フレームも同じものが取れる。
 */

import { isOffField } from "./systems/litter.ts";
import { SIM_HZ } from "./constants.ts";
import type { Contact, Side, Vec2 } from "./types.ts";
import type { World } from "./world.ts";

/** フレームを取る間隔 s */
export const AAR_EVERY_SEC = 2;

export interface AarContact {
  pos: Vec2;
  posError: number;
  confidence: number;
  /** 最後に見てからの秒数 */
  ageSec: number;
  /** いちばん近い実際の敵までの距離 m(像のずれ)。敵が残っていなければ null */
  miss: number | null;
}

export interface AarBelief {
  side: Side;
  echelon: "company" | "platoon" | "squad";
  unitId: number;
  name: string;
  contacts: AarContact[];
}

export interface AarFrame {
  tick: number;
  /** 実際の兵士(戦場に残っている者だけ) */
  truth: { id: number; side: Side; pos: Vec2; down: boolean }[];
  beliefs: AarBelief[];
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function contactsOf(
  world: World,
  belief: Map<string, Contact>,
  enemies: readonly Vec2[],
): AarContact[] {
  const out: AarContact[] = [];
  for (const c of belief.values()) {
    if (c.confidence <= 0) continue;
    let miss: number | null = null;
    for (const e of enemies) {
      const d = dist(c.pos, e);
      if (miss === null || d < miss) miss = d;
    }
    out.push({
      pos: { x: c.pos.x, z: c.pos.z },
      posError: c.posError,
      confidence: c.confidence,
      ageSec: (world.tick - c.lastSeenTick) / SIM_HZ,
      miss,
    });
  }
  return out;
}

/** いまの盤面の要約を1枚取る */
export function captureAarFrame(world: World): AarFrame {
  const truth = world.soldiers
    .filter((s) => s.status !== "kia" && !isOffField(s))
    .map((s) => ({ id: s.id, side: s.side, pos: { x: s.pos.x, z: s.pos.z }, down: s.status !== "ok" }));
  const enemiesOf = (side: Side): Vec2[] =>
    truth.filter((t) => t.side !== side && !t.down).map((t) => t.pos);
  const enemies = { blue: enemiesOf("blue"), red: enemiesOf("red") };

  const beliefs: AarBelief[] = [];
  for (const co of world.companies) {
    beliefs.push({
      side: co.side,
      echelon: "company",
      unitId: co.companyId,
      name: "中隊長",
      contacts: contactsOf(world, co.belief, enemies[co.side]),
    });
  }
  for (const pl of world.platoons) {
    beliefs.push({
      side: pl.side,
      echelon: "platoon",
      unitId: pl.platoonId,
      name: `${(pl.platoonId % 100) + 1}小隊長`,
      contacts: contactsOf(world, pl.belief, enemies[pl.side]),
    });
  }
  for (const sq of world.squads) {
    beliefs.push({
      side: sq.side,
      echelon: "squad",
      unitId: sq.squadId,
      name: `${(sq.squadId % 100) + 1}分隊長`,
      contacts: contactsOf(world, sq.belief, enemies[sq.side]),
    });
  }
  return { tick: world.tick, truth, beliefs };
}

/** その時刻を取るべきか(戦闘中、`AAR_EVERY_SEC` ごと) */
export function aarDue(world: World): boolean {
  return world.phase === "battle" && world.tick % Math.round(AAR_EVERY_SEC * SIM_HZ) === 0;
}

/**
 * 階層ごとの像のずれ(フレーム1枚ぶん)。中隊長・小隊長・分隊長それぞれについて、
 * 持っている接触の「いちばん近い実際の敵までの距離」の平均 m と、接触の数。
 * 確度で重みをつける(消えかけの像は軽く数える)。
 */
export function aarMissByEchelon(
  frame: AarFrame,
  side: Side,
): Record<AarBelief["echelon"], { miss: number | null; contacts: number }> {
  const out = {} as Record<AarBelief["echelon"], { miss: number | null; contacts: number }>;
  for (const e of ["company", "platoon", "squad"] as const) {
    let w = 0;
    let sum = 0;
    let n = 0;
    for (const b of frame.beliefs) {
      if (b.side !== side || b.echelon !== e) continue;
      for (const c of b.contacts) {
        n++;
        if (c.miss === null) continue;
        w += c.confidence;
        sum += c.miss * c.confidence;
      }
    }
    out[e] = { miss: w > 0 ? sum / w : null, contacts: n };
  }
  return out;
}
