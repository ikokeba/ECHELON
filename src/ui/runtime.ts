/**
 * ランタイムドライバ: World・レンダラ・シムクロックを保持し、requestAnimationFrame
 * ループの中で結びつける。**描画レートと固定シムレートが出会う唯一の場所**。
 * rAF / performance.now / DOM に触れるため、sim/ ではなく ui/ に置いている。
 */

import { createRenderer, type Renderer } from "@render/renderer.ts";
import { createSimClock, drainTicks, renderAlpha, requestSteps, setSpeed } from "@sim/loop.ts";
import { stepWorld } from "@sim/step.ts";
import { createWorld, sideDoctrine, type World } from "@sim/world.ts";
import { SCENARIOS, type ScenarioKey } from "@sim/scenario.ts";
import { resolveView, type ViewResult } from "@sim/viewpoint.ts";
import { controlledSoldierId, swapTo } from "@sim/control.ts";
import {
  orderControlledTo,
  orderFireMission,
  orderReinforcement,
  orderSmoke,
  orderHold,
  orderAntiArmor,
  orderDrone,
} from "@sim/playerOrders.ts";
import { SMOKE_BLOCK_TEXT, smokeCooldownLeft, smokeThrower } from "@sim/systems/smoke.ts";
import { DRONE_BLOCK_TEXT } from "@sim/systems/drone.ts";
import {
  ANTI_ARMOR_BLOCK_TEXT,
  antiArmorCooldownLeft,
  antiArmorRoundsOf,
  gunnerOf,
} from "@sim/systems/antiArmor.ts";
import { applyReplay, replayCursor, startRecording, type ReplayCursor } from "@sim/replay.ts";
import { aarDue, captureAarFrame, type AarFrame } from "@sim/aar.ts";
import {
  DEFENSE_SPOT_TEXT,
  defenseIndexOf,
  moveDefensivePosition,
} from "@sim/c2/defense.ts";
import {
  FIRE_MISSION_BLOCK_TEXT,
  fireMissionCooldownLeft,
  mortarMagazine,
} from "@sim/systems/indirect.ts";
import { reinforcementsLeft, topCommandOf } from "@sim/systems/reinforcement.ts";
import { isOffField } from "@sim/systems/litter.ts";
import { MORTAR, SIM_DT, SIM_HZ, SMOKE } from "@sim/constants.ts";
import { isDegraded } from "@sim/c2/succession.ts";
import { applyDeployment, defaultDeploymentOf } from "@sim/deployment.ts";
import { beginBattle, beginPlanning, platoonName } from "@sim/c2/planning.ts";
import { editPlan, PLAN_EDIT_BLOCK_TEXT } from "@sim/c2/planEdit.ts";
import { doctrineOf } from "@sim/doctrine.ts";
import type { PlanRouteView } from "@render/renderer.ts";
import { createLlmSession, type LlmSession } from "../llm/session.ts";
import { createLmStudioAgent } from "../llm/lmstudio.ts";
import { ruleAgent } from "../llm/agent.ts";
import { useLlmStore } from "./llmStore.ts";
import type { Bounds, FxEvent, Side } from "@sim/types.ts";
import {
  currentSpeed,
  useSimStore,
  type HudSnapshot,
  type PlanArm,
  type PlanView,
  type RosterCompany,
  type RosterPlatoon,
  type ThinkingSnapshot,
} from "./store.ts";

/** ui.tuning / ui.posture(表示用の単位)を world 側(rad など)へ毎フレーム反映する。 */
function syncTuning(world: World): void {
  const { tuning, posture } = useSimStore.getState();
  world.tuning.detectRange = tuning.detectRange;
  world.tuning.fovHalfRad = (tuning.fovDeg * Math.PI) / 360; // 全体角 → 半角ラジアン
  world.tuning.fireAlignRad = (tuning.fireAlignDeg * Math.PI) / 180;
  world.tuning.moveSpeed = tuning.moveSpeed;
  world.tuning.turnRate = (tuning.turnRateDeg * Math.PI) / 180;
  Object.assign(world.posture.blue, posture.blue);
  Object.assign(world.posture.red, posture.red);
  // ドクトリン(仕様 §13)も同じ扱いで反映する `[v6.8]`
  const { doctrine } = useSimStore.getState();
  world.doctrine.blue = doctrineOf(doctrine.blue);
  world.doctrine.red = doctrineOf(doctrine.red);
}

const FT_MODE_LABEL: Record<string, string> = {
  ADVANCE: "前進",
  CONTACT: "交戦",
  SEARCH: "掃討",
  FALLBACK: "後退",
  CQB: "室内戦",
  ROUT: "潰走",
};
const TECHNIQUE_LABEL: Record<string, string> = {
  traveling: "前進",
  traveling_overwatch: "警戒前進",
  bounding_overwatch: "躍進前進",
};

