import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { uasDetectionSystem } from "../src/sim/systems/uasDetect.ts";
import { radioSystem } from "../src/sim/radio.ts";
import { UAS_DETECT } from "../src/sim/constants.ts";
import type { Drone, FireteamState, Soldier } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 操縦手の位置の推定(`[v7.5]` ロードマップ A-11)。電池交換に戻っていくドローンを見た者は、
 * その進む方向に操縦手がいると分かる — 方角だけの弱い接触(音の接触と同じ扱い)。
 */

const SPEC = { ...DEFAULT_FORCE, drone: true };

/** 赤の屋外のFTのすぐ上に、青のドローンを state で浮かべる */
function setup(state: Drone["state"]): {
  w: World;
  ft: FireteamState;
  men: Soldier[];
  d: Drone;
  op: Soldier;
} {
  const w = createWorld(companyClashScenario(1, { blue: SPEC, red: { ...SPEC } }));
  const ft = w.fireteams.find((f) => f.side === "red")!;
  const men = w.soldiers.filter(
    (s) => s.side === "red" && s.squadId === ft.squadId && s.fireteamId === ft.ftIndex,
  );
  const d = w.drones.find((x) => x.side === "blue")!;
  const op = w.soldierById.get(d.operatorId)!;
  for (const m of men) {
    m.pos = { x: 0, z: 0 };
    m.atWindow = false;
  }
  d.state = state;
  d.pos = { x: 20, z: 0 };
  return { w, ft, men, d, op };
}

describe("操縦手の位置の推定(`[v7.5]` A-11)", () => {
  it("戻っていくドローンを見ると、その進む方向に方角だけの弱い接触ができる", () => {
    const { w, ft, d, op } = setup("returning");
    uasDetectionSystem(w);
    const c = ft.memory.get(`hop.${d.id}`)!;
    expect(c).toBeDefined();
    expect(c.heard).toBe(true);
    expect(c.side).toBe("blue");
    // 弱い: 交戦・擲弾(0.5)・接敵(0.85)の線より下
    expect(c.confidence).toBeLessThan(0.5);
    expect(c.posError).toBe(UAS_DETECT.OPERATOR_ERROR);
    // 置かれる方向は、ドローンから操縦手への向きと一致する
    const toOp = Math.atan2(op.pos.z - d.pos.z, op.pos.x - d.pos.x);
    const toC = Math.atan2(c.pos.z - d.pos.z, c.pos.x - d.pos.x);
    const diff = Math.abs(Math.atan2(Math.sin(toOp - toC), Math.cos(toOp - toC)));
    expect(diff).toBeLessThan(0.05);
    // 操縦手の位置そのものではない(距離は当て推量)
    expect(c.pos).not.toEqual(op.pos);
  });

  it("飛んでいる(戻っていない)ドローン、羽音だけのドローンからは作らない", () => {
    const a = setup("flying");
    uasDetectionSystem(a.w);
    expect(a.ft.memory.has(`hop.${a.d.id}`)).toBe(false);
    const b = setup("returning");
    b.d.pos = { x: UAS_DETECT.SIGHT + 20, z: 0 };
    uasDetectionSystem(b.w);
    expect(b.ft.uas.size).toBe(1); // 羽音では気づいている
    expect(b.ft.memory.has(`hop.${b.d.id}`)).toBe(false);
  });

  it("分隊長の像を経て、無線で上へ上がる(見た敵と同じ経路)", () => {
    const { w, ft, d } = setup("returning");
    uasDetectionSystem(w);
    radioSystem(w);
    const sq = w.squads.find((s) => s.side === "red" && s.squadId === ft.squadId)!;
    expect(sq.belief.has(`hop.${d.id}`)).toBe(true);
  });
});
