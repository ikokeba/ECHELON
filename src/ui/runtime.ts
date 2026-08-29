/**
 * ランタイムドライバ: World・レンダラ・シムクロックを保持し、requestAnimationFrame
 * ループの中で結びつける。**描画レートと固定シムレートが出会う唯一の場所**。
 * rAF / performance.now / DOM に触れるため、sim/ ではなく ui/ に置いている。
 */

import { createRenderer, type Renderer } from "@render/renderer.ts";
import { createSimClock, drainTicks, renderAlpha, requestSteps, setSpeed } from "@sim/loop.ts";
import { stepWorld } from "@sim/step.ts";
import { createWorld, type World } from "@sim/world.ts";
import { SCENARIOS, type ScenarioKey } from "@sim/scenario.ts";
import { resolveView, type ViewResult } from "@sim/viewpoint.ts";
import { controlledSoldierId, swapTo } from "@sim/control.ts";
import { orderControlledTo } from "@sim/playerOrders.ts";
import { isOffField } from "@sim/systems/litter.ts";
import { SIM_DT } from "@sim/constants.ts";
import { isDegraded } from "@sim/c2/succession.ts";
import {
  currentSpeed,
  useSimStore,
  type HudSnapshot,
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
          effective:
            squads.reduce((a, s) => a + s.effective, 0) +
            hq.filter((s) => s.status === "ok").length,
          total: squads.reduce((a, s) => a + s.total, 0) + hq.length,
          degraded: isDegraded(pl),
          squads,
        };
      });
    const coHq = world.soldiers.filter(
      (s) => s.side === co.side && s.companyId === co.companyId && s.platoonId < 0,
    );
    out.push({
      side: co.side,
      companyId: co.companyId,
      effective:
        platoons.reduce((a, p) => a + p.effective, 0) +
        coHq.filter((s) => s.status === "ok").length,
      total: platoons.reduce((a, p) => a + p.total, 0) + coHq.length,
      degraded: isDegraded(co),
      assetsBusy: co.assets.filter((a) => a.arriveTick !== null).length,
      assetsTotal: co.assets.length,
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
  for (const s of world.soldiers) {
    const alive = s.status !== "kia";
    const effective = s.status === "ok";
    const evacuated = isOffField(s);
    // 後送を待っている = 倒れていて、まだCCPへ届いていない(仕様 §9)
    const awaiting = s.status === "wia" && !evacuated;
    if (s.side === "blue") {
      if (alive) blueAlive++;
      if (effective) blueEffective++;
      if (evacuated) blueEvacuated++;
      if (awaiting) blueAwaitingEvac++;
    } else {
      if (alive) redAlive++;
      if (effective) redEffective++;
      if (evacuated) redEvacuated++;
      if (awaiting) redAwaitingEvac++;
    }
  }
  return {
    tick: world.tick,
    simSeconds: world.tick * SIM_DT,
    blueAlive,
    redAlive,
    blueEffective,
    redEffective,
    knownContacts: view.known,
    staleContacts: view.stale,
    blueEvacuated,
    redEvacuated,
    blueAwaitingEvac,
    redAwaitingEvac,
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
  const world = createWorld(SCENARIOS[scenarioKey].make());
  const renderer: Renderer = createRenderer(canvas, world);
  const clock = createSimClock(currentSpeed(useSimStore.getState()));

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

    const ticks = drainTicks(clock, elapsed);
    for (let t = 0; t < ticks; t++) stepWorld(world);

    // 描画は「選択した階層が知っていること」だけを見る(仕様 §5)。
    // ここで ground truth を渡してしまうとプレイヤーが全知になり、階層構造が無意味になる。
    const view = resolveView(world, {
      side: ui.viewSide,
      echelon: ui.viewEchelon,
      squadId: ui.viewSquadId,
      platoonId: ui.viewPlatoonId,
    });
    renderer.render(world, view, renderAlpha(clock), {
      debug: ui.debug,
      selectedId: ui.selectedSoldierId,
      controlledId: controlledSoldierId(world),
      viewSide: ui.viewSide,
      truth: ui.viewEchelon === "truth",
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