/** ThinkingPanel 用の要約。表示側(viewSide)の全FT/分隊と、選択兵士の詳細。 */
function thinkingOf(world: World): ThinkingSnapshot {
  const ui = useSimStore.getState();
  const side = ui.viewSide;
  const fireteams = world.fireteams
    .filter((f) => f.side === side)
    .sort((a, b) => a.squadId - b.squadId || a.ftIndex - b.ftIndex)
    .map((f) => ({
      label: `${f.squadId}分隊 FT${f.ftIndex}`,
      mode: FT_MODE_LABEL[f.mode] ?? f.mode,
      role: f.assignedRole === "base" ? "制圧" : f.assignedRole === "maneuver" ? "機動" : "—",
      routed: f.routedSinceTick !== null,
    }));
  const squads = world.squads
    .filter((s) => s.side === side)
    .sort((a, b) => a.squadId - b.squadId)
    .map((s) => ({
      label: `${s.squadId}分隊`,
      technique: TECHNIQUE_LABEL[s.technique] ?? s.technique,
      cqb: s.assaultDoorId !== null,
      degraded: s.degradedSinceTick !== null,
    }));

  // 受信した臨時報告(`[v7.3]` A-8)。その陣営の小隊長・中隊長が受け取ったもの
  const FLASH_JP = { contact: "接敵", commander: "指揮官交代", rout: "潰走" } as const;
  const flashes = world.flashLog
    .filter((f) => f.side === side)
    .slice(0, 5)
    .map((f) => ({
      key: `${f.tick}:${f.fromEchelon}:${f.fromUnitId}`,
      from: `${f.fromUnitId}${f.fromEchelon === "squad" ? "分隊" : "小隊"}`,
      what: f.reasons.map((r) => FLASH_JP[r]).join("・"),
      agoSec: Math.round((world.tick - f.tick) / SIM_HZ),
    }));

  let selected: ThinkingSnapshot["selected"] = null;
  const sid = ui.selectedSoldierId;
  if (sid != null) {
    const s = world.soldierById.get(sid);
    if (s) {
      selected = {
        id: s.id,
        side: s.side,
        role: s.role,
        hqRole: s.hqRole,
        order: s.order.kind,
        hasTarget: s.order.target !== undefined,
        sees: s.sees.length,
        observed: s.observedByEnemy,
        suppressed: s.suppressedUntilTick > world.tick,
        routed: s.routed,
        evac: s.evac,
        squadId: s.squadId,
        fireteamId: s.fireteamId,
      };
    }
  }
  // 逆襲(`[v7.3]` A-4)
  const ca = world.companies.find((c) => c.side === side && c.counterattack)?.counterattack ?? null;
  const counter = ca
    ? `${platoonName(ca.platoonId)} が ${world.objectives.find((o) => o.id === ca.objectiveId)?.label ?? "拠点"} へ逆襲中`
    : null;
  return { fireteams, squads, flashes, counter, selected };
}

/**
 * 作戦立案フェーズの表示データ(`[v6.5]`)。
 *
 * 見せるのは**表示している陣営の作戦だけ**。敵の作戦は敵の中隊長の頭の中にある
 * ものなので、神視点(仕様 §5 のデバッグ表示)を選んだときにだけ両陣営を出す。
 */
function planViewsOf(world: World, side: Side, truth: boolean): {
  plans: PlanView[];
  routes: PlanRouteView[];
} {
  const plans: PlanView[] = [];
  const routes: PlanRouteView[] = [];
  for (const co of world.companies) {
    if (!co.plan) continue;
    if (!truth && co.side !== side) continue;
    plans.push({
      side: co.side,
      intent: co.plan.intent,
      // 命令書の読み順に並べる: 主攻 → 助攻 → 予備、同順位なら小隊番号順
      tasks: [...co.plan.tasks]
        .sort(
          (a, b) =>
            (a.role === "main" ? 0 : a.role === "supporting" ? 1 : 2) -
              (b.role === "main" ? 0 : b.role === "supporting" ? 1 : 2) ||
            a.platoonId - b.platoonId,
        )
        .map((t) => ({
          key: `${co.side}:${t.platoonId}`,
          name: platoonName(t.platoonId),
          role: t.role,
          missionKind: t.mission.kind,
          order: t.order,
          platoonId: t.platoonId,
          objectiveId: t.objectiveId,
          startSec: t.startSec ?? 0,
          via: (t.via ?? []).map((p) => ({ ...p })),
        })),
      // 書き換え(`[v7.3]` A-1)の材料
      mainObjectiveId: co.plan.mainObjectiveId,
      phaseLine: co.plan.phaseLine ? [{ ...co.plan.phaseLine[0] }, { ...co.plan.phaseLine[1] }] : null,
      fires: (co.plan.fires ?? []).map((f) => ({ target: { ...f.target }, atSec: f.atSec })),
      objectives: world.objectives.map((o) => ({ id: o.id, label: o.label })),
      edited: co.plan.edited === true,
      // 防衛陣地(`[v7.2]` S-1)。種類ごとの通し番号で呼ぶ
      defense: (() => {
        const n = { mg: 0, fighting: 0, alternate: 0, wire: 0, forward: 0, ambush: 0 };
        const name = {
          mg: "機関銃",
          fighting: "射撃壕",
          alternate: "予備陣地",
          wire: "鉄条網",
          forward: "前進陣地",
          ambush: "待ち伏せ",
        };
        return world.defense
          .filter((p) => p.side === co.side)
          .map((p) => ({
            id: p.id,
            kind: p.kind,
            label: `${name[p.kind]} ${++n[p.kind]}`,
            objective: world.objectives.find((o) => o.id === p.objectiveId)?.label ?? "",
          }));
      })(),
    });
    // 調整線・射撃計画(`[v7.3]` A-1)
    if (co.plan.phaseLine) {
      routes.push({
        key: `${co.side}:pl`,
        side: co.side,
        main: false,
        points: [{ ...co.plan.phaseLine[0] }, { ...co.plan.phaseLine[1] }],
        kind: "line",
      });
    }
    (co.plan.fires ?? []).forEach((f, i) => {
      routes.push({ key: `${co.side}:fire${i}`, side: co.side, main: false, points: [{ ...f.target }], kind: "fire" });
    });
    for (const t of co.plan.tasks) {
      routes.push({
        key: `${co.side}:${t.platoonId}`,
        side: co.side,
        main: t.role === "main",
        points: t.route.map((p) => ({ ...p })),
      });
    }
  }
  // 自陣営を先に並べる(神視点で敵の作戦が上に来ると読み違える)
  plans.sort((a, b) => (a.side === side ? -1 : 0) - (b.side === side ? -1 : 0));
  return { plans, routes };
}

