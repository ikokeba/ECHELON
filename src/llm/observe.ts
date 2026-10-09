/**
 * 観測の組み立て(`[v7.0]`)。座席の指揮官が**知り得ること**だけを JSON にする。
 *
 * ── 何を見てよいか(仕様 §5)──
 *   敵        : その指揮官の belief だけ。中隊・小隊は無線報告(遅れて粗い)、
 *               分隊長は麾下FTの視界の合算。`world.soldiers` から敵を拾わない
 *   麾下      : 中隊・小隊は部下からの定時報告(`*Reports`)。分隊長は自分のFTを直接見る
 *   拠点・盤面: 地図に載っているものなので誰でも見てよい
 *
 * 人間がその座席でホットスワップしたときに画面で見られる範囲と同じ、という基準。
 */

import { platoonName } from "../sim/c2/planning.ts";
import { reinforcementsLeft, topCommandOf } from "../sim/systems/reinforcement.ts";
import { isOffField } from "../sim/systems/litter.ts";
import { fireMissionCooldownLeft, mortarMagazine } from "../sim/systems/indirect.ts";
import { MORTAR, SIM_HZ, SMOKE } from "../sim/constants.ts";
import { smokeCooldownLeft, smokeThrower } from "../sim/systems/smoke.ts";
import { sideDoctrine } from "../sim/world.ts";
import type { Contact, Side, Vec2 } from "../sim/types.ts";
import type { World } from "../sim/world.ts";
import {
  PROTOCOL_VERSION,
  type AgentSeat,
  type CommandSpec,
  type Observation,
  type ObsContact,
  type ObsSubordinate,
  type RelSide,
} from "./protocol.ts";

/** 観測に載せる接触の上限。確度の高い順に切る(小さなモデルの文脈を溢れさせない) */
const MAX_CONTACTS = 24;

/** 座標を 0.1m に丸める。トークン数を抑えるためで、判断には効かない粒度 */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}
function rv(p: Vec2): Vec2 {
  return { x: r1(p.x), z: r1(p.z) };
}
function rel(own: Side, s: Side | null): RelSide | null {
  if (s === null) return null;
  return s === own ? "own" : "enemy";
}

export function squadName(squadId: number): string {
  return `${(squadId % 100) + 1}分隊`;
}

function contactsOf(world: World, belief: Iterable<Contact>): ObsContact[] {
  const list = [...belief].filter((c) => c.confidence > 0);
  list.sort((a, b) => b.confidence - a.confidence || b.lastSeenTick - a.lastSeenTick);
  return list.slice(0, MAX_CONTACTS).map((c) => ({
    pos: rv(c.pos),
    posError: r1(c.posError),
    confidence: Math.round(c.confidence * 100) / 100,
    ageSec: r1((world.tick - c.lastSeenTick) / SIM_HZ),
    ...(c.count !== undefined ? { count: c.count } : {}),
    ...(c.heard ? { heard: true } : {}),
  }));
}

/**
 * 座席の階層ごとに、出せる命令の説明。
 * 後援(`canReinforce`)と迫撃砲(`canFire`、`[v7.2]`)は持っている座席にだけ載せる
 */
export function commandSpecs(
  seat: AgentSeat,
  canReinforce = false,
  canFire = false,
  canPlan = false,
): CommandSpec[] {
  // 立案中の中隊長は作戦の書き換えだけ(`[v7.3]` A-1)。時間が止まっているので他の命令は意味が無い
  if (canPlan) return [PLAN_SPEC, { type: "hold", description: "書き換えずに AI の作戦のまま戦闘を始める" }];
  const list = baseSpecs(seat);
  const extra = [...(canFire ? [FIRE_MISSION_SPEC] : []), ...(canReinforce ? [REINFORCE_SPEC] : [])];
  if (extra.length === 0) return list;
  // hold の手前に差し込む
  return [...list.slice(0, -1), ...extra, list[list.length - 1]!];
}

const FIRE_MISSION_SPEC: CommandSpec = {
  type: "fire_mission",
  description:
    "迫撃砲の射撃を target {x,z} へ要請する(observation.fireSupport を見る)。照準点は要請時点で固定され、" +
    "飛翔時間のあいだに敵が動けば外れる。射程外・前線の近く(危険近接)・間隔が明けていないときは却下される",
};

const PLAN_SPEC: CommandSpec = {
  type: "plan",
  description:
    "立案中の作戦を書き換える(observation.plan を見る)。op=task: unit の任務を mission " +
    "(seize / support_by_fire / screen / reserve)と objective(拠点 id)に / op=main: objective を主攻に / " +
    "op=route: unit の経由点 points / op=start: unit の発進を atSec 秒後に / op=phase_line: 調整線 points(2点、空で消す)/ " +
    "op=fires: 迫撃砲の射撃計画 fires [{target,atSec}](atSec は 45 秒以上・45 秒以上あける)",
};

const REINFORCE_SPEC: CommandSpec = {
  type: "reinforce",
  description:
    "後援部隊を要請する(observation.reinforcement の callsLeft が残っているときだけ)。着くまで時間がかかる",
};

