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
import { orderControlledTo } from "@sim/playerOrders.ts";
import { isOffField } from "@sim/systems/litter.ts";
import { MORTAR, SIM_DT, SIM_HZ } from "@sim/constants.ts";
import { isDegraded } from "@sim/c2/succession.ts";
import { applyDeployment, defaultDeploymentOf } from "@sim/deployment.ts";
import { beginBattle, beginPlanning, platoonName } from "@sim/c2/planning.ts";
import { doctrineOf } from "@sim/doctrine.ts";
import type { PlanRouteView } from "@render/renderer.ts";
import type { Side } from "@sim/types.ts";
import {
  currentSpeed,
  useSimStore,
  type HudSnapshot,
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
  return { fireteams, squads, selected };
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
        })),
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
            return {
              squadId: sq.squadId,
              commanderId: sq.commanderId,
              effective: men.filter((s) => s.status === "ok").length,
              total: men.length,
              degraded: isDegraded(sq),
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
  };
}

export function startRuntime(canvas: HTMLCanvasElement, scenarioKey: ScenarioKey): () => void {
  // `[v6.4]` 配置プランを適用してから世界を作る。未設定なら既定のシナリオそのまま。
  // 既定値を編集の出発点としてストアへ返し、パネルがそこから触れるようにする。
  // `[v6.9]` 編成は世界の**構造**なので、毎フレーム反映する tuning/doctrine と違い、
  // 生成のときにだけ読む。変更すると `deploymentNonce` が動いてここから作り直される。
  const base = SCENARIOS[scenarioKey].make(undefined, useSimStore.getState().force);
  useSimStore.getState().initDeployment(defaultDeploymentOf(base));
  const plan = useSimStore.getState().deployment;
  const world = createWorld(plan ? applyDeployment(base, plan) : base);
  const renderer: Renderer = createRenderer(canvas, world);
  const clock = createSimClock(currentSpeed(useSimStore.getState()));

  // `[v6.5]` 世界を作ったら、まず**作戦立案フェーズ**に入る。中隊長が拠点に対する
  // 計画を立て、プレイヤーがそれを読んで「戦闘開始」を押すまで時間は流れない
  // (仕様 §3① / §11 — 米陸軍の指揮活動手順 TLP に対応)。
  beginPlanning(world);
  {
    const ui0 = useSimStore.getState();
    const pv = planViewsOf(world, ui0.viewSide, ui0.viewEchelon === "truth");
    ui0.enterPlanning(pv.plans, pv.routes);
  }
  /** 立案表示の再構築キー(視点を変えたときだけ組み直す) */
  let planViewKey = "";

  let running = true;
  let lastMs = performance.now();
  let lastStepNonce = useSimStore.getState().stepNonce;
  let hudCountdown = 0;
  let lastControl = useSimStore.getState().control;
  let lastSelected = useSimStore.getState().selectedSoldierId;

  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);

  /**
   * 右クリックで操作中のユニットへ移動命令を出す(仕様 §6「移動命令」)。
   * ポーズ中でも発行でき、解除後にタイムラグなく実行される(仕様 §6)。
   * 発行できたら OrderToast 用に記録する(指摘: 移動命令が出せているか分からない)。
   */
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const c = world.control;
    if (!c) return;
    const p = renderer.screenToWorld(e.clientX, e.clientY);
    if (orderControlledTo(world, p)) {
      useSimStore.getState().setLastOrder({ target: p, tick: world.tick, echelon: c.echelon });
    }
  };
  canvas.addEventListener("contextmenu", onContextMenu);

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
    // ホットスワップ要求をシムへ反映(仕様 §4: 制限なし・即時)
    if (ui.control !== lastControl) {
      swapTo(world, ui.control);
      lastControl = ui.control;
    }
    // デバッグスライダーの値をシムへ反映(既定値なら現行挙動と一致)
    syncTuning(world);

    // ── 作戦立案フェーズ(`[v6.5]`)──
    if (ui.phase === "battle" && world.phase === "planning") beginBattle(world);
    if (world.phase === "planning") {
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
    for (let t = 0; t < ticks; t++) stepWorld(world);

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
      planRoutes: world.phase === "planning" ? ui.planRoutes : null,
      hoveredPlanKey: ui.hoveredPlanKey,
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
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("click", onClick);
    renderer.dispose();
  };
}