/** 経由点・調整線を置いている途中の線を、作戦の経路の上に重ねる(`[v7.3]` A-1) */
function withArmPreview(routes: PlanRouteView[], arm: PlanArm | null): PlanRouteView[] {
  if (!arm) return routes;
  if (arm.kind === "via" && arm.points.length > 0) {
    return [...routes, { key: "arm", side: arm.side, main: false, points: arm.points, kind: "line" }];
  }
  if (arm.kind === "line" && arm.first) {
    return [...routes, { key: "arm", side: arm.side, main: false, points: [arm.first], kind: "fire" }];
  }
  return routes;
}

/** 階層ツリーの隊員の職の略称(`[v7.3]` A-7) */
const ROLE_SHORT: Record<string, string> = {
  leader: "TL",
  saw: "SAW",
  grenadier: "GR",
  rifleman: "R",
  mg: "MG",
  shield: "盾",
};

/** 階層ツリー用の編成一覧を組み立てる。損耗を反映するため定期的に更新する。 */
function rosterOf(world: World): RosterCompany[] {
  const out: RosterCompany[] = [];
  for (const co of world.companies) {
    const platoons: RosterPlatoon[] = world.platoons
      .filter((p) => p.side === co.side && p.companyId === co.companyId)
      .map((pl) => {
        const squads = world.squads
          .filter((s) => s.side === pl.side && s.platoonId === pl.platoonId)
          .map((sq) => {
            const men = world.soldiers.filter(
              (s) => s.side === sq.side && s.squadId === sq.squadId,
            );
            // FTと隊員(`[v7.3]` A-7)。分隊長枠(fireteamId < 0)は分隊のノードが受け持つ
            const ftIdx = [...new Set(men.filter((m) => m.fireteamId >= 0).map((m) => m.fireteamId))];
            ftIdx.sort((a, b) => a - b);
            const fireteams = ftIdx.map((fi) => {
              const team = men.filter((m) => m.fireteamId === fi && m.status !== "kia" && !isOffField(m));
              const leader = team.find((m) => m.isFireteamLeader && m.status === "ok");
              return {
                ftIndex: fi,
                leaderId: leader?.id ?? null,
                members: team.map((m) => ({
                  id: m.id,
                  label: ROLE_SHORT[m.role] ?? m.role,
                  ok: m.status === "ok",
                })),
              };
            });
            return {
              squadId: sq.squadId,
              commanderId: sq.commanderId,
              effective: men.filter((s) => s.status === "ok").length,
              total: men.length,
              degraded: isDegraded(sq),
              fireteams,
            };
          });
        // 小隊本部も戦力として数える(仕様 §2)
        const hq = world.soldiers.filter(
          (s) => s.side === pl.side && s.platoonId === pl.platoonId && s.hqRole !== null,
        );
        return {
          side: pl.side,
          platoonId: pl.platoonId,
          // 本部要員を1人でも編成に持っていれば指揮ノードとして実在する(`[v6.9]`)。
          // 戦死者も数えるので、全滅しても階層が消えたりはしない
          structural: hq.length > 0,
          commanderId: pl.commanderId,
          effective:
            squads.reduce((a, s) => a + s.effective, 0) +
            hq.filter((s) => s.status === "ok").length,
          total: squads.reduce((a, s) => a + s.total, 0) + hq.length,
          degraded: isDegraded(pl),
          squads,
        };
      });
    // 迫撃砲(`[v6.9]`)。保有数はドクトリンの `fireSupport` に掛かる
    const mortarTotal = Math.round(
      MORTAR.ROUNDS_PER_COMPANY * sideDoctrine(world, co.side).fireSupport,
    );
    const flying = world.fireMissions.filter(
      (m) => m.side === co.side && m.companyId === co.companyId,
    );
    const eta = flying.length ? flying[0]!.nextImpactTick - world.tick : null;

    const coHq = world.soldiers.filter(
      (s) => s.side === co.side && s.companyId === co.companyId && s.platoonId < 0,
    );
    out.push({
      side: co.side,
      companyId: co.companyId,
      structural: coHq.length > 0,
      commanderId: co.commanderId,
      effective:
        platoons.reduce((a, p) => a + p.effective, 0) +
        coHq.filter((s) => s.status === "ok").length,
      total: platoons.reduce((a, p) => a + p.total, 0) + coHq.length,
      degraded: isDegraded(co),
      assetsBusy: co.assets.filter((a) => a.arriveTick !== null).length,
      assetsTotal: co.assets.length,
      mortarLeft: mortarTotal - co.mortarRoundsUsed,
      mortarTotal,
      mortarEtaSec: eta === null ? null : Math.max(0, eta / SIM_HZ),
      platoons,
    });
  }
  return out;
}

/** 後援部隊の表示(`[v7.0]`) */
function reinforcementHud(world: World, side: Side): HudSnapshot["reinforcement"][Side] {
  const r = world.reinforcement[side];
  if (!r.spec) return null;
  const top = topCommandOf(world, side);
  const c = world.control;
  const next = r.pending[0];
  return {
    callsLeft: reinforcementsLeft(world, side),
    calls: r.spec.calls,
    size: r.spec.size,
    etaSec: next ? Math.max(0, (next.arriveTick - world.tick) * SIM_DT) : null,
    progress: next
      ? Math.min(1, (world.tick - next.calledTick) / Math.max(1, next.arriveTick - next.calledTick))
      : null,
    arrived: r.arrived,
    canCall:
      top !== null && c !== null && c.side === side && c.echelon === top.echelon && c.unitId === top.unitId,
  };
}

