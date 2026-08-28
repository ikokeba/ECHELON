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
import { SIM_DT } from "@sim/constants.ts";
import { currentSpeed, useSimStore, type HudSnapshot } from "./store.ts";

function hudOf(world: World, view: ViewResult): HudSnapshot {
  let blueAlive = 0;
  let redAlive = 0;
  let blueEffective = 0;
  let redEffective = 0;
  for (const s of world.soldiers) {
    const alive = s.status !== "kia";
    const effective = s.status === "ok";
    if (s.side === "blue") {
      if (alive) blueAlive++;
      if (effective) blueEffective++;
    } else {
      if (alive) redAlive++;
      if (effective) redEffective++;
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

  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);

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
  requestAnimationFrame(frame);

  return () => {
    running = false;
    window.removeEventListener("resize", onResize);
    renderer.dispose();
  };
}

/** UIの分隊セレクタ用: シナリオに存在する分隊IDを陣営別に返す。 */
export function squadIdsOf(world: World, side: "blue" | "red"): number[] {
  return world.squads.filter((s) => s.side === side).map((s) => s.squadId);
}
