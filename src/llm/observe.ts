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

import { SIM_HZ } from "../sim/constants.ts";
import { platoonName } from "../sim/c2/planning.ts";
import { reinforcementsLeft, topCommandOf } from "../sim/systems/reinforcement.ts";
import { isOffField } from "../sim/systems/litter.ts";
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
  }));
}

/** 座席の階層ごとに、出せる命令の説明 */
export function commandSpecs(seat: AgentSeat, canReinforce = false): CommandSpec[] {
  const list = baseSpecs(seat);
  if (!canReinforce) return list;
  // hold の手前に差し込む
  return [...list.slice(0, -1), REINFORCE_SPEC, list[list.length - 1]!];
}

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
  const base = {
    protocol: PROTOCOL_VERSION,
    timeSec: r1(world.tick / SIM_HZ),
    tick: world.tick,
    map: {
      bounds: { ...world.bounds },
      objectives,
    },
    victory: world.victory ? (rel(own, world.victory.winner) as RelSide) : null,
    commands: commandSpecs(seat, canReinforce),
    lastResult,
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
  return {
    ...base,
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