/** 迫撃砲の表示(`[v7.2]`)。中隊が無い・火力支援を持たない陣営は null */
function fireSupportHud(world: World, side: Side): HudSnapshot["fireSupport"][Side] {
  const co = world.companies.find((c) => c.side === side);
  if (!co || sideDoctrine(world, side).fireSupport <= 0) return null;
  const total = mortarMagazine(world, co);
  const flying = world.fireMissions.find((m) => m.side === side && m.companyId === co.companyId);
  const c = world.control;
  return {
    roundsLeft: Math.max(0, total - co.mortarRoundsUsed),
    roundsTotal: total,
    cooldownSec: fireMissionCooldownLeft(world, co) * SIM_DT,
    etaSec: flying ? Math.max(0, (flying.nextImpactTick - world.tick) * SIM_DT) : null,
    canCall:
      c !== null && c.side === side && c.echelon === "company" && c.unitId === co.companyId,
  };
}

/** 発煙弾の表示(`[v7.2]`)。人間が分隊長を操作しているときだけ */
function smokeHud(world: World): HudSnapshot["smoke"] {
  const c = world.control;
  if (!c || c.echelon !== "squad") return null;
  const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
  if (!sq) return null;
  return {
    left: sq.smokes,
    total: SMOKE.PER_SQUAD,
    cooldownSec: smokeCooldownLeft(world, sq) * SIM_DT,
    canThrow: smokeThrower(world, sq) !== null,
  };
}

/** 対戦車・対構造物火器の表示(`[v7.3]` A-3)。人間が分隊長を操作していて、分隊に射手がいるときだけ */
function antiArmorHud(world: World): HudSnapshot["antiArmor"] {
  const c = world.control;
  if (!c || c.echelon !== "squad") return null;
  const sq = world.squads.find((s) => s.side === c.side && s.squadId === c.unitId);
  if (!sq) return null;
  if (!world.soldiers.some((s) => s.side === sq.side && s.squadId === sq.squadId && s.quals.antiArmor)) return null;
  return {
    left: antiArmorRoundsOf(world, sq),
    cooldownSec: antiArmorCooldownLeft(world, sq) * SIM_DT,
    canFire: gunnerOf(world, sq) !== null,
  };
}

const DRONE_STATE_JP: Record<string, string> = {
  ready: "待機",
  flying: "飛行中",
  returning: "帰還中",
  swapping: "電池交換",
  lost: "喪失",
  spent: "電池切れ",
};

/** 観測ドローンの表示(`[v7.3]` A-2)。人間が中隊長を操作していて、中隊がドローンを持つときだけ */
function droneHud(world: World): HudSnapshot["drone"] {
  const c = world.control;
  if (!c || c.echelon !== "company") return null;
  const d = world.drones.find((x) => x.side === c.side && x.companyId === c.unitId);
  if (!d) return null;
  return {
    state: DRONE_STATE_JP[d.state] ?? d.state,
    batteriesLeft: d.batteriesLeft,
    flightSec: d.state === "flying" || d.state === "returning" ? d.flightTicksLeft * SIM_DT : null,
    canTask: d.state === "ready" || d.state === "flying",
  };
}

function hudOf(world: World, view: ViewResult): HudSnapshot {
  let blueAlive = 0;
  let redAlive = 0;
  let blueEffective = 0;
  let redEffective = 0;
  let blueEvacuated = 0;
  let redEvacuated = 0;
  let blueAwaitingEvac = 0;
  let redAwaitingEvac = 0;
  let blueCarrying = 0;
  let redCarrying = 0;
  let blueTotal = 0;
  let redTotal = 0;
  for (const s of world.soldiers) {
    const alive = s.status !== "kia";
    const effective = s.status === "ok";
    const evacuated = isOffField(s);
    // 後送を待っている = 倒れていて、まだCCPへ届いていない(仕様 §9)
    const awaiting = s.status === "wia" && !evacuated;
    const carrying = s.evac === "carrying";
    if (s.side === "blue") {
      blueTotal++;
      if (alive) blueAlive++;
      if (effective) blueEffective++;
      if (evacuated) blueEvacuated++;
      if (awaiting) blueAwaitingEvac++;
      if (carrying) blueCarrying++;
    } else {
      redTotal++;
      if (alive) redAlive++;
      if (effective) redEffective++;
      if (evacuated) redEvacuated++;
      if (awaiting) redAwaitingEvac++;
      if (carrying) redCarrying++;
    }
  }
  return {
    tick: world.tick,
    simSeconds: world.tick * SIM_DT,
    blueAlive,
    redAlive,
    blueTotal,
    redTotal,
    blueEffective,
    redEffective,
    knownContacts: view.known,
    staleContacts: view.stale,
    blueEvacuated,
    redEvacuated,
    blueAwaitingEvac,
    redAwaitingEvac,
    blueCarrying,
    redCarrying,
    battleMode: world.mode,
    attacker: world.attacker,
    timeLeftSec:
      world.timeLimitTicks > 0
        ? Math.max(0, (world.timeLimitTicks - world.tick) * SIM_DT)
        : null,
    objectives: world.objectives.map((o) => ({
      id: o.id,
      label: o.label,
      owner: o.owner,
      progress: o.progress,
      contested: o.contested,
    })),
    victory: world.victory,
    reinforcement: { blue: reinforcementHud(world, "blue"), red: reinforcementHud(world, "red") },
    fireSupport: { blue: fireSupportHud(world, "blue"), red: fireSupportHud(world, "red") },
    smoke: smokeHud(world),
    antiArmor: antiArmorHud(world),
    drone: droneHud(world),
  };
}

/**
 * LLM の座席(`[v7.0]`)を設定どおりに張る・外す。返すのは張ったセッション(無ければ null)。
 * 設定(`useLlmStore`)が変わったときだけ呼ばれる。
 */
