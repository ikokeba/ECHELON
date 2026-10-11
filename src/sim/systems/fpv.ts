/**
 * 自爆ドローン(FPV)・徘徊型弾薬(`[v7.7]` ロードマップ B-2、設計メモ §6.3)。
 *
 * **迫撃砲と同じく「自分の像へ撃つ」**(ロードマップ P1)。中隊長は自分の像(無線で遅れて上がった
 * 接触)から飛ばし先を選ぶ。違いは終末で、FPV は目標点のまわりを**自分のカメラで**探し、上から
 * 見えた敵を捉えて突っ込む。だから迫撃砲よりずっと正確だが、次の対抗手段がそのまま効く:
 *
 *   - **屋内に入れば安全**。カメラは屋根の下(建物の中)と煙の中を見られない(観測ドローンと同じ
 *     `visibleFromAbove`)。突入中に標的が建物へ入れば見失う。迫撃砲の屋内の扱い(`[v7.4]`)と揃えた
 *   - **見つけて隠れる**。地上の兵士は FPV も観測ドローンと同じく目と羽音で見つけ(S-6)、分隊は
 *     建物へ入る・伏せる・煙を焚く(S-7)。止まっている・伏せている者は見つけるのに数秒かかる(A-9)
 *   - **撃ち落とす**。小銃・対ドローン装備で撃てる(A-10)。速くて小さいので確率は `FPV.SHOOT_MUL` 倍
 *   - **操縦手を叩く**。操縦手(中隊本部の副中隊長)が倒れれば、飛んでいる機体も残りの機体も失われる
 *
 * 機体は1班に `FPV.AIRFRAMES` 機。1機飛ばすごとに1機減り(当たっても外れても撃ち落とされても)、
 * 次の機体は `FPV.PREP_SEC` 秒で準備できる。乱数は飛ばした側の陣営の乱数列から引く(P3)。
 * 陣営で分岐しない(P2)。飛ばすのは AI の中隊長・人間・LLM とも `launchFpv` を通る(P4)。
 */

import { FPV, HEARING, SIM_HZ } from "../constants.ts";
import { chance } from "../rng.ts";
import { buildingAt, insideBounds } from "../cqb.ts";
import { isOffField } from "./litter.ts";
import { spots, visibleFromAbove } from "./drone.ts";
import { SUPPRESSION_GRACE_TICKS } from "../constants.ts";
import type { CompanyState, Contact, Drone, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const STEP = FPV.SPEED / SIM_HZ;
const DIVE_STEP = FPV.DIVE_SPEED / SIM_HZ;
const ENDURANCE_TICKS = Math.round(FPV.ENDURANCE_SEC * SIM_HZ);
const PREP_TICKS = Math.round(FPV.PREP_SEC * SIM_HZ);
const AI_INTERVAL_TICKS = Math.round(FPV.AI_INTERVAL_SEC * SIM_HZ);
/** 爆発の制圧を残すティック(迫撃砲の1発と同じ程度) */
const SUPPRESS_TICKS = Math.round(1.5 * SIM_HZ) + SUPPRESSION_GRACE_TICKS;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function isFpv(d: Drone): boolean {
  return d.kind === "fpv";
}

/** その中隊の FPV の班(操縦手1名につき1つ) */
export function fpvsOf(world: World, co: CompanyState): Drone[] {
  return world.drones.filter((d) => isFpv(d) && d.side === co.side && d.companyId === co.companyId);
}

function operatorOf(world: World, d: Drone): Soldier | null {
  const s = world.soldierById.get(d.operatorId);
  return s && s.status === "ok" && !isOffField(s) ? s : null;
}

function setState(world: World, d: Drone, state: Drone["state"]): void {
  d.state = state;
  d.stateTick = world.tick;
}

function moveToward(d: Drone, to: Vec2, step: number): boolean {
  const r = dist(d.pos, to);
  if (r <= step) {
    d.pos = { ...to };
    return true;
  }
  d.pos = { x: d.pos.x + ((to.x - d.pos.x) / r) * step, z: d.pos.z + ((to.z - d.pos.z) / r) * step };
  return false;
}

/** 1機の飛行が終わった(起爆・燃料切れ・撃墜)。次の機体があれば準備に入る */
function endSortie(world: World, d: Drone, op: Soldier | null): void {
  d.batteriesLeft = Math.max(0, d.batteriesLeft - 1);
  d.target = null;
  d.lockId = null;
  d.flightTicksLeft = ENDURANCE_TICKS;
  if (op) d.pos = { ...op.pos };
  setState(world, d, d.batteriesLeft > 0 && op ? "swapping" : d.batteriesLeft > 0 ? "lost" : "spent");
}

/** 標的になり得るか: 敵で、戦えて(負傷者は撃たない `[v7.4]`)、上から見える */
function targetable(world: World, d: Drone, s: Soldier): boolean {
  return s.side !== d.side && s.status === "ok" && !isOffField(s) && visibleFromAbove(world, s);
}

/**
 * 起爆。**損害は敵にだけ、制圧は敵味方とも**(迫撃砲 `resolveImpact` と同じ、仕様 §8.2/§8.6)。
 * 捉えていた標的は `KILL_CHANCE`、殺傷半径の中のほかの敵は `SPLASH_CHANCE`(屋内なら迫撃砲と同じく
 * ほぼ届かない)。爆発音は銃声と同じく音による察知(A-5)に乗る
 */
function detonate(world: World, d: Drone, lockedId: number | null): number {
  const rng = world.rngBySide[d.side];
  const at = { x: d.pos.x, z: d.pos.z };
  let victims = 0;
  for (const s of world.soldiers) {
    if (s.status !== "ok" || isOffField(s)) continue;
    const r = dist(s.pos, at);
    if (r > FPV.SUPPRESS_RADIUS) continue;
    s.suppressedUntilTick = Math.max(s.suppressedUntilTick, world.tick + SUPPRESS_TICKS);
    if (s.side === d.side) continue;
    const p =
      s.id === lockedId
        ? FPV.KILL_CHANCE
        : r <= FPV.BLAST_RADIUS
          ? buildingAt(world.buildings, s.pos)
            ? FPV.SPLASH_CHANCE * 0.15
            : FPV.SPLASH_CHANCE
          : 0;
    if (p > 0 && chance(rng, p)) {
      s.status = "wia";
      s.stabilized = false;
      s.bleedOutTick = 0;
      victims++;
    }
  }
  world.fx.push({ kind: "fpv", at, side: d.side, radius: FPV.BLAST_RADIUS, victims });
  world.gunshots.push({ sourceId: d.operatorId, side: d.side, pos: at, range: HEARING.RANGE.grenade });
  return victims;
}

/** 目標点のまわりで、カメラに映った敵を1人捉える(近い順、同じ距離なら通し番号の順) */
function seek(world: World, d: Drone): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const s of world.soldiers) {
    const r = dist(s.pos, d.pos);
    if (r > FPV.SEEK_RADIUS || !targetable(world, d, s)) continue;
    if (r > bestD + 1e-9 || (Math.abs(r - bestD) <= 1e-9 && best && s.ordinal >= best.ordinal)) continue;
    // 止まっている者・伏せている者は、見つけるのに数秒かかる(A-9 と同じ確率)
    if (!spots(world, d, s, undefined)) continue;
    best = s;
    bestD = r;
  }
  return best;
}

