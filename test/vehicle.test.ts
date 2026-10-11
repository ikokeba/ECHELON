import { describe, it, expect } from "vitest";
import { createWorld, setBlockers } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginBattle, beginPlanning } from "../src/sim/c2/planning.ts";
import { DEFAULT_FORCE, playForce } from "../src/sim/force.ts";
import { perceptionSystem } from "../src/sim/systems/perception.ts";
import {
  applyVehicleHit,
  dismount,
  hitAspect,
  taskVehicle,
  vehicleBlocks,
  vehiclesOf,
} from "../src/sim/systems/vehicle.ts";
import { isOffField } from "../src/sim/systems/litter.ts";
import { orderVehicle } from "../src/sim/playerOrders.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { applyResponse, parseResponse } from "../src/llm/commands.ts";
import { buildingAt } from "../src/sim/cqb.ts";
import { collidesWallIndexed } from "../src/sim/wallIndex.ts";
import { SIM_HZ, VEHICLE } from "../src/sim/constants.ts";
import type { Side, Vehicle } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 装甲車(IFV、`[v7.8]` ロードマップ B-1)。
 *   ① 道路(車両の航行グリッド)を走る動く火力支援。損傷は動けない・撃てない・撃破
 *   ② 車体は視線を遮る。ハッチを閉めると見えにくく、まわりの歩兵が目になる
 *   ③ 側面・後面・上面(建物の中から・近くから)の対戦車火器に弱い
 *   ④ 分隊を乗せて始まり、降ろす。撃破されれば乗っている兵も巻き込まれる
 */

const SPEC = { ...DEFAULT_FORCE, vehicles: true };
const world = (seed = 1): World =>
  createWorld(companyClashScenario(seed, { blue: SPEC, red: { ...DEFAULT_FORCE } }));
const blueCo = (w: World) => w.companies.find((c) => c.side === "blue")!;

describe("装甲車(`[v7.8]` B-1)— 編成と乗車(④)", () => {
  it("小隊ごとに1両、その小隊の最初の小銃分隊が乗って始まる。乗っている兵は盤上にいない扱い", () => {
    const w = world();
    const vs = vehiclesOf(w, blueCo(w));
    expect(vs.length).toBe(3);
    for (const v of vs) {
      expect(v.mounted.length).toBe(9);
      for (const id of v.mounted) {
        const s = w.soldierById.get(id)!;
        expect(s.mountedIn).toBe(v.id);
        expect(isOffField(s)).toBe(true);
        expect(s.platoonId).toBe(v.platoonId);
        expect(s.role).not.toBe("mg");
      }
    }
    // 赤は持たない。既定(テスト・画面とも)では持たない
    expect(w.vehicles.every((v) => v.side === "blue")).toBe(true);
    expect(createWorld(companyClashScenario(1, playForce())).vehicles).toEqual([]);
  });

  it("降ろすと車両の後ろに出て、盤上に戻る", () => {
    const w = world();
    const v = vehiclesOf(w, blueCo(w))[0]!;
    const ids = [...v.mounted];
    dismount(w, v);
    expect(v.mounted).toEqual([]);
    for (const id of ids) {
      const s = w.soldierById.get(id)!;
      expect(s.mountedIn).toBeNull();
      expect(isOffField(s)).toBe(false);
      // 車両の前ではなく後ろ側
      const rel = (s.pos.x - v.pos.x) * v.facing.x + (s.pos.z - v.pos.z) * v.facing.z;
      expect(rel).toBeLessThanOrEqual(0.01);
    }
  });

  it("撃破されると、乗っている兵の一部が倒れ、残りは降りる", () => {
    let hurt = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const w = world(seed);
      const v = vehiclesOf(w, blueCo(w))[0]!;
      const ids = [...v.mounted];
      // 撃破が出るまで上面から当て続ける
      for (let k = 0; k < 40 && !v.destroyed; k++) applyVehicleHit(w, v, { x: v.pos.x + 5, z: v.pos.z }, "red");
      expect(v.destroyed).toBe(true);
      expect(v.mounted).toEqual([]);
      hurt += ids.filter((id) => w.soldierById.get(id)!.status !== "ok").length;
    }
    expect(hurt).toBeGreaterThan(0);
  });
});

describe("装甲車(`[v7.8]` B-1)— 走る(①)", () => {
  it("小隊について道路を走り、建物に入らず壁にめり込まない", () => {
    const w = world(2);
    beginPlanning(w);
    beginBattle(w);
    const start = vehiclesOf(w, blueCo(w)).map((v) => ({ ...v.pos }));
    for (let t = 0; t < 90 * SIM_HZ; t++) {
      stepWorld(w);
      for (const v of w.vehicles) {
        if (v.destroyed) continue;
        expect(buildingAt(w.buildings, v.pos)).toBeNull();
        expect(collidesWallIndexed(w.moveIndex, v.pos.x, v.pos.z, VEHICLE.HALF_W * 0.9)).toBe(false);
      }
    }
    const moved = vehiclesOf(w, blueCo(w)).filter(
      (v, i) => Math.hypot(v.pos.x - start[i]!.x, v.pos.z - start[i]!.z) > 20,
    );
    expect(moved.length).toBeGreaterThan(0);
  }, 300000);

  it("足回りをやられた車両は動かず、行き先も決められない", () => {
    const w = world();
    const v = vehiclesOf(w, blueCo(w))[0]!;
    v.damage.mobility = true;
    expect(taskVehicle(w, blueCo(w), v.id, { x: 0, z: 0 })).toEqual({ ok: false, reason: "immobile" });
  });
});

