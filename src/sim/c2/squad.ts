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

import { LITTER, SIM_HZ } from "../constants.ts";
import { aiSuppressed } from "../control.ts";
import { bearersNeeded, isCommittedToLitter } from "../systems/litter.ts";
import { doorById, selectAssaultDoor } from "../cqb.ts";
import { commandFactor } from "./succession.ts";
import { exitCqb } from "./cqbDrill.ts";
import type { Contact, Door, Soldier, SquadState, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/** 分隊の先端から分隊長が後方に位置する距離 m。 */
const TRAIL_DIST = 4;
/** 意思決定周期。毎ティックではない。 */
const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);
/** 現在の目的地からこの距離以内なら再発行しない m。 */
const DEST_EPS = 1.2;
/** support_by_fire: 制圧目標からこれだけ手前に射撃位置を取る m。`[v6.1]` OQ-3 */
const SBF_STANDOFF = 35;

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

  // 任務種別による目標の解釈(`[v6.1]` OQ-3)。
  //   support_by_fire : 制圧目標へ射線の通る「手前の位置」に就く。踏み込まない
  //   screen          : 掩護軸(mission.target)へ薄く展開して監視・遅滞
  //   seize           : sq.objective をそのまま(確保・突撃)
  const mk = sq.mission.kind;
  let ftObjective: Vec2 = { ...sq.objective };
  let ftTechnique = sq.technique;
  if (mk === "support_by_fire") {
    // 目標から SBF_STANDOFF だけ分隊側へ引いた点を射撃位置とする
    const men = world.soldiers.filter(
      (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
    );
    const from = men.length ? centroid(men) : sq.objective;
    const back = dirTo(sq.mission.target, from);
    ftObjective = {
      x: sq.mission.target.x + back.x * SBF_STANDOFF,
      z: sq.mission.target.z + back.z * SBF_STANDOFF,
    };
    ftTechnique = "traveling_overwatch";
  } else if (mk === "screen") {
    ftObjective = { ...sq.mission.target };
    ftTechnique = "traveling_overwatch";
  }

  for (const ft of fireteams) {
    // 人間が操作しているFTには再割り当てを行わない(仕様 §4、小隊長と同じ理由)
    const leader = world.soldiers.find(
      (s) =>
        s.side === ft.side &&
        s.squadId === ft.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.isFireteamLeader &&
        s.status === "ok",
    );
    if (leader && aiSuppressed(world, "fireteam", ft.side, leader.id)) continue;

    // 任務目標と移動技術は上から下へそのまま伝播する
    ft.objective = { ...ftObjective };
    ft.technique = ftTechnique;
    // support_by_fire は全FTをベース・オブ・ファイアに固定して踏み込ませない
    ft.assignedRole = mk === "support_by_fire" ? "base" : null;
  }

  // support_by_fire / screen は側面機動の割り当てをしない(踏み込まない任務)。
  // 火器分隊は小隊AIから常に support_by_fire を受けるのでここで自然に弾かれる。
  if (mk !== "seize") return;
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

/**
 * 後送(担架搬送)の発令(仕様 §9)。
 *
 * 応急手当が命令不要の自律トリガーであるのに対し、**担架搬送は明示的な命令を要する**。
 * これは仕様が意図した戦術的トレードオフそのもの: 後送すれば負傷者は生存者として
 * 数えられるが、分隊は担架要員2〜4名を一時的に失う。
 *
 * AI分隊長の判断規則: 止血済みの負傷者について、担架班を出したあとも分隊に
 * 最低限の戦力(LITTER.MIN_REMAINING_EFFECTIVE)が残る場合にのみ命じる。
 * 残らないなら負傷者はその場に留まる — 前線が下がるか増援が来るのを待つことになる。
 */
function decideCasevac(world: World, sq: SquadState): void {
  const members = world.soldiers.filter((s) => s.side === sq.side && s.squadId === sq.squadId);
  const patients = members.filter(
    (s) => s.status === "wia" && s.stabilized && s.evac === "none",
  );
  if (patients.length === 0) return;

  const ccp = world.ccp[sq.side];
  for (const p of patients) {
    // 手当・搬送に就いていない健常隊員のみが担架要員になれる
    const free = members.filter(
      (s) => s.status === "ok" && s.bearing === null && s.treating === null,
    ).length;
    const need = bearersNeeded(p, ccp);
    if (free - need < LITTER.MIN_REMAINING_EFFECTIVE) continue;

    p.evac = "requested";
    sq.casevacOrders.push(p.id);
  }
}

/**
 * 建物単位のバトルドリル(仕様 §7.2 Battle Drill 6)。
 *
 * 仕様の要点:「**建物単位では小隊長を介さず分隊長が孤立化から再編成まで一貫して
 * 担当する**」。ここで分隊長がやるのは最初の3段階:
 *
 *   孤立化   : 支援FTを扉の射線が通る位置へ置き、退路を押さえる
 *   支援射撃 : 支援FTに `assignedRole: "base"` を与える
 *   突撃     : 突入FTに扉を指定する(以降の実行は c2/cqbDrill.ts)
 *
 * 分隊長自身が突入するかは状況次第(仕様 §7.2)。現状は入口付近で指揮に専念する。
 * 個体差パラメータ(積極性・大胆さ)による分岐は OQ-6 の解決後に入れる。
 *
 * @returns 突入を指示したら true(通常の火力/機動の割り当てを上書きする)
 */
function directBuildingAssault(world: World, sq: SquadState): boolean {
  if (world.buildings.length === 0) return false;

  const fireteams = world.fireteams.filter(
    (f) => f.side === sq.side && f.squadId === sq.squadId,
  );
  if (fireteams.length === 0) return false;

  const members = world.soldiers.filter(
    (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
  );
  if (members.length === 0) return false;
  const from = centroid(members);

  const alive = fireteams.filter((ft) =>
    world.soldiers.some(
      (s) =>
        s.side === ft.side &&
        s.squadId === ft.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.status === "ok",
    ),
  );
  if (alive.length === 0) return false;

  // ── すでに攻略中なら、それを最後までやり切る(仕様 §7.2) ──
  if (sq.assaultDoorId !== null) {
    const running = alive.find((ft) => ft.cqbDoorId === sq.assaultDoorId);
    if (running) {
      for (const ft of alive) {
        if (ft === running) continue;
        if (ft.cqbDoorId !== null) exitCqb(ft);
        ft.assignedRole = "base";
        const d = doorById(world.buildings, sq.assaultDoorId);
        if (d) ft.objective = { ...d.pos };
      }
      return true;
    }
    // 突入FTがCQBを抜けた。掃討を完了した場合は cqbDrill 側が clearedDoorIds へ
    // 記録済みなので、ここでは latch を外すだけにする。中断(FALLBACK・潰走・全滅)
    // で抜けた場合はこの扉が未掃討のまま残り、態勢が整えばもう一度攻略できる。
    sq.assaultDoorId = null;
  }

  // 突入対象は「任務目標が建物の中にある」か「把握している脅威が建物の中にいる」か。
  // どちらも分隊長の world picture 経由で、実際の敵位置は覗かない(仕様 §5)
  const threat = primaryThreat(sq.belief);
  const aims = [sq.objective, ...(threat ? [threat.pos] : [])];
  let door: Door | null = null;
  for (const aim of aims) {
    // `[v6.2]` 掃討済みの扉を除いて選ばせる。中廊下+区画の建物では、これで
    // 廊下 → 区画1 → 区画2 … と部屋を1つずつ潰していく動きになる(仕様 §7.2)
    const d = selectAssaultDoor(world.buildings, from, aim, sq.clearedDoorIds);
    if (d) {
      door = d;
      break;
    }
  }
  if (!door) {
    for (const ft of fireteams) if (ft.cqbDoorId !== null) exitCqb(ft);
    return false;
  }

  // 扉に近い側が突撃、遠い側が支援射撃。近い側のほうがスタックを早く組める
  const target = door;
  const withDist = alive.map((ft) => {
    const men = world.soldiers.filter(
      (s) =>
        s.side === ft.side &&
        s.squadId === ft.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.status === "ok",
    );
    const c = centroid(men);
    return { ft, d: Math.hypot(c.x - target.pos.x, c.z - target.pos.z) };
  });
  withDist.sort((a, b) => a.d - b.d || a.ft.ftIndex - b.ft.ftIndex);
  const assault = withDist[0]!.ft;
  assault.cqbDoorId = target.id;
  assault.cqbStage = "stack";
  assault.cqbStageSince = world.tick;
  assault.cqbCorner.clear();
  assault.cqbEntryOrder = [];
  sq.assaultDoorId = target.id;

  for (const ft of alive) {
    if (ft === assault) continue;
    // 孤立化 + 支援射撃。扉の外側へ火力を指向し、退路と増援経路を押さえる
    if (ft.cqbDoorId !== null) exitCqb(ft);
    ft.assignedRole = "base";
    ft.objective = { ...target.pos };
  }
  return true;
}

export function squadAI(world: World): void {
  const decidedThisTick = new Set<number>();

  for (const sq of world.squads) {
    // 人間が操作している分隊長のAIは止める(仕様 §4)
    if (aiSuppressed(world, "squad", sq.side, sq.squadId)) continue;
    // 指揮継承直後は判断周期が伸びる(仕様 §12: 命令解釈の冗長化・新規戦術判断不可)
    const factor = commandFactor(sq, world.tick, "squad");
    if (world.tick - sq.lastDecisionTick < Math.round(DECIDE_EVERY_TICKS / factor)) continue;
    sq.lastDecisionTick = world.tick;
    decidedThisTick.add(sq.squadId);

    directFireteams(world, sq);
    // 建物のバトルドリル(仕様 §7.2)は通常の火力/機動の割り当てより優先する。
    // 建物へ突入する局面では、屋外の側面攻撃ではなく突入と支援の分担が正しい。
    // ただし踏み込まない任務(support_by_fire / screen)では突入しない。
    if (sq.mission.kind === "seize") directBuildingAssault(world, sq);
    decideCasevac(world, sq);
  }

  // ── 分隊長自身の位置取り ──
  // 「分隊長」は肩書きではなく §12 の継承で決まる。分隊長が倒れれば次席のFTリーダーが
  // その役を引き継ぐので、位置取りの主体も commanderId を見て決める。
  for (const sq of world.squads) {
    if (!decidedThisTick.has(sq.squadId)) continue;
    if (sq.commanderId === null) continue;
    const sl = world.soldierById.get(sq.commanderId);
    if (!sl || sl.status !== "ok") continue;
    if (aiSuppressed(world, "squad", sl.side, sl.squadId)) continue;
    // 分隊長本人が一兵卒として直接操作されている場合も、AIの位置取りは止める
    if (aiSuppressed(world, "soldier", sl.side, sl.id)) continue;
    // 分隊長自身が担架要員に選ばれている間は、位置取りより搬送が優先される(仕様 §9)
    if (isCommittedToLitter(sl)) continue;
    // 指揮を継承したのがFTリーダーの場合、彼は自分のFTを率いたまま分隊も見る。
    // 隊列から引き剥がして後方へ下げると、FT側の隊形と射線が崩れるうえ、
    // fireteamAI が同じティックで命令を上書きし合って挙動が振動する。
    if (sl.fireteamId >= 0) continue;

    const squad = world.soldiers.filter(
      (s) =>
        s.side === sl.side && s.squadId === sl.squadId && s.fireteamId >= 0 && s.status === "ok",
    );
    if (squad.length === 0) continue;

    const threat = primaryThreat(sq.belief);

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