function openLlmSession(world: World): LlmSession | null {
  const { config, setStatus } = useLlmStore.getState();
  if (!config.enabled) return null;
  const ids =
    config.echelon === "company"
      ? world.companies.filter((c) => c.side === config.side).map((c) => c.companyId)
      : config.echelon === "platoon"
        ? world.platoons.filter((p) => p.side === config.side).map((p) => p.platoonId)
        : world.squads.filter((s) => s.side === config.side).map((s) => s.squadId);
  const unitId = ids[config.unitIndex];
  if (unitId === undefined) {
    setStatus({
      error: `この盤面の${config.side === "blue" ? "青" : "赤"}には、その座席の部隊が ${ids.length} 個しかない`,
      busy: false,
    });
    return null;
  }
  const agent = config.useLlm
    ? createLmStudioAgent({
        baseUrl: config.baseUrl,
        ...(config.model.trim() ? { model: config.model.trim() } : {}),
      })
    : ruleAgent();
  const session = createLlmSession({
    seat: { side: config.side, echelon: config.echelon, unitId },
    agent,
    intervalSec: config.intervalSec,
  });
  session.attach(world);
  setStatus({ agentName: agent.name, error: null, log: [], busy: false });
  return session;
}

/**
 * 振り返り(AAR、`[v7.2]` S-4)のフレーム。ランタイムが戦闘中に取り溜め、AAR パネルが読む。
 * 量が多いのでストア(React の状態)には載せない — パネルは開いたときにここを読む
 */
let aarFrames: AarFrame[] = [];
export function getAarFrames(): readonly AarFrame[] {
  return aarFrames;
}
/** AAR の地図に描く盤面(盤の範囲と建物の外周)。世界を作るたびに入れ替わる */
let aarMap: { bounds: Bounds; buildings: Bounds[] } | null = null;
export function getAarMap(): { bounds: Bounds; buildings: Bounds[] } | null {
  return aarMap;
}