describe("装甲車(`[v7.8]` B-1)— 視線と目(②)", () => {
  it("車体は視線を遮る。陰にいる兵は見えない", () => {
    const w = world();
    setBlockers(w, []);
    const v = vehiclesOf(w, blueCo(w))[0]!;
    v.pos = { x: 0, z: 0 };
    v.facing = { x: 0, z: 1 };
    expect(vehicleBlocks(w, { x: -10, z: 0 }, { x: 10, z: 0 })).toBe(true);
    expect(vehicleBlocks(w, { x: -10, z: 8 }, { x: 10, z: 8 })).toBe(false);
    const a = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
    const b = w.soldiers.find((s) => s.side === "blue" && s.status === "ok" && s.mountedIn == null)!;
    a.pos = { x: -12, z: 0 };
    a.eye = { ...a.pos };
    a.facing = { x: 1, z: 0 };
    b.pos = { x: 6, z: 0 };
    b.eye = { ...b.pos };
    perceptionSystem(w);
    expect(a.sees).not.toContain(b.id);
    b.pos = { x: 6, z: 9 };
    b.eye = { ...b.pos };
    perceptionSystem(w);
    expect(a.sees).toContain(b.id);
  });

  it("実戦で、敵が見えればハッチを閉め、機関砲で撃つ", () => {
    const f = playForce();
    f.blue.vehicles = true;
    const w = createWorld(companyClashScenario(1, f));
    beginPlanning(w);
    beginBattle(w);
    let closed = 0;
    let shots = 0;
    for (let t = 0; t < 200 * SIM_HZ; t++) {
      stepWorld(w);
      if (w.vehicles.some((v) => v.hatch === "closed")) closed++;
      for (const fx of w.fx) if (fx.kind === "shot" && fx.weapon === "vehicle") shots++;
    }
    expect(closed).toBeGreaterThan(0);
    expect(shots).toBeGreaterThan(0);
  }, 400000);
});

describe("装甲車(`[v7.8]` B-1)— 弱点(③)", () => {
  function placed(w: World): Vehicle {
    const v = vehiclesOf(w, blueCo(w))[0]!;
    v.pos = { x: 0, z: 0 };
    v.facing = { x: 0, z: 1 };
    return v;
  }

  it("当たった向き: 正面・側面、建物の中や近くからは上面", () => {
    const w = world();
    const v = placed(w);
    expect(hitAspect(w, v, { x: 0, z: 100 })).toBe("front");
    expect(hitAspect(w, v, { x: 100, z: 0 })).toBe("side");
    expect(hitAspect(w, v, { x: 0, z: -100 })).toBe("side");
    expect(hitAspect(w, v, { x: 0, z: 15 })).toBe("top");
    const room = w.buildings[0]!.rooms[0]!.bounds;
    expect(hitAspect(w, v, { x: (room.minX + room.maxX) / 2, z: (room.minZ + room.maxZ) / 2 })).toBe("top");
  });

  it("正面より側面、側面より上面で撃破されやすい", () => {
    // 1つの盤面で車両の状態を戻しながら当て続ける(乱数は進むので毎回別の目)
    const w = world(1);
    const v = placed(w);
    v.mounted = [];
    const rate = (from: { x: number; z: number }): number => {
      let kills = 0;
      for (let k = 0; k < 400; k++) {
        v.destroyed = false;
        v.damage = { mobility: false, firepower: false };
        applyVehicleHit(w, v, from, "red");
        if (v.destroyed) kills++;
      }
      return kills;
    };
    const front = rate({ x: 0, z: 100 });
    const side = rate({ x: 100, z: 0 });
    const top = rate({ x: 0, z: 15 });
    expect(front).toBeLessThan(side);
    expect(side).toBeLessThan(top);
  });
});

describe("装甲車(`[v7.8]` B-1)— 誰が行き先を決めるか(P4)", () => {
  it("人間・LLM は中隊長の座席から同じ関数で行き先を決め、中隊長以外は決められない", () => {
    const w = world();
    const v = vehiclesOf(w, blueCo(w))[0]!;
    const seat = { side: "blue" as Side, echelon: "company" as const, unitId: blueCo(w).companyId };
    expect(orderVehicle(w, v.id, { x: 0, z: -60 }, { ...seat, echelon: "platoon", unitId: 0 })).toBeNull();
    expect(orderVehicle(w, v.id, { x: v.pos.x, z: v.pos.z + 30 }, seat)).toEqual({ ok: true });
    expect(v.task.kind).toBe("move");
    const obs = buildObservation(w, seat)!;
    expect(obs.vehicles?.length).toBe(3);
    expect(obs.commands.some((c) => c.type === "vehicle")).toBe(true);
    const p = parseResponse({ commands: [{ type: "vehicle", unit: v.id }, { type: "vehicle" }] });
    expect(p.response?.commands).toEqual([{ type: "vehicle", unit: v.id }]);
    expect(p.errors[0]).toMatch(/vehicle/);
    applyResponse(w, seat, p.response!);
    expect(v.task.kind).toBe("escort");
  });

  it("同じ初期条件なら同じ経過になる(P3)", () => {
    const run = (): string => {
      const w = world(3);
      beginPlanning(w);
      beginBattle(w);
      for (let t = 0; t < 120 * SIM_HZ; t++) stepWorld(w);
      return JSON.stringify(w.vehicles.map((v) => [v.pos, v.damage, v.destroyed, v.mounted.length]));
    };
    expect(run()).toBe(run());
  }, 400000);
});
