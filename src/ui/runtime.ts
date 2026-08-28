/**
 * ランタイムドライバ: World・レンダラ・シムクロックを保持し、requestAnimationFrame
 * ループの中で結びつける。**描画レートと固定シムレートが出会う唯一の場所**。
 * rAF / performance.now / DOM に触れるため、sim/ ではなく ui/ に置いている。
 */

import { createRenderer, type Renderer } from "@render/renderer.ts";
import { createSimClock, drainTicks, renderAlpha, requestSteps, setSpeed } from "@sim/loop.ts";
import { stepWorld } from "@sim/step.ts";
import { createWorld, type World } from "@sim/world.ts";
import { demoCrossingScenario } from "@sim/scenario.ts";
import { SIM_DT } from "@sim/constants.ts";
import { currentSpeed, useSimStore, type HudSnapshot } from "./store.ts";

function hudOf(world: World): HudSnapshot {
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
  };
}

export function startRuntime(canvas: HTMLCanvasElement): () => void {
  const world = createWorld(demoCrossingScenario());
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
    for (let i = 0; i < ticks; i++) stepWorld(world);

    renderer.render(world, renderAlpha(clock));

    if (ticks > 0 && (hudCountdown -= 1) <= 0) {
      useSimStore.getState().pushHud(hudOf(world));
      hudCountdown = 6;
    }

    requestAnimationFrame(frame);
  }
  useSimStore.getState().pushHud(hudOf(world));
  requestAnimationFrame(frame);

  return () => {
    running = false;
    window.removeEventListener("resize", onResize);
    renderer.dispose();
  };
}