/** 毎ティック: FPV の飛行・標的の捜索・突入・起爆。観測ドローンのあと、地上の探知の前に呼ぶ */
export function fpvSystem(world: World): void {
  for (const d of world.drones) {
    if (!isFpv(d) || d.state === "spent") continue;
    const op = operatorOf(world, d);
    if (d.state === "lost") {
      // 撃ち落とされた(A-10)のは飛んでいた1機だけ。操縦手が無事なら次の機体へ
      if (d.shotDown && op && d.batteriesLeft > 0) {
        d.shotDown = false;
        endSortie(world, d, op);
      }
      continue;
    }
    if (!op) {
      // 操縦手が倒れた。飛んでいる機体は制御を失って落ち、残りの機体も飛ばせる者がいない
      setState(world, d, "lost");
      d.target = null;
      d.lockId = null;
      continue;
    }
    if (d.state === "ready" || d.state === "swapping") {
      d.pos = { ...op.pos };
      if (d.state === "swapping" && world.tick - d.stateTick >= PREP_TICKS) setState(world, d, "ready");
      continue;
    }
    // 飛んでいる
    d.flightTicksLeft--;
    if (d.lockId != null) {
      const t = world.soldierById.get(d.lockId);
      if (!t || !targetable(world, d, t)) {
        // 標的が屋内・煙の中へ入った、倒れた — 見失った。まわりを探し直す
        d.lockId = null;
      } else if (moveToward(d, t.pos, DIVE_STEP) || dist(d.pos, t.pos) <= FPV.HIT_DIST) {
        detonate(world, d, t.id);
        endSortie(world, d, op);
        continue;
      }
    }
    if (d.lockId == null) {
      if (d.target && !moveToward(d, d.target, STEP) && dist(d.pos, d.target) > FPV.SEEK_RADIUS) {
        // まだ目標点へ向かっている途中
      } else {
        const t = seek(world, d);
        if (t) d.lockId = t.id;
      }
    }
    if (d.flightTicksLeft <= 0) {
      // 燃料(電池)切れ。標的を見つけられないまま落ちる — 何も起きない
      endSortie(world, d, op);
    }
  }
}

