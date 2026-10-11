/**
 * 地上からドローンに気づく(`[v7.5]` ロードマップ S-6、設計メモ §6.3)。
 *
 * `[v7.3]` の観測ドローン(systems/drone.ts)は、見られている側から認識する手段が無かった。
 * プレイでの指摘「ドローンが強すぎる」の原因は性能ではなくここにある — 見られていることを
 * 誰も知らないので、隠れる・止まる・撃つ、のどれも起きない。
 *
 * ここでは兵士がドローンを**目で見る**(`UAS_DETECT.SIGHT` m 以内。屋外か窓から。煙越しは
 * 見えない)か、**羽音を聞く**(`UAS_DETECT.HEAR` m 以内。方角と刻んだ距離だけ。屋内では
 * くぐもって縮む)。ドローンの視界(真下 40m)より広いので、先に気づくのは地上側になる。
 *
 * 守っている一線(ロードマップ P1 / §6.3):
 *   - 気づいたことは**そのFTの記憶**(`ft.uas`)に入るだけ。分隊長はFTの合算として直接、
 *     小隊長・中隊長は無線報告(radio.ts)で遅れて知る
 *   - **兵士の接触と混ぜない**。`ft.memory` ではなく `ft.uas` に入れるので、迫撃砲の目標・
 *     擲弾の照準・FTの接敵判定・分隊の機動の向きには一切効かない(ドローンを砲撃しない)
 *   - 聞いただけの接触は、聞いた者の位置から見た方角の区分と刻んだ距離から組み立てる。
 *     ドローンの位置をそのまま入れない(音による察知 A-5 と同じ作法)
 *
 * 両軍で同じ(P2)、乱数を引かない(P3)。
 */

import { CONFIDENCE_CUTOFF, HEARING, SIM_HZ, UAS_DETECT } from "../constants.ts";
import { decayedConfidence } from "../belief.ts";
import { buildingAt } from "../cqb.ts";
import { posErrorOf } from "../radio.ts";
import { isOffField } from "./litter.ts";
import { smokeBlocks } from "./smoke.ts";
import type { Contact, Drone, Soldier, UasContacts } from "../types.ts";
import type { World } from "../world.ts";

const SECTOR_RAD = (Math.PI * 2) / HEARING.BEARING_SECTORS;

/** ドローンの接触のキー。1機につき1件(目で見ても、聞いても同じ件を更新する) */
export function uasKey(droneId: number): string {
  return `u${droneId}`;
}

/** 空にいるドローン(飛んでいる・戻っている)。地上にあるもの・落ちたものは気づかれない */
export function airborne(d: Drone): boolean {
  return d.state === "flying" || d.state === "returning";
}

/** 屋内にいるか。屋内からは窓越しにしかドローンを見られない */
function indoors(world: World, s: Soldier): boolean {
  return buildingAt(world.buildings, s.pos) !== null;
}

/** 目で見たドローンを記憶へ。位置は正確 */
function rememberSeen(mem: UasContacts, d: Drone, tick: number): void {
  const key = uasKey(d.id);
  const c = mem.get(key);
  if (c) {
    c.pos = { x: d.pos.x, z: d.pos.z };
    c.lastSeenTick = tick;
    c.confidence = 1;
    c.posError = 0;
    c.hopError = 0;
    delete c.heard;
    delete c.heardError;
    return;
  }
  mem.set(key, {
    key,
    side: d.side,
    pos: { x: d.pos.x, z: d.pos.z },
    posError: 0,
    hopError: 0,
    lastSeenTick: tick,
    confidence: 1,
    count: 1,
  });
}

/**
 * 聞いたドローンを記憶へ。方角は区分の中心へ、距離は刻みへ丸めて、聞いた者の位置から
 * 組み立てる。羽音は「いま鳴っている」新しい情報なので確度は 1 から始めるが、位置は粗い
 * (銃声の接触と違い、照準に使う箇所がそもそも無いので確度を下げておく必要が無い)
 */
function rememberHeard(mem: UasContacts, d: Drone, ear: Soldier, earD: number, tick: number): void {
  const bearing = Math.atan2(d.pos.z - ear.pos.z, d.pos.x - ear.pos.x);
  const n = HEARING.BEARING_SECTORS;
  const sector = ((Math.round(bearing / SECTOR_RAD) % n) + n) % n;
  const a = sector * SECTOR_RAD;
  const step = UAS_DETECT.RANGE_STEP;
  const est = Math.max(step, Math.round(earD / step) * step);
  const pos = { x: ear.pos.x + Math.cos(a) * est, z: ear.pos.z + Math.sin(a) * est };
  const key = uasKey(d.id);
  const c: Contact = {
    key,
    side: d.side,
    pos,
    posError: UAS_DETECT.HEARD_ERROR,
    hopError: 0,
    heardError: UAS_DETECT.HEARD_ERROR,
    lastSeenTick: tick,
    confidence: 1,
    heard: true,
  };
  mem.set(key, c);
}

/** 記憶の確度と位置誤差を、いまのティック基準で組み直す。尽きたものは忘れる */
function decay(mem: UasContacts, tick: number): void {
  for (const [key, c] of mem) {
    const age = (tick - c.lastSeenTick) / SIM_HZ;
    c.confidence = decayedConfidence(age);
    c.posError = posErrorOf(c, age);
    if (c.confidence < CONFIDENCE_CUTOFF) mem.delete(key);
  }
}

/**
 * 毎ティック: 各FTの隊員が、空にいる敵ドローンを見る・聞く。ドローンが動いたあと
 * (droneSystem の直後)、無線の前に呼ぶ — 気づいたことがこのティックの報告に乗る
 */
export function uasDetectionSystem(world: World): void {
  for (const s of world.soldiers) if (s.seesUas && s.seesUas.length > 0) s.seesUas = [];

  const flying = world.drones.filter(airborne);
  if (flying.length > 0) {
    for (const ft of world.fireteams) {
      let members: Soldier[] | null = null;
      for (const d of flying) {
        if (d.side === ft.side) continue;
        members ??= world.soldiers.filter(
          (s) =>
            s.side === ft.side &&
            s.squadId === ft.squadId &&
            s.fireteamId === ft.ftIndex &&
            s.status === "ok" &&
            !isOffField(s),
        );
        let seen = false;
        let ear: Soldier | null = null;
        let earD = Infinity;
        for (const s of members) {
          const r = Math.hypot(d.pos.x - s.pos.x, d.pos.z - s.pos.z);
          if (r > UAS_DETECT.HEAR) continue;
          const inside = indoors(world, s);
          if (
            r <= UAS_DETECT.SIGHT &&
            (!inside || s.atWindow) &&
            !smokeBlocks(world, s.pos.x, s.pos.z, d.pos.x, d.pos.z)
          ) {
            (s.seesUas ??= []).push(d.id);
            seen = true;
          }
          const hearR = UAS_DETECT.HEAR * (inside ? UAS_DETECT.MUFFLED_MUL : 1);
          if (r <= hearR && r < earD) {
            ear = s;
            earD = r;
          }
        }
        if (seen) rememberSeen(ft.uas, d, world.tick);
        else if (ear) rememberHeard(ft.uas, d, ear, earD, world.tick);
      }
    }
  }

  for (const ft of world.fireteams) if (ft.uas.size > 0) decay(ft.uas, world.tick);
}
