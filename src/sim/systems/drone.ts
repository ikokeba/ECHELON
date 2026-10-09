/**
 * 観測ドローン班(`[v7.3]` ロードマップ A-2、設計メモ §6.1)。
 *
 * **ドローンは「見る主体」であって「全体像を配る装置」ではない。** 俯瞰の生映像を中隊長に
 * 与えると、情報の階層(仕様 §5)がその場で崩れる。だから:
 *
 *   - 見たものは**操縦手の記憶**(`Drone.belief`)に入るだけ。そこから先は分隊長と同じく
 *     無線の定時報告(と臨時報告)で中隊長へ上がる — 遅延・粒度の低下・確度の減衰つき
 *     (radio.ts)。中隊長の像だけが新しくなり、末端(小隊・分隊)の像は古いまま
 *   - 上から見るので壁に遮られないが、見えるのは**真下の狭い範囲**(半径 `VIEW_RADIUS`)だけ。
 *     屋根の下(建物の中)と煙の中は見えない
 *   - 飛べる時間は電池で決まる。電池が尽きる前に操縦手の元へ戻り、替えてまた飛ぶ
 *   - 操縦手は兵士なので撃たれる。倒れればドローンは落ちる。選抜射手と同じく優先目標
 *     (c2/fireControl.ts)
 *
 * 飛ばし先を決めるのは中隊長。AI の中隊長(`aiDrone`)・人間・LLM はすべて `taskDrone` を通る
 * (ロードマップ P4)。乱数は引かない(P3)、陣営で分岐しない(P2)。
 */

