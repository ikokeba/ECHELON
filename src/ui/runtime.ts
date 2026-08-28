/**
 * ランタイムドライバ: World・レンダラ・シムクロックを保持し、requestAnimationFrame
 * ループの中で結びつける。**描画レートと固定シムレートが出会う唯一の場所**。
 * rAF / performance.now / DOM に触れるため、sim/ ではなく ui/ に置いている。
 */

import { createRenderer, type Renderer } from "@render/renderer.ts";
import { createSimClock, drainTicks, renderAlpha, requestSteps, setSpeed } from "@sim/loop.ts";
import { stepWorld } from "@sim/step.ts";
import { createWorld, type World } from "@sim/world.ts";
import { platoonClashScenario } from "@sim/scenario.ts";
import { resolveView, type ViewResult } from "@sim/viewpoint.ts";
import { swapTo } from "@sim/control.ts";
import { orderControlledTo } from "@sim/playerOrders.ts";
import { SIM_DT } from "@sim/constants.ts";
import {
  currentSpeed,
  useSimStore,
  type HudSnapshot,
  type RosterPlatoon,
} from "./store.ts";

/** 階層ツリー用の編成一覧を組み立てる。損耗を反映するため定期的に更新する。 */
function rosterOf(world: World): RosterPlatoon[] {
  const out: RosterPlatoon[] = [];
  for (const pl of world.platoons) {
    const squads = world.squads
      .filter((s) => s.side === pl.side && s.platoonId === pl.platoonId)
      .map((sq) => {
        const men = world.soldiers.filter((s) => s.side === sq.side && s.squadId === sq.squadId);
        return {
          squadId: sq.squadId,
          effective: men.filter((s) => s.status === "ok").length,
          total: men.length,
        };
      });
    out.push({
      side: pl.side,
      platoonId: pl.platoonId,
      effective: squads.reduce((a, s) => a + s.effective, 0),
      total: squads.reduce((a, s) => a + s.total, 0),
      squads,
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
    const evacuated = s.evac === "evacuated";
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
  };
}

export function startRuntime(canvas: HTMLCanvasElement): () => void {
  const world = createWorld(platoonClashScenario());
  const renderer: Renderer = createRenderer(canvas, world);
  const clock = createSimClock(currentSpeed(useSimStore.getState()));

  let running = true;
  let lastMs = performance.now();
  let lastStepNonce = useSimStore.getState().stepNonce;
  let hudCountdown = 0;
  let lastControl = useSimStore.getState().control;

  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);

  /**
   * 右クリックで操作中のユニットへ移動命令を出す(仕様 §6「移動命令」)。
   * ポーズ中でも発行でき、解除後にタイムラグなく実行される(仕様 §6)。
   */
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (!world.control) return;
    const p = renderer.screenToWorld(e.clientX, e.clientY);
    orderControlledTo(world, p);
  };
  canvas.addEventListener("contextmenu", onContextMenu);

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

    const ticks = drainTicks(clock, elapsed);
    for (let t = 0; t < ticks; t++) stepWorld(world);

    // 描画は「選択した階層が知っていること」だけを見る(仕様 §5)。
    // ここで ground truth を渡してしまうとプレイヤーが全知になり、階層構造が無意味になる。
    const view = resolveView(world, {
      side: ui.viewSide,
      echelon: ui.viewEchelon,
      squadId: ui.viewSquadId,
    });
    renderer.render(world, view, renderAlpha(clock));

    if (ticks > 0 && (hudCountdown -= 1) <= 0) {
      useSimStore.getState().pushHud(hudOf(world, view));
      useSimStore.getState().setRoster(rosterOf(world));
      hudCountdown = 6;
    }

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
        }),
      ),
    );
  useSimStore.getState().setRoster(rosterOf(world));
  requestAnimationFrame(frame);

  return () => {
    running = false;
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("contextmenu", onContextMenu);
    renderer.dispose();
  };
}
