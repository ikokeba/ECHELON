/**
 * 担架搬送とCCPへの後送(仕様 §9 `[v5]` 担架搬送、v5でドクトリン準拠に修正・検証済み)。
 *
 * `casualties.ts` が担当するのは止血までで、止血した負傷者は行動不能のまま戦場に残る。
 * ここから先が本モジュールの範囲:
 *
 *   分隊長の後送命令(evac: "requested")
 *     → 分隊内の健常隊員から担架要員を動的に選出(2名 または 4名)
 *     → 負傷者を収容("carrying")、以後は搬送速度に律速される
 *     → CCP到達で "evacuated"(戦場から離脱、生存者としてカウント)
 *
 * ドクトリン上の要点(仕様 §9):
 *   - 編成単位は**分隊**。所属FTを問わず分隊内から動的に選出する。特定FTに固定された
 *     「担架班」という概念は存在しない
 *   - 2名は緊急・近距離用(目安50m以内)、4名(四隅担架法)が標準
 *   - 搬送中の担架要員は**武器を使用できない**
 *   - 非搬送要員は警戒・制圧射撃を継続する(応急手当と同じ考え方)
 *
 * `[v6]` 実装上の決定: 後送は**止血後にのみ着手する**。出血中の負傷者を担いで走っても
 * 出血は止まらないため、ドクトリン上も止血が先。仕様 §9 の「CASEVAC命令発行まで
 * 応急手当のみ自律実施」と整合する。
 */