import { DRONE, SIM_HZ } from "../constants.ts";
import { insideBounds } from "../cqb.ts";
import { isOffField } from "./litter.ts";
import { smokeRadius } from "./smoke.ts";
import { newFlashWatch } from "../world.ts";
import type { CompanyState, Contact, Drone, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const STEP = DRONE.SPEED / SIM_HZ;
const ENDURANCE_TICKS = Math.round(DRONE.ENDURANCE_SEC * SIM_HZ);
const SWAP_TICKS = Math.round(DRONE.SWAP_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 編成から作る(操縦手の資格を持つ兵士1名につき1機)。世界を作るときに呼ぶ */
export function buildDrones(soldiers: readonly Soldier[]): Drone[] {
  let id = 1;
  return soldiers
    .filter((s) => s.quals.droneOperator === true)
    .map((s) => ({
      id: id++,
      side: s.side,
      companyId: s.companyId,
      operatorId: s.id,
      state: "ready" as const,
      pos: { ...s.pos },
      target: null,
      batteriesLeft: DRONE.BATTERIES,
      flightTicksLeft: ENDURANCE_TICKS,
      stateTick: 0,
      belief: new Map<string, Contact>(),
      lastReportTick: 0,
      flashWatch: newFlashWatch(),
    }));
}

export function droneOf(world: World, co: CompanyState): Drone | null {
  return world.drones.find((d) => d.side === co.side && d.companyId === co.companyId) ?? null;
}

function operatorOf(world: World, d: Drone): Soldier | null {
  const s = world.soldierById.get(d.operatorId);
  return s && s.status === "ok" && !isOffField(s) ? s : null;
}

function setState(world: World, d: Drone, state: Drone["state"]): void {
  d.state = state;
  d.stateTick = world.tick;
}

function moveToward(d: Drone, to: Vec2): boolean {
  const r = dist(d.pos, to);
  if (r <= STEP) {
    d.pos = { ...to };
    return true;
  }
  d.pos = {
    x: d.pos.x + ((to.x - d.pos.x) / r) * STEP,
    z: d.pos.z + ((to.z - d.pos.z) / r) * STEP,
  };
  return false;
}

/** その兵士は上から見えるか: 屋根の下(建物の中)と煙の中は見えない */
function visibleFromAbove(world: World, s: Soldier): boolean {
  if (world.buildings.some((b) => insideBounds(b.bounds, s.pos))) return false;
  for (const sm of world.smokes) {
    const r = smokeRadius(sm, world.tick);
    if (r > 0 && dist(sm.pos, s.pos) < r) return false;
  }
  return true;
}

/** 空にいる間、真下の範囲を見る。見たものは操縦手の記憶(`belief`)へ */
function observe(world: World, d: Drone): void {
  for (const s of world.soldiers) {
    if (s.side === d.side || s.status === "kia" || isOffField(s)) continue;
    if (dist(s.pos, d.pos) > DRONE.VIEW_RADIUS) continue;
    if (!visibleFromAbove(world, s)) continue;
    const key = `s${s.id}`;
    const c = d.belief.get(key);
    if (c) {
      c.pos = { x: s.pos.x, z: s.pos.z };
      c.lastSeenTick = world.tick;
      c.confidence = 1;
      c.posError = 0;
    } else {
      d.belief.set(key, {
        key,
        side: s.side,
        pos: { x: s.pos.x, z: s.pos.z },
        posError: 0,
        hopError: 0,
        lastSeenTick: world.tick,
        confidence: 1,
        count: 1,
      });
    }
  }
  // 戦死を確かめた相手は忘れる(仕様 §9 と同じ)
  for (const key of [...d.belief.keys()]) {
    const t = world.soldierById.get(Number(key.slice(1)));
    if (t && t.status === "kia" && dist(t.pos, d.pos) <= DRONE.VIEW_RADIUS) d.belief.delete(key);
  }
}

/** 毎ティック: 飛行・電池・視認。索敵のあと、無線の前に呼ぶ(見たものがこのティックの報告に乗る) */
export function droneSystem(world: World): void {
  for (const d of world.drones) {
    if (d.state === "lost" || d.state === "spent") continue;
    const op = operatorOf(world, d);
    if (!op) {
      // 操縦手が倒れた。飛んでいれば落ち、地上にあっても飛ばせる者がいない
      setState(world, d, "lost");
      d.target = null;
      continue;
    }
    if (d.state === "ready" || d.state === "swapping") {
      d.pos = { ...op.pos };
      if (d.state === "swapping" && world.tick - d.stateTick >= SWAP_TICKS)
        setState(world, d, "ready");
      continue;
    }
    d.flightTicksLeft--;
    if (d.state === "flying") {
      if (d.target) moveToward(d, d.target);
      // 帰りに要る時間 + 余裕を切ったら戻る
      const need = dist(d.pos, op.pos) / DRONE.SPEED + DRONE.RETURN_MARGIN_SEC;
      if (d.flightTicksLeft <= need * SIM_HZ) {
        setState(world, d, "returning");
        d.target = null;
      }
    } else if (d.state === "returning") {
      if (moveToward(d, op.pos)) {
        d.batteriesLeft--;
        d.flightTicksLeft = ENDURANCE_TICKS;
        setState(world, d, d.batteriesLeft > 0 ? "swapping" : "spent");
        continue;
      }
    }
    observe(world, d);
  }
}

/**
 * 飛ばせない理由。人間・LLM へそのまま返す。
 *   no_drone     : この中隊はドローンを持たない
 *   lost         : 操縦手が倒れて落ちた
 *   spent        : 電池を使い切った
 *   swapping     : 電池を替えている / 戻っている途中
 *   out_of_range : 操縦手から `MAX_RANGE` より遠い
 */
export type DroneBlock = "no_drone" | "lost" | "spent" | "swapping" | "out_of_range";

export const DRONE_BLOCK_TEXT: Record<DroneBlock, string> = {
  no_drone: "この中隊は観測ドローンを持たない",
  lost: "操縦手が倒れ、ドローンは失われた",
  spent: "電池を使い切った",
  swapping: "電池を替えている(または戻っている途中)",
  out_of_range: `遠すぎる(操縦手から ${DRONE.MAX_RANGE}m 以内)`,
};

export type DroneResult = { ok: true } | { ok: false; reason: DroneBlock };

/** 飛ばし先を決める(AI・人間・LLM 共通、P4)。手元にあれば飛び立つ */
export function taskDrone(world: World, co: CompanyState, target: Vec2): DroneResult {
  const d = droneOf(world, co);
  if (!d) return { ok: false, reason: "no_drone" };
  if (d.state === "lost") return { ok: false, reason: "lost" };
  if (d.state === "spent") return { ok: false, reason: "spent" };
  if (d.state === "swapping" || d.state === "returning") return { ok: false, reason: "swapping" };
  const op = operatorOf(world, d);
  if (!op) return { ok: false, reason: "lost" };
  if (dist(op.pos, target) > DRONE.MAX_RANGE) return { ok: false, reason: "out_of_range" };
  const b = world.bounds;
  d.target = {
    x: Math.min(b.maxX, Math.max(b.minX, target.x)),
    z: Math.min(b.maxZ, Math.max(b.minZ, target.z)),
  };
  if (d.state === "ready") {
    d.pos = { ...op.pos };
    setState(world, d, "flying");
  }
  return { ok: true };
}

/**
 * AI の中隊長の飛ばし先(`[v7.3]`)。材料は中隊長の像と作戦だけ(P1)。
 *   - 像に古くなりかけた接触があれば、いちばん古いものの上へ(像を新しくしに行く)
 *   - 無ければ、主攻の拠点(無ければ中隊の目標)の先、敵の方角へ `LOOK_AHEAD` m
 * 今の飛ばし先から `RETASK_DIST` 以上離れるときだけ変える(行ったり来たりしない)
 */
export function aiDrone(world: World, co: CompanyState): void {
  const d = droneOf(world, co);
  if (!d || (d.state !== "ready" && d.state !== "flying")) return;
  let stale: Contact | null = null;
  for (const c of co.belief.values()) {
    if (c.confidence <= 0.05 || c.confidence >= 0.8 || c.heard) continue;
    if (!stale || c.lastSeenTick < stale.lastSeenTick) stale = c;
  }
  let target: Vec2;
  if (stale) {
    target = { ...stale.pos };
  } else {
    const main = world.objectives.find((o) => o.id === co.plan?.mainObjectiveId);
    const base = main ? main.pos : co.objective;
    const len = Math.hypot(co.advanceDir.x, co.advanceDir.z) || 1;
    target = {
      x: base.x + (co.advanceDir.x / len) * DRONE.LOOK_AHEAD,
      z: base.z + (co.advanceDir.z / len) * DRONE.LOOK_AHEAD,
    };
  }
  const op = operatorOf(world, d);
  if (!op) return;
  // 届かない先は、届く範囲の縁まで寄せる
  const r = dist(op.pos, target);
  if (r > DRONE.MAX_RANGE) {
    const k = (DRONE.MAX_RANGE - 1) / r;
    target = { x: op.pos.x + (target.x - op.pos.x) * k, z: op.pos.z + (target.z - op.pos.z) * k };
  }
  if (d.state === "flying" && d.target && dist(d.target, target) < DRONE.RETASK_DIST) return;
  taskDrone(world, co, target);
}
