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

import { CQB, FLANK, LITTER, SIM_HZ } from "../constants.ts";
import {
  chooseFlankSide,
  flankRadius,
  flankSeparationDeg,
  flankWaypoint,
  spreadAlongArc,
} from "./flank.ts";
import { aiSuppressed } from "../control.ts";
import { bearersNeeded, isCommittedToLitter } from "../systems/litter.ts";
import { buildingAt, doorById, insideBounds, selectAssaultDoor } from "../cqb.ts";
import { commandFactor } from "./succession.ts";
import { activateBuildingNav, sideDoctrine } from "../world.ts";
import { exitCqb } from "./cqbDrill.ts";
import { decideSmoke } from "../systems/smoke.ts";
import { objectiveCoveringPoint, occupySlots } from "./objectiveHold.ts";
import type { Contact, Door, Soldier, SquadState, Vec2 } from "../types.ts";

/** `indexLiving` の戻り値。分隊AIの内部でだけ使う */
type LivingIndex = { bySquad: Map<string, Soldier[]>; byFt: Map<string, Soldier[]> };
import type { World } from "../world.ts";

/** 分隊の先端から分隊長が後方に位置する距離 m。 */
const TRAIL_DIST = 4;
/** 意思決定周期。毎ティックではない。 */
const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);
/** 現在の目的地からこの距離以内なら再発行しない m。 */
const DEST_EPS = 1.2;
/** support_by_fire: 制圧目標からこれだけ手前に射撃位置を取る m。`[v6.1]` 任務種別(§3①) */
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

/** このFTのリーダーを人間が操作しているか(仕様 §4)。操作中のFTへは目標を上書きしない */
function ftControlled(world: World, ft: World["fireteams"][number]): boolean {
  const leader = world.soldiers.find(
    (s) =>
      s.side === ft.side &&
      s.squadId === ft.squadId &&
      s.fireteamId === ft.ftIndex &&
      s.isFireteamLeader &&
      s.status === "ok",
  );
  return leader !== undefined && aiSuppressed(world, "fireteam", ft.side, leader.id);
}

/**
 * 分隊長が麾下FTへ意図を下ろす。
 *
 * 移動技術は小隊長の指示をそのまま流す。接敵時のベース・オブ・ファイア/機動役の
 * 割り当ては分隊長の裁量(仕様 §6 Fire and Movement の実行判断は分隊長の責務)。
 */