/**
 * 飛ばせない理由。人間・LLM へそのまま返す。
 *   no_fpv       : この中隊は自爆ドローンを持たない
 *   none_ready   : 飛ばせる機体が無い(飛行中・準備中)
 *   spent        : 機体を使い切った
 *   lost         : 操縦手が倒れた
 *   out_of_range : どの操縦手からも `FPV.MAX_RANGE` より遠い
 */
export type FpvBlock = "no_fpv" | "none_ready" | "spent" | "lost" | "out_of_range";

export const FPV_BLOCK_TEXT: Record<FpvBlock, string> = {
  no_fpv: "この中隊は自爆ドローンを持たない",
  none_ready: "飛ばせる機体が無い(飛行中か、次の機体を準備中)",
  spent: "機体を使い切った",
  lost: "操縦手が倒れた",
  out_of_range: `遠すぎる(操縦手から ${FPV.MAX_RANGE}m 以内)`,
};

export type FpvResult = { ok: true; droneId: number } | { ok: false; reason: FpvBlock };

/**
 * 地点へ FPV を1機飛ばす(AI・人間・LLM 共通、P4)。地点は飛ばす者の像から選ぶ — FPV は
 * そこへ飛び、まわりで上から見えた敵を自分で捉える。手元にある機体のうち、操縦手が地点に
 * 最も近いものを飛ばす
 */
export function launchFpv(world: World, co: CompanyState, target: Vec2): FpvResult {
  const teams = fpvsOf(world, co);
  if (teams.length === 0) return { ok: false, reason: "no_fpv" };
  const alive = teams.filter((d) => d.state !== "lost" && operatorOf(world, d));
  if (alive.length === 0) return { ok: false, reason: "lost" };
  if (alive.every((d) => d.state === "spent")) return { ok: false, reason: "spent" };
  const ready = alive.filter((d) => d.state === "ready");
  if (ready.length === 0) return { ok: false, reason: "none_ready" };
  let pick: Drone | null = null;
  let pickD = Infinity;
  for (const d of ready) {
    const r = dist(operatorOf(world, d)!.pos, target);
    if (r <= FPV.MAX_RANGE && r < pickD - 1e-9) {
      pick = d;
      pickD = r;
    }
  }
  if (!pick) return { ok: false, reason: "out_of_range" };
  const b = world.bounds;
  pick.target = {
    x: Math.min(b.maxX, Math.max(b.minX, target.x)),
    z: Math.min(b.maxZ, Math.max(b.minZ, target.z)),
  };
  pick.lockId = null;
  pick.flightTicksLeft = ENDURANCE_TICKS;
  pick.pos = { ...operatorOf(world, pick)!.pos };
  setState(world, pick, "flying");
  co.lastFpvTick = world.tick;
  return { ok: true, droneId: pick.id };
}

/**
 * AI の中隊長の判断(`[v7.7]`)。材料は中隊長の像だけ(P1):
 *   - 確度 `AI_MIN_CONFIDENCE` 以上の**見た**接触(聞いただけのものは使わない)のうち、
 *   - 建物の外にある(FPV は屋根の下を見られない — 地形の知識なので像に依らない)、
 *   - 飛んでいる FPV の目標から離れている、
 *   - いちばん多くの接触が近くに固まっているもの(同数なら確度、それも同じなら新しく見たもの)
 * 前に飛ばしてから `AI_INTERVAL_SEC` 秒は待つ(機体を一度に使い切らない)
 */
export function aiFpv(world: World, co: CompanyState): void {
  const teams = fpvsOf(world, co);
  if (!teams.some((d) => d.state === "ready")) return;
  if (world.tick - (co.lastFpvTick ?? -1_000_000) < AI_INTERVAL_TICKS) return;
  const flying = teams.filter((d) => d.state === "flying" && d.target).map((d) => d.target!);
  const firm = [...co.belief.values()].filter(
    (c) => !c.heard && c.confidence >= FPV.AI_MIN_CONFIDENCE,
  );
  let best: Contact | null = null;
  let bestN = 0;
  for (const c of firm) {
    if (world.buildings.some((b) => insideBounds(b.bounds, c.pos))) continue;
    if (flying.some((f) => dist(f, c.pos) < FPV.AI_SPREAD)) continue;
    const n = firm.filter((o) => dist(o.pos, c.pos) <= FPV.SEEK_RADIUS).length;
    if (
      !best ||
      n > bestN ||
      (n === bestN && c.confidence > best.confidence + 1e-9) ||
      (n === bestN &&
        Math.abs(c.confidence - best.confidence) <= 1e-9 &&
        c.lastSeenTick > best.lastSeenTick)
    ) {
      best = c;
      bestN = n;
    }
  }
  if (best) launchFpv(world, co, best.pos);
}