import { LITTER, MOVE_SPEED, SIM_DT, SIM_HZ, SOLDIER_RADIUS } from "../constants.ts";
import { collidesWallIndexed, type WallIndex } from "../wallIndex.ts";
import { findPathSet } from "../navgrid.ts";
import { advanceAlongPath } from "../pathfollow.ts";
import { buildingAt } from "../cqb.ts";
import { activateBuildingNav } from "../world.ts";
import { soldierSeated } from "../control.ts";
import type { Side, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/**
 * 担架が進めていないと判定する1ティックあたりの移動量 m。`[v6.4]`
 * 4名編成でも 0.085m/tick 進むので、その1割強を下回れば止まっているとみなす。
 */
const LITTER_STUCK_EPS = 0.01;
/** 担架が詰まったまま**ウェイポイントを1つ諦める**までの連続ティック数(0.5秒)。`[v6.4]` */
const LITTER_SKIP_TICKS = Math.round(SIM_HZ * 0.5);
/** 担架が詰まったまま経路を張り直すまでの連続ティック数(1.5秒)。`[v6.4]` */
const LITTER_REPATH_TICKS = Math.round(SIM_HZ * 1.5);
/** 経路要求を試みる周期(ティック)。失敗する探索は成功するものより高くつく */
const LITTER_REQUEST_EVERY = SIM_HZ;
/** 収容(要員が負傷者へ集まる段階)を諦めて班を解散するまでの秒数。`[v6.4]` */
const PICKUP_TIMEOUT_TICKS = SIM_HZ * 20;

/** 担架要員が「搬送に拘束されている」か。C2層はこの隊員へ命令を出さない。 */
export function isCommittedToLitter(s: Soldier): boolean {
  return s.bearing !== null;
}

/**
 * CCPへ到達済みで、もう戦場にいない兵士か(仕様 §9)。
 * `evacuated` は後送アセット待ち、`collected` はアセットに収容済み。
 * どちらも生存者としてカウントされるが、描画・索敵・戦闘の対象からは外れる。
 */
export function isOffField(s: Soldier): boolean {
  return s.evac === "evacuated" || s.evac === "collected";
}

/** この負傷者の後送に必要な担架要員数(仕様 §9: 50m超は4名編成を要する)。 */
export function bearersNeeded(patient: Soldier, ccp: Vec2): number {
  const d = Math.hypot(patient.pos.x - ccp.x, patient.pos.z - ccp.z);
  return d <= LITTER.TWO_MAN_MAX_DIST ? 2 : 4;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 担架要員の解任。負傷者側の参照も必ず外す。 */
function release(world: World, bearerId: number): void {
  const bearer = world.soldierById.get(bearerId);
  if (!bearer) return;
  const patient = bearer.bearing !== null ? world.soldierById.get(bearer.bearing) : undefined;
  if (patient) patient.bearers = patient.bearers.filter((id) => id !== bearerId);
  bearer.bearing = null;
  bearer.speedMul = 1;
}

function disband(world: World, patient: Soldier): void {
  for (const id of [...patient.bearers]) release(world, id);
  patient.bearers = [];
  patient.stuckTicks = 0;
  if (patient.evac === "carrying") patient.evac = "requested";
}

/**
 * 担架そのものの移動。壁に当たったら壁沿いへ逃がす(`[v6.4]`)。
 *
 * 従来は「壁に当たる位置なら採用しない」だけで、壁沿いスライドも詰まりの検出も
 * 無かった。担架班は剛体なので一度角に噛むと自力では絶対に抜けられず、実測で
 * **153秒動かない**担架班が出ていた(4回目のテストプレイ指摘「搬送中に壁で詰まる」)。
 * 移動システムと同じスライド規則を使う。
 */
function slide(idx: WallIndex, from: Vec2, to: Vec2): Vec2 {
  if (!collidesWallIndexed(idx, to.x, to.z, SOLDIER_RADIUS)) return to;
  const sx = { x: to.x, z: from.z };
  if (!collidesWallIndexed(idx, sx.x, sx.z, SOLDIER_RADIUS)) return sx;
  const sz = { x: from.x, z: to.z };
  if (!collidesWallIndexed(idx, sz.x, sz.z, SOLDIER_RADIUS)) return sz;
  return { ...from };
}

/**
 * 搬送中の担架要員の配置。四隅担架法(4名)/前後2名を、進行方向基準の
 * ローカルオフセットで表す。兵士分離(直径0.7m)に負けない間隔を取る。
 */
function bearerOffset(i: number, size: number, dir: Vec2): Vec2 {
  const right = { x: -dir.z, z: dir.x };
  // 4名: 四隅 / 2名: 前後
  const along = size === 4 ? (i < 2 ? 0.55 : -0.55) : i === 0 ? 0.75 : -0.75;
  const lateral = size === 4 ? (i % 2 === 0 ? -0.5 : 0.5) : 0;
  return {
    x: dir.x * along + right.x * lateral,
    z: dir.z * along + right.z * lateral,
  };
}

/** 分隊内で担架要員に選べる隊員か(手当中・搬送中・戦闘不能は除く)。 */
function isAvailableBearer(world: World, cand: Soldier, patient: Soldier): boolean {
  return (
    // 一兵卒として人間が座っている隊員は担架に就けない(`[v7.3]` A-7)
    !soldierSeated(world, cand) &&
    cand.side === patient.side &&
    cand.squadId === patient.squadId &&
    // 本部要員(squadIdが負値)は小隊も一致していないと同じ部隊とは言えない
    cand.platoonId === patient.platoonId &&
    cand.status === "ok" &&
    cand.bearing === null &&
    cand.treating === null &&
    cand.id !== patient.id
  );
}

export function litterSystem(world: World): void {
  const maxStep = MOVE_SPEED * SIM_DT;

  // ── 1. 無効になった担架班の解散 ──
  for (const p of world.soldiers) {
    if (p.bearers.length === 0) continue;
    // 死亡・後送済み、あるいはそもそも負傷者でなくなった
    if (p.status !== "wia" || p.evac === "evacuated") {
      disband(world, p);
      p.evac = p.status === "kia" ? "none" : p.evac;
      continue;
    }
    // 担架要員が倒れた/離脱した場合は編成が崩れる。人数を割ったら一旦解散して組み直す
    const alive = p.bearers.filter((id) => {
      const b = world.soldierById.get(id);
      return b && b.status === "ok" && b.bearing === p.id;
    });
    if (alive.length !== p.bearers.length) {
      for (const id of p.bearers) if (!alive.includes(id)) release(world, id);
      p.bearers = alive;
    }
    if (p.bearers.length === 0) {
      p.evac = "requested";
      continue;
    }
    // `[v6.4]` 欠員が出て所要人数(2名/4名)を割った班は、その場でいったん降ろして
    // 組み直す。仕様 §9 の編成は2名か4名で、1名で担架は担げない。欠けたまま
    // 走らせると、いつまでも収容が成立しない班が戦場に残る(実測で確認した)。
    if (p.bearers.length < bearersNeeded(p, world.ccp[p.side])) {
      disband(world, p);
      p.evac = "requested";
    }
  }

  // ── 2. 後送命令の掃除と担架班の編成 ──
  for (const sq of world.squads) {
    if (sq.casevacOrders.length === 0) continue;
    sq.casevacOrders = sq.casevacOrders.filter((id) => {
      const p = world.soldierById.get(id);
      return p !== undefined && p.status === "wia" && p.evac !== "evacuated";
    });
  }

  for (const patient of world.soldiers) {
    if (patient.evac !== "requested" || patient.bearers.length > 0) continue;
    if (patient.status !== "wia") continue;
    // 止血が済むまでは担架班を組まない(`[v6]`。理由はファイル冒頭)
    if (!patient.stabilized) continue;

    const ccp = world.ccp[patient.side];
    const need = bearersNeeded(patient, ccp);

    const cands = world.soldiers
      .filter((c) => isAvailableBearer(world, c, patient))
      .map((c) => ({ c, d: dist(c.pos, patient.pos) }))
      // 距離が同点なら兵士IDで決着させ、走査順に依存しないようにする(対称性)
      .sort((a, b) => a.d - b.d || a.c.id - b.c.id);

    if (cands.length < need) continue; // 人が足りない。命令は残るので条件が整えば再試行される

    // `[v6.4]` 屋内で倒れた負傷者は、その建物の屋内ナビグリッドが張られていないと
    // 担架要員が経路を引けない(屋外グリッドは建物内部を除いてある)。突入した建物なら
    // 既に張られているが、掃討済みの建物から後で搬出する場合に落ちる。ここで保証する。
    const host = buildingAt(world.buildings, patient.pos);
    if (host) activateBuildingNav(world, host.id);

    for (let i = 0; i < need; i++) {
      const b = cands[i]!.c;
      b.bearing = patient.id;
      patient.bearers.push(b.id);
    }
    patient.stuckTicks = 0;
  }

  // ── 3. 収容と搬送 ──
  for (const patient of world.soldiers) {
    if (patient.bearers.length === 0) continue;
    const ccp = world.ccp[patient.side];
    const bearers = patient.bearers
      .map((id) => world.soldierById.get(id))
      .filter((b): b is Soldier => b !== undefined);
    if (bearers.length === 0) continue;

    const size = bearers.length;
    const speedMul = LITTER.SPEED_MUL[size] ?? 0.5;

    if (patient.evac === "requested") {
      // まだ収容前 — 全員が負傷者のそばへ集まるまでは通常速度で近づく
      const allNear = bearers.every((b) => dist(b.pos, patient.pos) <= LITTER.PICKUP_RADIUS);
      if (!allNear) {
        // `[v6.4]` 収容にも時間の上限を置く。要員がどうしても負傷者へ到達できない
        // 場合(瓦礫の奥・扉の向こう)に班を張り付かせたままにすると、健常兵が
        // 2〜4名まるごと戦闘から消える。いったん解散して分隊へ返し、命令だけ残す。
        patient.stuckTicks += 1;
        if (patient.stuckTicks > PICKUP_TIMEOUT_TICKS) disband(world, patient);
        for (const b of bearers) {
          b.speedMul = 1;
          b.order = {
            kind: "move",
            target: { ...patient.pos },
            facing: { ...b.facing },
            issuedTick: world.tick,
          };
        }
        continue;
      }
      patient.evac = "carrying";
      patient.stuckTicks = 0;
    }

    // ── 搬送中 ──
    // 担架班は**1つの剛体**として動かす。担架要員それぞれに経路探索をさせると
    // 各自が別々の経路へ散り、担架に乗っているはずの負傷者が誰からも離れてしまう。
    // 経路を持つのは「担架そのもの」(= 負傷者の path)で、要員はその四隅に貼り付く。
    // これはプロトタイプ casevac-litter-formation の「リーダーが進み、班は隊形で追従、
    // 全体速度を最遅要素に合わせてキャップする」構造と同じ。

    // 後送完了(仕様 §9: CCPから3.0m以内)
    if (dist(patient.pos, ccp) <= LITTER.EVAC_RADIUS) {
      patient.evac = "evacuated";
      disband(world, patient);
      continue;
    }

    // 経路要求は毎ティックではなく間引く(pathing.ts と同じ理由 — 失敗する探索は
    // 成功するものより高くつく)。位相は鏡像で一致する `ordinal` でずらす。
    if (
      patient.pathIdx >= patient.path.length &&
      (world.tick + patient.ordinal) % LITTER_REQUEST_EVERY === 0
    ) {
      const p = findPathSet(world.nav, patient.pos.x, patient.pos.z, ccp.x, ccp.z);
      if (p) {
        patient.path = p;
        patient.pathIdx = 0;
      }
    }

    // 搬送速度倍率(仕様 §9: 2名0.5倍 / 4名0.85倍)。全体がここに律速される
    const step = advanceAlongPath(patient.pos, patient.path, patient.pathIdx, maxStep * speedMul);
    const accepted = slide(world.moveIndex, patient.pos, step.pos);
    const progressed = Math.hypot(accepted.x - patient.pos.x, accepted.z - patient.pos.z);
    patient.pos = accepted;
    patient.pathIdx = step.pathIdx;
    // 壁沿いへ逃がしても進めないなら、まずウェイポイントを1つ諦め、それでも
    // 駄目なら経路ごと捨てて張り直す(移動システムの詰まり復帰と同じ段取り)。
    // 張り直しだけでは足りない — A*は同じ始点終点から同じ経路を返すので、
    // 通れないウェイポイントを飛ばす段が要る(実測で27秒の停止が残っていた)。
    if (progressed > LITTER_STUCK_EPS) {
      patient.stuckTicks = 0;
    } else {
      patient.stuckTicks += 1;
      if (patient.stuckTicks >= LITTER_REPATH_TICKS) {
        patient.path = [];
        patient.pathIdx = 0;
        patient.stuckTicks = 0;
      } else if (patient.stuckTicks % LITTER_SKIP_TICKS === 0) {
        patient.pathIdx += 1;
      }
    }
    const dir = step.dir ?? { x: patient.facing.x, z: patient.facing.z };
    patient.facing = { ...dir };

    bearers.forEach((b, i) => {
      b.speedMul = speedMul;
      const off = bearerOffset(i, size, dir);
      const px = patient.pos.x + off.x;
      const pz = patient.pos.z + off.z;
      // 担架の四隅へ貼り付ける。壁に食い込む位置なら担架中心へ寄せる
      b.pos = collidesWallIndexed(world.moveIndex, px, pz, SOLDIER_RADIUS * 0.7)
        ? { ...patient.pos }
        : { x: px, z: pz };
      b.path = [];
      b.pathIdx = 0;
      // 搬送中は武器を使用できない(仕様 §9)。命令は hold にして
      // 移動システムに触らせず、進行方向へ向かせるだけにする
      b.order = { kind: "hold", facing: { ...dir }, issuedTick: world.tick };
    });
  }
}

/**
 * 後送済みの人数(陣営別)。HUD・戦果集計用。
 *
 * `evacuated`(CCP到達・アセット待ち)と `collected`(アセット収容済み)の**両方**を数える。
 * 前者は数分で後者へ移る通過点にすぎないので、片方だけ数えると
 * 「後送は成立しているのに集計は常に0」という誤った像になる(実際にそれで検証を誤らせた)。
 */
export function evacuatedCount(world: World, side: Side): number {
  return world.soldiers.filter((s) => s.side === side && isOffField(s)).length;
}