function baseSpecs(seat: AgentSeat): CommandSpec[] {
  const move: CommandSpec = {
    type: "move",
    description:
      seat.echelon === "company"
        ? "中隊全体の目標地点を変える。小隊は前進方向に直交して横に並ぶ"
        : seat.echelon === "platoon"
          ? "小隊全体の目標地点を変える。分隊は横に並ぶ"
          : "分隊を地点へ向かわせる",
  };
  const hold: CommandSpec = { type: "hold", description: "何もしない(現在の命令を続ける)" };
  if (seat.echelon === "company" || seat.echelon === "platoon") {
    return [
      move,
      {
        type: "assign",
        description:
          `麾下の${seat.echelon === "company" ? "小隊" : "分隊"}1つ(unit)に任務を下ろす。` +
          "mission: seize=地点を確保 / support_by_fire=地点へ射線の通る位置から制圧(踏み込まない) / " +
          "screen=地点を軸に薄く展開して監視",
      },
      hold,
    ];
  }
  return [
    move,
    {
      type: "smoke",
      description:
        "発煙弾を target {x,z} へ焚く(observation.smoke を見る)。煙は円の中を通る視線を遮る — " +
        "敵に見られながら開けた場所を渡るとき、敵と自分のあいだへ焚く。分隊長から throwRange m 以内だけ",
    },
    {
      type: "casevac",
      description: "止血済みの負傷者を担架で後送する(担架要員2〜4名が一時的に抜ける)",
    },
    hold,
  ];
}

/**
 * 観測を組み立てる。座席の部隊が存在しなければ null。
 * `lastResult` は前回の応答の処理結果(セッションが渡す)。
 */