function directFireteams(world: World, sq: SquadState, idx: LivingIndex): void {
  const fireteams = world.fireteams.filter(
    (f) => f.side === sq.side && f.squadId === sq.squadId,
  );
  if (fireteams.length === 0) return;

  // 各FTの生存者数を数え、全滅したFTには役割を割り当てない
  const strength = new Map<number, number>();
  for (const ft of fireteams) {
    strength.set(
      ft.ftIndex,
      (idx.byFt.get(`${ft.side}:${ft.squadId}:${ft.ftIndex}`) ?? []).length,
    );
  }

  const threat = primaryThreat(sq.belief);

  // 任務種別による目標の解釈(`[v6.1]` §3①)。
  //   support_by_fire : 制圧目標へ射線の通る「手前の位置」に就く。踏み込まない
  //   screen          : 掩護軸(mission.target)へ薄く展開して監視・遅滞
  //   seize           : sq.objective をそのまま(確保・突撃)
  const mk = sq.mission.kind;
  let ftObjective: Vec2 = { ...sq.objective };
  let ftTechnique = sq.technique;
  if (mk === "support_by_fire") {
    // 目標から SBF_STANDOFF だけ分隊側へ引いた点を射撃位置とする
    const men = idx.bySquad.get(`${sq.side}:${sq.squadId}`) ?? [];
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
  } else {
    // `[v6.2]` 目標が建物の中にある場合、そこは**屋外からは到達できない目的地**である。
    // 経路は扉を通るが閉じた扉が移動を阻むので、そのまま渡すとFTは扉に張り付いて止まる。
    // 接近の経由地は外扉にしておき、屋内へ入るのは突入ドリル(仕様 §7.2)に任せる。
    const host = buildingAt(world.buildings, sq.objective);
    // `[v6.4]` ただし既に建物へ取り付いている分隊は、外の接近地点へ戻さない。
    // 屋内の掃討は突入ドリルが扉ごとに指揮しており、その合間(再編成〜次の扉の選定)に
    // 目標を屋外へ振ると、部屋を1つ潰すたびにFTが建物から出ていってしまう。
    const men = idx.bySquad.get(`${sq.side}:${sq.squadId}`) ?? [];
    const engaged = host !== null && men.some((m) => insideBounds(host.bounds, m.pos));
    if (host && !engaged) {
      const entry = host.doors.find((d) => d.exterior) ?? host.doors[0];
      // 扉の真上ではなく手前に置く。真上だとFT全員が戸口に群がってスタックが組めない
      if (entry) {
        ftObjective = {
          x: entry.pos.x - entry.normal.x * CQB.APPROACH_DIST,
          z: entry.pos.z - entry.normal.z * CQB.APPROACH_DIST,
        };
      }
    }
  }

  // ── ドクトリンの自主性(仕様 §13)`[v6.8]` ──
  // 上位から降りてきた目標を、分隊長自身が見ているもの(自分の belief)へ寄せる。
  // 0 なら指示どおり(正規軍)、1 なら上からの目標は事実上無視されて目の前の敵が全て。
  // **線形補間なので決定論的**で、乱数を引かない — 引くと §2/§13 の鏡像性が壊れる。
  const initiative = sideDoctrine(world, sq.side).initiative;
  if (initiative > 0 && threat && mk === "seize") {
    ftObjective = {
      x: ftObjective.x + (threat.pos.x - ftObjective.x) * initiative,
      z: ftObjective.z + (threat.pos.z - ftObjective.z) * initiative,
    };
  }

  // ── 占領(`[v6.9]` F-9、仕様 §12)──
  //
  // ここまでで決まった `ftObjective` は「20m級の隊形をどこに置くか」でしかなく、
  // 確保判定は「判定円の中の人数」を数えている。両者が接続されていないので、
  // 拠点の真上に持ち場を置いても円の中には誰も入らない(実測: 守備に付いた206秒で
  // 重心が円内にあった時間0秒、円内の人数 平均0.15名、分隊の広がり平均21.6m)。
  //
  // **突撃組(ft=0)だけ**を判定円の中へ入れる。支援組は外に残して撃たせる
  // (ATP 3-21.8 の突撃組/支援組)。分隊ごと畳む案は測って捨てた —
  // 円内滞在 29→0秒、BLUE戦死 21→38名。戦列を失うと隊形が伸びて各個に撃たれる。
  const occupy = mk === "seize" ? objectiveCoveringPoint(world, ftObjective) : null;
  const occupySeat = occupy ? occupySlots(occupy, { x: 0, z: 1 }, 1)[0]! : null;

  for (const [ftIdx, ft] of fireteams.entries()) {
    // 人間が操作しているFTには再割り当てを行わない(仕様 §4、小隊長と同じ理由)
    if (ftControlled(world, ft)) continue;

    // 任務目標と移動技術は上から下へそのまま伝播する。
    // 占領中の突撃組だけ、判定円の中の持ち場に差し替える(`[v6.9]`)
    ft.objective = occupySeat && ftIdx === 0 ? { ...occupySeat } : { ...ftObjective };
    ft.technique = ftTechnique;
    ft.watch = sq.watch ? { ...sq.watch } : null; // 警戒方向(`[v6.16]`)
    // support_by_fire は全FTをベース・オブ・ファイアに固定して踏み込ませない
    ft.assignedRole = mk === "support_by_fire" ? "base" : null;
    // 側面の経由点は毎周期この下で引き直す(`[v7.0]`)。役割が無くなれば消える
    ft.flankGoal = null;
    ft.flankDone = false;
  }

  // support_by_fire / screen は側面機動の割り当てをしない(踏み込まない任務)。
  // 火器分隊は小隊AIから常に support_by_fire を受けるのでここで自然に弾かれる。
  if (mk !== "seize") {
    sq.flank = null;
    return;
  }

  const alive = fireteams.filter((ft) => (strength.get(ft.ftIndex) ?? 0) > 0);
  const ftCentroid = (ft: (typeof fireteams)[number]): Vec2 =>
    centroid(idx.byFt.get(`${ft.side}:${ft.squadId}:${ft.ftIndex}`) ?? []);

  // 小隊長を人間/エージェントが引き継いだら、AI小隊長が最後に残した側面機動の
  // 指示は無効(もう誰も更新しないので、放置すると古い経由点へ向かい続ける)
  if (aiSuppressed(world, "platoon", sq.side, sq.platoonId)) {
    sq.flankGoal = null;
    sq.flankAssault = false;
  }

  // ── 小隊の側面機動に指名されている(`[v7.0]`)──
  // 支援射撃は小隊のベース分隊が持つので、分隊内では火力と機動に分けない。
  // 両FTを機動要素として弧の上の経由点へ向かわせ、左右に少しずらして並べる。
  if (sq.flankGoal || sq.flankAssault) {
    sq.flank = null;
    alive.forEach((ft, i) => {
      ft.assignedRole = "maneuver";
      if (sq.flankAssault) {
        ft.flankDone = true;
        return;
      }
      const goal = sq.flankGoal!;
      const k = i - (alive.length - 1) / 2;
      const ref = threat ? threat.pos : sq.objective;
      ft.flankGoal = spreadAlongArc(ref, goal, k * FLANK.FT_SPREAD);
      if (!ftControlled(world, ft)) ft.objective = { ...ft.flankGoal };
    });
    return;
  }

  // 脅威を見失っても、しばらくは段取りを保つ(一瞬の見失いで振り出しに戻さない)
  if (!threat) {
    if (sq.flank && world.tick - sq.flank.lastThreatTick > FLANK.RELEASE_SEC * SIM_HZ) {
      sq.flank = null;
    }
    return;
  }

  if (alive.length < 2) {
    // 1個FTしか残っていない分隊では、FT間で火力と機動を分けられない。
    // 役割を割り当てず null のままにし、FT内部の2バディペアで自律的に
    // Fire and Movement をさせる(assignedRole が null のときのFT側の分岐)。
    // ここで "base" を割り当ててしまうと、残存FT全員が制圧に張り付いたまま
    // 誰も前進しなくなり、両軍が睨み合ったまま永久に膠着する。
    sq.flank = null;
    return;
  }

  // ── 役割の決定は交戦の最初の1回だけ(`[v7.0]`)──
  // 敵に近い側のFTをベース・オブ・ファイア、もう一方を機動役にする。近い側が既に
  // 射撃位置についている可能性が高く、遠い側のほうが回り込む余地があるため。
  // **決めたら変えない。** 毎周期引き直すと、機動組が敵へ寄った瞬間に「近い側」に
  // なって役割が入れ替わり、回り込みが毎回振り出しに戻る(実測で分隊戦5回270回)。
  const byIdx = (i: number): (typeof fireteams)[number] | undefined =>
    alive.find((ft) => ft.ftIndex === i);
  let plan = sq.flank;
  if (plan && (!byIdx(plan.baseKey) || !byIdx(plan.maneuverKey))) plan = null;
  // 突撃が一段落したら組み直す(次の敵には次の側面がある)
  if (plan?.doneTick != null && world.tick - plan.doneTick > FLANK.SQUAD_ASSAULT_SEC * SIM_HZ) {
    plan = null;
  }
  if (!plan) {
    const withDist = alive.map((ft) => {
      const c = ftCentroid(ft);
      return { ft, d: Math.hypot(c.x - threat.pos.x, c.z - threat.pos.z) };
    });
    withDist.sort((a, b) => a.d - b.d || a.ft.ftIndex - b.ft.ftIndex);
    const baseFt = withDist[0]!.ft;
    const manFt = withDist[1]!.ft;
    const baseC = ftCentroid(baseFt);
    const manC = ftCentroid(manFt);
    plan = {
      baseKey: baseFt.ftIndex,
      maneuverKey: manFt.ftIndex,
      dir: chooseFlankSide({
        threat: threat.pos,
        base: baseC,
        maneuver: manC,
        objective: sq.objective,
        contacts: sq.belief.values(),
        radius: flankRadius(threat.pos, manC, FLANK.SQUAD_RADIUS),
        cover: world.coverIndex,
        wallIndex: world.wallIndex,
        bounds: world.bounds,
      }),
      sinceTick: world.tick,
      lastThreatTick: world.tick,
      done: false,
      doneTick: null,
    };
    sq.flank = plan;
  }
  plan.lastThreatTick = world.tick;

  const baseFt = byIdx(plan.baseKey)!;
  const manFt = byIdx(plan.maneuverKey)!;
  baseFt.assignedRole = "base";
  manFt.assignedRole = "maneuver";
  for (const ft of alive) {
    if (ft !== baseFt && ft !== manFt) ft.assignedRole = "maneuver";
  }

  // ── 側面の経由点と、取れたかどうか ──
  const baseC = ftCentroid(baseFt);
  const manC = ftCentroid(manFt);
  if (!plan.done) {
    const sep = flankSeparationDeg(threat.pos, baseC, manC);
    const timedOut = world.tick - plan.sinceTick > FLANK.SQUAD_TIMEOUT_SEC * SIM_HZ;
    if (sep >= FLANK.DONE_DEG || timedOut) {
      plan.done = true;
      plan.doneTick = world.tick;
    }
  }
  // 拠点を占領・保持している分隊は、**拠点から離れた敵へは**回り込みに出ない(`[v7.0]`)。
  // 持ち場は拠点であって遠くの敵の側面ではない — 従来どおり近くの遮蔽で側面寄りに
  // 構えるだけにする。拠点そのものへ寄ってきた敵には回り込んで叩く(局地的な逆襲)。
  // 遠い敵(弧が描けない距離)も同じ: まず射程の内側へ詰めるのが先
  const farThreat =
    Math.hypot(manC.x - threat.pos.x, manC.z - threat.pos.z) > FLANK.SQUAD_ENGAGE_MAX;
  // 「拠点へ向かっている」だけなら回り込んでよい。止めるのは、いま拠点の上に
  // 立っているとき — 自軍が保持している拠点か、占領を命じられた拠点のどちらか
  const sqC = centroid(idx.bySquad.get(`${sq.side}:${sq.squadId}`) ?? []);
  const near = (o: { pos: Vec2; radius: number }): boolean =>
    Math.hypot(sqC.x - o.pos.x, sqC.z - o.pos.z) < o.radius + FLANK.HOLD_RADIUS;
  const standingOn =
    world.objectives.find((o) => o.owner === sq.side && near(o)) ??
    (occupy !== null && near(occupy) ? occupy : null);
  const threatAwayFromObjective =
    standingOn !== null &&
    Math.hypot(threat.pos.x - standingOn.pos.x, threat.pos.z - standingOn.pos.z) >
      FLANK.HOLD_LEASH;
  if (threatAwayFromObjective || farThreat) return;
  if (plan.done) {
    manFt.flankDone = true;
  } else {
    manFt.flankGoal = flankWaypoint(
      threat.pos,
      baseC,
      manC,
      plan.dir,
      flankRadius(threat.pos, manC, FLANK.SQUAD_RADIUS),
    );
  }
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
 * 個体差パラメータ(積極性・大胆さ)による分岐は未実装(docs/ロードマップ.md C-4)。
 *
 * @returns 突入を指示したら true(通常の火力/機動の割り当てを上書きする)
 */
function directBuildingAssault(world: World, sq: SquadState, idx: LivingIndex): boolean {
  if (world.buildings.length === 0) return false;

  const fireteams = world.fireteams.filter(
    (f) => f.side === sq.side && f.squadId === sq.squadId,
  );
  if (fireteams.length === 0) return false;

  const members = idx.bySquad.get(`${sq.side}:${sq.squadId}`) ?? [];
  if (members.length === 0) return false;
  const from = centroid(members);

  const alive = fireteams.filter(
    (ft) => (idx.byFt.get(`${ft.side}:${ft.squadId}:${ft.ftIndex}`) ?? []).length > 0,
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
  const occupants = members.map((m) => m.pos);
  let door: Door | null = null;
  for (const aim of aims) {
    // `[v6.2]` 掃討済みの扉を除いて選ばせる。中廊下+区画の建物では、これで
    // 廊下 → 区画1 → 区画2 … と部屋を1つずつ潰していく動きになる(仕様 §7.2)
    const d = selectAssaultDoor(world.buildings, from, aim, sq.clearedDoorIds, occupants);
    if (d) {
      door = d;
      break;
    }
  }
  if (!door) {
    for (const ft of fireteams) if (ft.cqbDoorId !== null) exitCqb(ft);
    return false;
  }

  // `[v6.3]` 突入が決まったこの時点で、その建物の屋内ナビグリッドを張る。
  // 全棟ぶんを常時持つと市街地マップでノード数が破綻するため、遅延して作る。
  activateBuildingNav(world, door.buildingId);

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

/**
 * 生存者を (陣営, 分隊) と (陣営, 分隊, FT) で索引する。`[v6.3]`
 *
 * 分隊AIは1回の判断で `world.soldiers.filter` を10箇所近く回しており、
 * 兵士224名 × 分隊24個 で判断周期ごとに数十万回の走査になっていた
 * (盤面2倍のあと、ティック時間の主要因のひとつ)。1回だけ索引を作って使い回す。
 */
function indexLiving(world: World): {
  bySquad: Map<string, Soldier[]>;
  byFt: Map<string, Soldier[]>;
} {
  const bySquad = new Map<string, Soldier[]>();
  const byFt = new Map<string, Soldier[]>();
  for (const s of world.soldiers) {
    if (s.status !== "ok") continue;
    const k = `${s.side}:${s.squadId}`;
    const a = bySquad.get(k);
    if (a) a.push(s);
    else bySquad.set(k, [s]);
    if (s.fireteamId < 0) continue;
    const k2 = `${k}:${s.fireteamId}`;
    const b = byFt.get(k2);
    if (b) b.push(s);
    else byFt.set(k2, [s]);
  }
  return { bySquad, byFt };
}

export function squadAI(world: World): void {
  const decidedThisTick = new Set<number>();
  const idx = indexLiving(world);

  for (const sq of world.squads) {
    // 人間が操作している分隊長のAIは止める(仕様 §4)
    if (aiSuppressed(world, "squad", sq.side, sq.squadId)) continue;
    // 指揮継承直後は判断周期が伸びる(仕様 §12: 命令解釈の冗長化・新規戦術判断不可)
    const factor = commandFactor(sq, world.tick, "squad");
    // ドクトリンで判断周期が変わる(仕様 §13)。自律群は分隊だけ速い `[v6.8]`
    const squadDecideMul = sideDoctrine(world, sq.side).decideMul.squad;
    if (
      world.tick - sq.lastDecisionTick <
      Math.round((DECIDE_EVERY_TICKS * squadDecideMul) / factor)
    ) {
      continue;
    }
    sq.lastDecisionTick = world.tick;
    decidedThisTick.add(sq.squadId);

    directFireteams(world, sq, idx);
    // 建物のバトルドリル(仕様 §7.2)は通常の火力/機動の割り当てより優先する。
    // 建物へ突入する局面では、屋外の側面攻撃ではなく突入と支援の分担が正しい。
    // ただし踏み込まない任務(support_by_fire / screen)では突入しない。
    if (sq.mission.kind === "seize") directBuildingAssault(world, sq, idx);
    decideCasevac(world, sq);
    // `[v7.2]` 煙で隠して渡る(ロードマップ S-2)。判断は分隊長の belief だけで行う
    decideSmoke(world, sq);
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