export function startRuntime(canvas: HTMLCanvasElement, scenarioKey: ScenarioKey): () => void {
  // `[v6.4]` 配置プランを適用してから世界を作る。未設定なら既定のシナリオそのまま。
  // 既定値を編集の出発点としてストアへ返し、パネルがそこから触れるようにする。
  // `[v6.9]` 編成は世界の**構造**なので、毎フレーム反映する tuning/doctrine と違い、
  // 生成のときにだけ読む。変更すると `deploymentNonce` が動いてここから作り直される。
  const base = SCENARIOS[scenarioKey].make(
    useSimStore.getState().seed,
    useSimStore.getState().force,
  );
  useSimStore.getState().initDeployment(defaultDeploymentOf(base));
  const plan = useSimStore.getState().deployment;
  const world = createWorld(plan ? applyDeployment(base, plan) : base);
  const renderer: Renderer = createRenderer(canvas, world);
  const clock = createSimClock(currentSpeed(useSimStore.getState()));

  // `[v6.5]` 世界を作ったら、まず**作戦立案フェーズ**に入る。中隊長が拠点に対する
  // 計画を立て、プレイヤーがそれを読んで「戦闘開始」を押すまで時間は流れない
  // (仕様 §3① / §11 — 米陸軍の指揮活動手順 TLP に対応)。
  beginPlanning(world);

  // ── 振り返り・リプレイ(`[v7.2]` S-4)──
  // 記録は常に取る(命令と設定の変化だけなので軽い)。「最初から再生」が押されて作り直した
  // ときは、同じ初期条件の世界へ記録を流し込みながら進め、記録の終わりで操作を返す。
  // 再生しながらも記録するので、返したあとに遊び続けても記録は途切れない。
  startRecording(world);
  aarFrames = [];
  aarMap = { bounds: { ...world.bounds }, buildings: world.buildings.map((b) => ({ ...b.bounds })) };
  const st0 = useSimStore.getState();
  const replaySrc =
    st0.replay && st0.replay.key === `${st0.scenarioKey}|${st0.deploymentNonce}|${st0.seed}`
      ? st0.replay
      : null;
  if (st0.replay && !replaySrc) st0.endReplay();
  const replay: ReplayCursor | null = replaySrc ? replayCursor(replaySrc.log) : null;
  const replayEnd = replaySrc ? replaySrc.endTick : 0;
  if (replay) beginBattle(world);
  {
    const ui0 = useSimStore.getState();
    const pv = planViewsOf(world, ui0.viewSide, ui0.viewEchelon === "truth");
    ui0.enterPlanning(pv.plans, pv.routes);
    // 再生は立案を飛ばして戦闘から始める(立案は初期条件コードに入っている)
    if (replay) ui0.startBattle();
  }
  /** 立案表示の再構築キー(視点を変えたときだけ組み直す) */
  let planViewKey = "";

  let running = true;
  let lastMs = performance.now();
  let lastStepNonce = useSimStore.getState().stepNonce;
  let lastReinforceNonce = useSimStore.getState().reinforceNonce;
  let lastReplayRequest = useSimStore.getState().replayRequestNonce;
  let hudCountdown = 0;
  let lastControl = useSimStore.getState().control;
  let lastSelected = useSimStore.getState().selectedSoldierId;
  // LLM の座席(`[v7.0]`)。世界を作り直したら(=このランタイムが起き直したら)張り直す
  let llm: LlmSession | null = null;
  let lastLlmConfig: unknown = null;
  let llmStatusKey = "";

  // 開発用の撮影フック(`[v7.3]`)。README の GIF を撮るスクリプトが、世界を読み、カメラを置き、
  // 止めたまま決まったティック数だけ進めるのに使う。本番ビルドには入らない
  if (import.meta.env.DEV) {
    (window as unknown as { __echelon?: unknown }).__echelon = {
      world,
      renderer,
      advance: (n: number) => requestSteps(clock, n),
      store: useSimStore,
    };
  }
  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);

  /**
   * 右クリックで操作中のユニットへ移動命令を出す(仕様 §6「移動命令」)。
   * ポーズ中でも発行でき、解除後にタイムラグなく実行される(仕様 §6)。
   * 発行できたら OrderToast 用に記録する(指摘: 移動命令が出せているか分からない)。
   */
  /** 再生中か(`[v7.2]` S-4)。再生中は盤面からの命令を受けない(記録が命令を出す) */
  const inReplay = (): boolean => replay !== null && world.tick < replayEnd;

  const issueMoveOrder = (clientX: number, clientY: number): void => {
    if (inReplay()) return;
    const c = world.control;
    if (!c) return;
    const p = renderer.screenToWorld(clientX, clientY);
    if (orderControlledTo(world, p)) {
      useSimStore.getState().setLastOrder({ target: p, tick: world.tick, echelon: c.echelon });
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    issueMoveOrder(e.clientX, e.clientY);
  };
  canvas.addEventListener("contextmenu", onContextMenu);

  /**
   * `[v6.18]` **タッチには右クリックが無いので、長押しを移動命令にする。**
   * 指を置いたまま `LONG_PRESS_MS` 動かさなければ発行する。少しでも動けば
   * レンダラのパン、すぐ離せば選択 — 3つが同じ指の1操作から分岐する。
   *
   * 対象は `pointerType === "touch"` だけ。マウスの長押しまで拾うと、
   * 盤面を掴んで考えているあいだに命令が飛ぶ。
   */
  const LONG_PRESS_MS = 480;
  const LONG_PRESS_SLOP = 10;
  let pressTimer: number | null = null;
  let pressX = 0;
  let pressY = 0;
  const cancelPress = (): void => {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    cancelPress();
    pressX = e.clientX;
    pressY = e.clientY;
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      issueMoveOrder(pressX, pressY);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: PointerEvent) => {
    if (pressTimer === null) return;
    if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > LONG_PRESS_SLOP) cancelPress();
  };
  canvas.addEventListener("pointerdown", onTouchDown);
  canvas.addEventListener("pointermove", onTouchMove);
  canvas.addEventListener("pointerup", cancelPress);
  canvas.addEventListener("pointercancel", cancelPress);

  /**
   * 左クリックでユニットを選択する(デバッグ表示・思考パネルの基準)。
   * レンダラのパン操作と共存させるため、ほとんど動かさずに離したときだけ選択とみなす。
   * `mousedown` + `click` を使う(`pointer*` はレンダラのパンが握っている)。
   */
  let downX = 0;
  let downY = 0;
  const onMouseDown = (e: MouseEvent) => {
    downX = e.clientX;
    downY = e.clientY;
  };
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // ドラッグはパン
    const p = renderer.screenToWorld(e.clientX, e.clientY);
    const ui = useSimStore.getState();
    // 配置エディタが有効な間は、クリックはユニット選択ではなく配置になる(`[v6.4]`)
    if (ui.setupTool) {
      ui.placeAt(p);
      return;
    }
    if (inReplay()) {
      ui.setDefenseMove(null);
      ui.arm(null);
    }
    // 作戦の書き換え(`[v7.3]` A-1)。盤面で点を選ぶもの(経由点・調整線・射撃計画)
    if (ui.planArm && world.phase === "planning") {
      const a = ui.planArm;
      const q = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
      if (a.kind === "via") {
        ui.setPlanArm({ ...a, points: [...a.points, q] });
      } else if (a.kind === "line") {
        if (!a.first) ui.setPlanArm({ ...a, first: q });
        else {
          ui.setPlanArm(null);
          ui.requestPlanEdit({ side: a.side, op: "phaseLine", line: [a.first, q] });
        }
      } else {
        ui.setPlanArm(null);
        const cur = ui.plans.find((x) => x.side === a.side)?.fires ?? [];
        const last = cur.reduce((m, f) => Math.max(m, f.atSec), 0);
        ui.requestPlanEdit({
          side: a.side,
          op: "fires",
          fires: [...cur, { target: q, atSec: last + MORTAR.COOLDOWN_SEC }],
        });
      }
      return;
    }
    // 防衛陣地の置き直し(`[v7.2]` S-1)。AIの陣地選びと同じ規則を通す
    if (ui.defenseMoveId !== null) {
      const id = ui.defenseMoveId;
      ui.setDefenseMove(null);
      const r = moveDefensivePosition(world, id, p);
      if (r.ok) {
        const d = world.defense.find((x) => x.id === id)!;
        ui.recordDefenseEdit({ side: d.side, idx: defenseIndexOf(world, id), pos: { ...d.pos } });
        ui.setLastOrderResult({ ok: true, text: `陣地を置き直した (${p.x.toFixed(0)}, ${p.z.toFixed(0)})` });
      } else {
        const why =
          r.reason === "not_planning"
            ? "置き直せるのは作戦立案中だけ"
            : r.reason === "not_your_position"
              ? "防衛側の中隊長に座ると置き直せる(階層ツリーで中隊を選ぶ)"
              : DEFENSE_SPOT_TEXT[r.reason];
        ui.setLastOrderResult({ ok: false, text: `置き直せなかった — ${why}` });
      }
      return;
    }
    // 地点命令の照準待ち(`[v7.2]`)。迫撃砲・発煙とも、AIの指揮官と同じ関数を通す(仕様 §4)
    if (ui.armed) {
      const kind = ui.armed;
      ui.arm(null);
      const at = `(${p.x.toFixed(0)}, ${p.z.toFixed(0)})`;
      if (kind === "fire") {
        const r = orderFireMission(world, p);
        ui.setLastOrderResult(
          !r
            ? { ok: false, text: "迫撃砲を要請できるのは中隊長だけ" }
            : r.ok
              ? { ok: true, text: `迫撃砲 ${r.rounds}発を要請 ${at}` }
              : { ok: false, text: `要請は通らなかった — ${FIRE_MISSION_BLOCK_TEXT[r.reason]}` },
        );
      } else if (kind === "drone") {
        // 観測ドローン(`[v7.3]` A-2)。AIの中隊長と同じ関数を通す
        const r = orderDrone(world, p);
        ui.setLastOrderResult(
          !r
            ? { ok: false, text: "ドローンを飛ばせるのは中隊長だけ" }
            : r.ok
              ? { ok: true, text: `ドローンを ${at} へ` }
              : { ok: false, text: `飛ばせない — ${DRONE_BLOCK_TEXT[r.reason]}` },
        );
      } else if (kind === "at") {
        // 対戦車・対構造物火器(`[v7.3]` A-3)。AIの射手と同じ関数を通す
        const r = orderAntiArmor(world, p);
        ui.setLastOrderResult(
          !r
            ? { ok: false, text: "対戦車火器を撃たせられるのは分隊長だけ" }
            : r.ok
              ? { ok: true, text: `対戦車火器を発射 ${at} — ${r.hit ? "命中" : "外れ"}${r.victims > 0 ? `、${r.victims}名を倒した` : ""}` }
              : { ok: false, text: `撃てなかった — ${ANTI_ARMOR_BLOCK_TEXT[r.reason]}` },
        );
      } else if (kind === "hold") {
        // 止まってその方向を警戒する(`[v7.3]` A-7)。FTリーダー・一兵卒の座席
        const ok = orderHold(world, p);
        ui.setLastOrderResult(
          ok
            ? { ok: true, text: `停止して ${at} の方向を警戒` }
            : { ok: false, text: "止まれと命じられるのはFTリーダー・一兵卒だけ" },
        );
      } else {
        const r = orderSmoke(world, p);
        ui.setLastOrderResult(
          !r
            ? { ok: false, text: "発煙弾を焚けるのは分隊長だけ" }
            : r.ok
              ? { ok: true, text: `発煙弾を焚いた ${at}` }
              : { ok: false, text: `焚けなかった — ${SMOKE_BLOCK_TEXT[r.reason]}` },
        );
      }
      useSimStore.getState().pushHud(hudOf(world, resolveView(world, {
        side: ui.viewSide,
        echelon: ui.viewEchelon,
        squadId: ui.viewSquadId,
        platoonId: ui.viewPlatoonId,
      })));
      return;
    }
    const truth = ui.viewEchelon === "truth";
    let best: number | null = null;
    let bestD = 6 * 6; // 6m 以内で最も近い1名
    for (const s of world.soldiers) {
      if (s.status === "kia" || isOffField(s)) continue;
      if (!truth && s.side !== ui.viewSide) continue;
      const d = (s.pos.x - p.x) ** 2 + (s.pos.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    ui.select(best);
  };
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("click", onClick);

  function frame(nowMs: number): void {
    if (!running) return;
    const elapsed = Math.min(250, nowMs - lastMs);
    lastMs = nowMs;

    const ui = useSimStore.getState();
    setSpeed(clock, currentSpeed(ui));
    if (ui.stepNonce !== lastStepNonce) {
      requestSteps(clock, ui.stepNonce - lastStepNonce);
      lastStepNonce = ui.stepNonce;
    }
    // 後援部隊の要請(`[v7.0]`)。AIの最上位指揮官と同じ関数を通す(仕様 §4)
    if (ui.reinforceNonce !== lastReinforceNonce) {
      lastReinforceNonce = ui.reinforceNonce;
      if (!inReplay()) orderReinforcement(world);
      useSimStore.getState().pushHud(hudOf(world, resolveView(world, {
        side: ui.viewSide,
        echelon: ui.viewEchelon,
        squadId: ui.viewSquadId,
        platoonId: ui.viewPlatoonId,
      })));
    }
    // 再生の求め(`[v7.2]` S-4)。いまの記録と時刻を渡して作り直してもらう
    if (ui.replayRequestNonce !== lastReplayRequest) {
      lastReplayRequest = ui.replayRequestNonce;
      if (world.log && world.tick > 0) ui.beginReplay([...world.log], world.tick);
    }
    const replaying = replay !== null && world.tick < replayEnd;
    if (replay && !replaying && ui.replaying) {
      // 記録の終わりに着いた。止めて操作を返す(ここから先はふつうの戦闘)
      ui.endReplay();
      if (!ui.paused) ui.togglePause();
      lastControl = world.control;
      ui.requestSwap(world.control);
    }
    // ホットスワップ要求をシムへ反映(仕様 §4: 制限なし・即時)。再生中は記録の座席に従う
    if (!replaying && ui.control !== lastControl) {
      swapTo(world, ui.control);
      lastControl = ui.control;
      // 中隊長の座席を離れたら迫撃砲の照準待ちも解く(`[v7.2]`)
      if (ui.armed) ui.arm(null);
    }
    // デバッグスライダーの値をシムへ反映(既定値なら現行挙動と一致)。再生中は記録の値に従う
    if (!replaying) syncTuning(world);

    // ── 作戦立案フェーズ(`[v6.5]`)──
    if (ui.phase === "battle" && world.phase === "planning") beginBattle(world);
    if (world.phase === "planning") {
      // 作戦の書き換え(`[v7.3]` A-1)。AI の案に重ねて作り直し、初期条件へ記録する
      const edits = ui.takePlanEdits();
      if (edits.length > 0) {
        for (const e of edits) {
          const r = editPlan(world, e);
          ui.setLastOrderResult(
            r.ok ? { ok: true, text: "作戦を書き換えた" } : { ok: false, text: `書き換えられない — ${PLAN_EDIT_BLOCK_TEXT[r.reason]}` },
          );
        }
        ui.recordPlanEdits(world.planEdits);
        planViewKey = "";
      }
      // 視点を変えたら見せる作戦も変わる(自陣営のみ / 神視点なら両陣営)
      const key = `${ui.viewSide}|${ui.viewEchelon === "truth"}`;
      if (key !== planViewKey) {
        planViewKey = key;
        const pv = planViewsOf(world, ui.viewSide, ui.viewEchelon === "truth");
        useSimStore.getState().setPlanView(pv.plans, pv.routes);
      }
      // 時間は流れない。クロックには経過を渡さず、溜まった分も捨てる
      drainTicks(clock, 0);
    }

    const ticks = world.phase === "planning" ? 0 : drainTicks(clock, elapsed);
    // `[v7.1]` 弾道表現のため、このフレームで進んだ全ティックの描画イベントを貯める
    // (world.fx はティックの頭で空になるので、最後のティックのぶんしか残らない)
    const frameFx: FxEvent[] = [];
    for (let t = 0; t < ticks; t++) {
      if (replay && world.tick >= replayEnd) break;
      if (replay) applyReplay(world, replay);
      stepWorld(world);
      for (const f of world.fx) frameFx.push(f);
      if (aarDue(world)) aarFrames.push(captureAarFrame(world));
    }

    // ── LLM の座席(`[v7.0]`)。設定が変わったら張り直し、毎フレーム問い合わせを回す ──
    // 再生中は LLM を呼ばない(LLM の命令は記録に入っている)
    const llmConfig = replaying ? null : useLlmStore.getState().config;
    if (llmConfig !== lastLlmConfig) {
      lastLlmConfig = llmConfig;
      llm?.detach(world);
      llm = openLlmSession(world);
    }
    if (llm) {
      llm.poll(world);
      const last = llm.log.at(-1);
      const key = `${llm.busy}|${last?.tick}|${last?.appliedTick}|${llm.agent.name}`;
      if (key !== llmStatusKey) {
        llmStatusKey = key;
        useLlmStore
          .getState()
          .setStatus({ busy: llm.busy, log: [...llm.log].reverse(), agentName: llm.agent.name });
      }
    }

    // 描画は「選択した階層が知っていること」だけを見る(仕様 §5)。
    // ここで ground truth を渡してしまうとプレイヤーが全知になり、階層構造が無意味になる。
    //
    // 例外は**作戦立案フェーズ**(`[v6.5]`)。ここはまだ戦闘ではなく盤面の設定で、
    // 敵の初期配置はプレイヤー自身が置いたもの。両軍を見せないと「置いたはずの敵が
    // 見えない」ことになる。**これはUI(人間の目)だけの扱い**で、中隊長AIの立案は
    // 敵情を一切参照していない(c2/planning.ts)。戦闘開始と同時に §5 の霧が戻る。
    const setupView = world.phase === "planning";
    const view = resolveView(world, {
      side: ui.viewSide,
      echelon: setupView ? "truth" : ui.viewEchelon,
      squadId: ui.viewSquadId,
      platoonId: ui.viewPlatoonId,
    });
    renderer.render(world, view, renderAlpha(clock), {
      debug: ui.debug,
      selectedId: ui.selectedSoldierId,
      controlledId: controlledSoldierId(world),
      viewSide: ui.viewSide,
      truth: setupView || ui.viewEchelon === "truth",
      // 配置エディタの計画マーカー(まだ戦闘には反映されていない)`[v6.4]`
      setup: ui.setupTool !== null || ui.deployment !== null ? ui.deploymentDraft : null,
      setupTool: ui.setupTool,
      // 立案フェーズの接近経路(`[v6.5]`)。戦闘に入ったら消える
      planRoutes: world.phase === "planning" ? withArmPreview(ui.planRoutes, ui.planArm) : null,
      hoveredPlanKey: ui.hoveredPlanKey,
      fx: frameFx,
    });

    if (ticks > 0 && (hudCountdown -= 1) <= 0) {
      useSimStore.getState().pushHud(hudOf(world, view));
      useSimStore.getState().setRoster(rosterOf(world));
      useSimStore.getState().pushThinking(thinkingOf(world));
      hudCountdown = 6;
    } else if (ui.selectedSoldierId !== lastSelected) {
      // ポーズ中でも選択が変わったら思考パネルだけは更新する
      useSimStore.getState().pushThinking(thinkingOf(world));
    }
    lastSelected = ui.selectedSoldierId;

    requestAnimationFrame(frame);
  }

  const initialUi = useSimStore.getState();
  useSimStore
    .getState()
    .pushHud(
      hudOf(
        world,
        resolveView(world, {
          side: initialUi.viewSide,
          echelon: initialUi.viewEchelon,
          squadId: initialUi.viewSquadId,
          platoonId: initialUi.viewPlatoonId,
        }),
      ),
    );
  useSimStore.getState().setRoster(rosterOf(world));
  requestAnimationFrame(frame);

  return () => {
    running = false;
    llm?.detach(world);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("contextmenu", onContextMenu);
    cancelPress();
    canvas.removeEventListener("pointerdown", onTouchDown);
    canvas.removeEventListener("pointermove", onTouchMove);
    canvas.removeEventListener("pointerup", cancelPress);
    canvas.removeEventListener("pointercancel", cancelPress);
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("click", onClick);
    renderer.dispose();
  };
}