export function buildObservation(
  world: World,
  seat: AgentSeat,
  lastResult: string[] = [],
): Observation | null {
  const own = seat.side;
  const objectives = world.objectives.map((o) => ({
    id: o.id,
    label: o.label,
    pos: rv(o.pos),
    radius: o.radius,
    owner: rel(own, o.owner),
    progress: Math.round(o.progress * 100) / 100,
    progressBy: rel(own, o.progressBy),
    contested: o.contested,
  }));
  // 後援部隊(`[v7.0]`)。陣営の最上位の座席だけが要請できる
  const top = topCommandOf(world, own);
  const r = world.reinforcement[own];
  const canReinforce =
    r.spec !== null && top !== null && top.echelon === seat.echelon && top.unitId === seat.unitId;
  // 迫撃砲(`[v7.2]`)。中隊長の座席で、火力支援を持つ中隊だけ
  const fireCo =
    seat.echelon === "company"
      ? world.companies.find((c) => c.side === own && c.companyId === seat.unitId)
      : undefined;
  const canFire = fireCo !== undefined && sideDoctrine(world, own).fireSupport > 0;
  const flying = fireCo
    ? world.fireMissions.find((m) => m.side === own && m.companyId === fireCo.companyId)
    : undefined;
  const planCo = seat.echelon === "company" ? fireCo : undefined;
  const plan = planCo?.plan;
  const base = {
    protocol: PROTOCOL_VERSION,
    phase: world.phase,
    ...(plan
      ? {
          plan: {
            mainObjective: plan.mainObjectiveId,
            tasks: plan.tasks.map((t) => ({
              unit: t.platoonId,
              name: platoonName(t.platoonId),
              role: t.role,
              mission: t.mission.kind,
              objective: t.objectiveId,
              startSec: t.startSec ?? 0,
              via: (t.via ?? []).map(rv),
            })),
            phaseLine: plan.phaseLine ? ([rv(plan.phaseLine[0]), rv(plan.phaseLine[1])] as [Vec2, Vec2]) : null,
            fires: (plan.fires ?? []).map((f) => ({ target: rv(f.target), atSec: f.atSec })),
          },
        }
      : {}),
    timeSec: r1(world.tick / SIM_HZ),
    tick: world.tick,
    map: {
      bounds: { ...world.bounds },
      objectives,
    },
    victory: world.victory ? (rel(own, world.victory.winner) as RelSide) : null,
    commands: commandSpecs(seat, canReinforce, canFire, world.phase === "planning" && plan !== undefined),
    lastResult,
    ...(canFire && fireCo
      ? {
          fireSupport: {
            roundsLeft: Math.max(0, mortarMagazine(world, fireCo) - fireCo.mortarRoundsUsed),
            roundsPerMission: MORTAR.ROUNDS_PER_MISSION,
            cooldownSec: r1(fireMissionCooldownLeft(world, fireCo) / SIM_HZ),
            inFlightEtaSec: flying ? r1(Math.max(0, flying.nextImpactTick - world.tick) / SIM_HZ) : null,
            commandPost: rv(fireCo.cp),
            minRange: MORTAR.MIN_RANGE,
            maxRange: MORTAR.MAX_RANGE,
            dangerClose: MORTAR.DANGER_CLOSE,
            timeOfFlightSec: r1(MORTAR.TIME_OF_FLIGHT_SEC * sideDoctrine(world, own).radioLatencyMul),
          },
        }
      : {}),
    ...(canReinforce && r.spec
      ? {
          reinforcement: {
            callsLeft: reinforcementsLeft(world, own),
            size: r.spec.size,
            delaySec: r.spec.delaySec,
            pendingEtaSec: r.pending.map((p) => r1((p.arriveTick - world.tick) / SIM_HZ)),
          },
        }
      : {}),
  } as const;

  if (seat.echelon === "company") {
    const co = world.companies.find((c) => c.side === own && c.companyId === seat.unitId);
    if (!co) return null;
    const subs: ObsSubordinate[] = [];
    for (const pl of world.platoons) {
      if (pl.side !== own || pl.companyId !== co.companyId) continue;
      const rep = co.platoonReports.get(pl.platoonId);
      const m = co.platoonMissions.get(pl.platoonId);
      subs.push({
        unit: pl.platoonId,
        kind: "platoon",
        name: platoonName(pl.platoonId),
        pos: rv(rep ? rep.pos : pl.objective),
        effective: rep ? rep.effective : 0,
        total: rep ? rep.total : 0,
        ...(m ? { mission: { kind: m.kind, target: rv(m.target) } } : {}),
        ageSec: rep ? r1((world.tick - rep.sentTick) / SIM_HZ) : -1,
      });
    }
    return {
      ...base,
      you: {
        echelon: "company",
        unit: co.companyId,
        name: "中隊長",
        commanderAlive: co.commanderId !== null,
        mission: { kind: "seize", target: rv(co.objective) },
        advanceDir: rv(co.advanceDir),
      },
      subordinates: subs,
      contacts: contactsOf(world, co.belief.values()),
    };
  }

  if (seat.echelon === "platoon") {
    const pl = world.platoons.find((p) => p.side === own && p.platoonId === seat.unitId);
    if (!pl) return null;
    const subs: ObsSubordinate[] = [];
    for (const sq of world.squads) {
      if (sq.side !== own || sq.platoonId !== pl.platoonId) continue;
      const rep = pl.squadReports.get(sq.squadId);
      const m = pl.squadMissions.get(sq.squadId);
      const weapons = world.soldiers.some(
        (s) => s.side === own && s.squadId === sq.squadId && s.role === "mg",
      );
      subs.push({
        unit: sq.squadId,
        kind: "squad",
        name: squadName(sq.squadId),
        pos: rv(rep ? rep.pos : sq.objective),
        effective: rep ? rep.effective : 0,
        total: rep ? rep.total : 0,
        ...(m ? { mission: { kind: m.kind, target: rv(m.target) } } : {}),
        ageSec: rep ? r1((world.tick - rep.sentTick) / SIM_HZ) : -1,
        ...(weapons ? { weapons: true } : {}),
      });
    }
    return {
      ...base,
      you: {
        echelon: "platoon",
        unit: pl.platoonId,
        name: platoonName(pl.platoonId),
        commanderAlive: pl.commanderId !== null,
        mission: { kind: pl.mission.kind, target: rv(pl.mission.target) },
        advanceDir: rv(pl.advanceDir),
      },
      subordinates: subs,
      contacts: contactsOf(world, pl.belief.values()),
    };
  }

  const sq = world.squads.find((s) => s.side === own && s.squadId === seat.unitId);
  if (!sq) return null;
  const subs: ObsSubordinate[] = [];
  for (const ft of world.fireteams) {
    if (ft.side !== own || ft.squadId !== sq.squadId) continue;
    const men = world.soldiers.filter(
      (s) =>
        s.side === own &&
        s.squadId === sq.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.status !== "kia" &&
        !isOffField(s),
    );
    const fit = men.filter((s) => s.status === "ok");
    const c = fit.length > 0 ? fit : men;
    const pos = c.length
      ? {
          x: c.reduce((a, s) => a + s.pos.x, 0) / c.length,
          z: c.reduce((a, s) => a + s.pos.z, 0) / c.length,
        }
      : ft.objective;
    subs.push({
      unit: ft.ftIndex,
      kind: "fireteam",
      name: ft.ftIndex === 0 ? "アルファ組" : "ブラボー組",
      pos: rv(pos),
      effective: fit.length,
      total: men.length,
      ageSec: 0,
      mode: ft.mode,
    });
  }
  const thrower = smokeThrower(world, sq);
  return {
    ...base,
    smoke: {
      left: sq.smokes,
      cooldownSec: r1(smokeCooldownLeft(world, sq) / SIM_HZ),
      thrower: thrower ? rv(thrower.pos) : null,
      throwRange: SMOKE.THROW_RANGE,
      radius: SMOKE.RADIUS,
      durationSec: SMOKE.DURATION_SEC,
      active: world.smokes.map((s) => ({
        pos: rv(s.pos),
        leftSec: r1((s.untilTick - world.tick) / SIM_HZ),
      })),
    },
    you: {
      echelon: "squad",
      unit: sq.squadId,
      name: squadName(sq.squadId),
      commanderAlive: sq.commanderId !== null,
      mission: { kind: sq.mission.kind, target: rv(sq.mission.target) },
      advanceDir: rv(sq.advanceDir),
    },
    subordinates: subs,
    contacts: contactsOf(world, sq.belief.values()),
  };
}
