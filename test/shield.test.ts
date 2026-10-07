import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { companyClashScenario, makeSoldier } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE, forceSize, type ForceSpec } from "../src/sim/force.ts";
import { shieldAccMul, shieldStackSlots } from "../src/sim/shield.ts";
import { sightRangeOf, weaponRangeOf } from "../src/sim/weapons.ts";
import { SHIELD, WEAPON_RANGE } from "../src/sim/constants.ts";
import type { Scenario, Side, Soldier } from "../src/sim/types.ts";

/**
 * 盾持ち(`[v7.0]`)。編成オプションで各FTのライフルマンが防弾盾+拳銃に替わり、
 * FTは盾を先頭にした密集隊形で動く。
 */

const spec = (patch: Partial<ForceSpec> = {}): ForceSpec => ({ ...DEFAULT_FORCE, ...patch });
const both = (s: ForceSpec): Record<Side, ForceSpec> => ({ blue: { ...s }, red: { ...s } });

function soldier(side: Side, x: number, z: number, patch: Partial<Soldier> = {}): Soldier {
  const s = makeSoldier({ side, platoonId: 0, squadId: 0, fireteamId: 0, pos: { x, z } });
  return Object.assign(s, patch);
}

describe("盾の命中率倍率(shield.ts)", () => {
  const shooter = soldier("red", 0, 20);

  it("盾持ち本人: 正面からは BEARER_ACC_MUL、背中からは盾が効かない", () => {
    const facingShooter = soldier("blue", 0, 0, { role: "shield", facing: { x: 0, z: 1 } });
    expect(shieldAccMul(shooter, facingShooter, [facingShooter])).toBe(SHIELD.BEARER_ACC_MUL);
    const facingAway = soldier("blue", 0, 0, { role: "shield", facing: { x: 0, z: -1 } });
    expect(shieldAccMul(shooter, facingAway, [facingAway])).toBe(1);
    // 真横(90°)は正面の扇(±FRONT_ARC_DEG)の外
    const sideways = soldier("blue", 0, 0, { role: "shield", facing: { x: 1, z: 0 } });
    expect(shieldAccMul(shooter, sideways, [sideways])).toBe(1);
  });

  it("盾の陰の味方は BEHIND_ACC_MUL。射線から外れれば効かない", () => {
    const bearer = soldier("blue", 0, 1, { role: "shield", facing: { x: 0, z: 1 } });
    const behind = soldier("blue", 0, 0);
    expect(shieldAccMul(shooter, behind, [bearer])).toBe(SHIELD.BEHIND_ACC_MUL);
    // 横へ2mずれた味方は盾の陰に入っていない
    const offLine = soldier("blue", 2, 0);
    expect(shieldAccMul(shooter, offLine, [bearer])).toBe(1);
    // 盾から離れすぎた味方(陰の奥行きの外)も守られない
    const farBehind = soldier("blue", 0, 1 - SHIELD.SHADOW_DEPTH - 1);
    expect(shieldAccMul(shooter, farBehind, [bearer])).toBe(1);
    // 倒れた盾持ちは誰も守らない
    const downed = soldier("blue", 0, 1, { role: "shield", facing: { x: 0, z: 1 }, status: "wia" });
    expect(shieldAccMul(shooter, behind, [downed])).toBe(1);
  });

  it("密集隊形の位置はすべて盾の陰に収まる", () => {
    const bearer = soldier("blue", 0, 0, { role: "shield", facing: { x: 0, z: 1 } });
    const slots = shieldStackSlots(bearer.pos, bearer.facing, 3);
    const front = soldier("red", 0, 30);
    for (const p of slots) {
      const t = soldier("blue", p.x, p.z);
      expect(shieldAccMul(front, t, [bearer])).toBe(SHIELD.BEHIND_ACC_MUL);
    }
  });
});

describe("盾持ちの武器と目", () => {
  it("撃てるのは拳銃の距離まで、見えるのは小銃と同じ距離まで", () => {
    const s = soldier("blue", 0, 0, { role: "shield" });
    expect(weaponRangeOf(s)).toEqual(WEAPON_RANGE.pistol);
    expect(sightRangeOf(s)).toBe(WEAPON_RANGE.rifle.detect);
  });
});

describe("盾持ちの編成(force.ts / scenario.ts)", () => {
  for (const scale of ["squad", "platoon", "company"] as const) {
    it(`${scale}: 各FTに盾持ち1名、頭数は変わらず、衛生要員と選抜射手も残る`, () => {
      const sc = companyClashScenario(1, both(spec({ scale, shield: true })));
      for (const side of ["blue", "red"] as const) {
        const mine = sc.soldiers.filter((s) => s.side === side);
        expect(mine.length).toBe(forceSize(spec({ scale })));
        const fts = new Map<string, Soldier[]>();
        // 火器分隊(機関銃班)は盾を持たない
        const weaponsSquads = new Set(mine.filter((s) => s.role === "mg").map((s) => s.squadId));
        for (const s of mine) {
          if (s.fireteamId < 0 || weaponsSquads.has(s.squadId)) continue;
          const k = `${s.squadId}:${s.fireteamId}`;
          fts.set(k, [...(fts.get(k) ?? []), s]);
        }
        expect(fts.size).toBeGreaterThan(0);
        for (const team of fts.values()) {
          expect(team.filter((s) => s.role === "shield").length).toBe(1);
          expect(team.filter((s) => s.quals.medicalCrossTrained).length).toBe(1);
          // 盾持ちは衛生要員・選抜射手を兼ねない
          const shield = team.find((s) => s.role === "shield")!;
          expect(shield.quals.medicalCrossTrained || shield.quals.designatedMarksman).toBe(false);
        }
        const squads = new Set(
          mine
            .filter((s) => s.squadId >= 0 && s.fireteamId >= 0 && !weaponsSquads.has(s.squadId))
            .map((s) => s.squadId),
        );
        expect(mine.filter((s) => s.quals.designatedMarksman).length).toBe(squads.size);
      }
    });
  }

  it("既定(盾なし)の編成は1名も変わらない", () => {
    const a = companyClashScenario(1);
    expect(a.soldiers.some((s) => s.role === "shield")).toBe(false);
  });
});

describe("盾の密集隊形(c2/fireteam.ts)", () => {
  it("盾持ちが健在なFTは、盾の後ろに詰めて動く", () => {
    const w = createWorld(companyClashScenario(1, both(spec({ scale: "platoon", shield: true }))));
    let samples = 0;
    let tight = 0;
    for (let t = 0; t < 1800; t++) {
      stepWorld(w);
      if (t % 30) continue;
      for (const ft of w.fireteams) {
        if (ft.mode !== "ADVANCE" && ft.mode !== "CONTACT") continue;
        const team = w.soldiers.filter(
          (s) =>
            s.side === ft.side &&
            s.squadId === ft.squadId &&
            s.fireteamId === ft.ftIndex &&
            s.status === "ok",
        );
        const bearer = team.find((s) => s.role === "shield");
        if (!bearer || team.some((s) => s.treating !== null || s.bearing !== null)) continue;
        for (const s of team) {
          if (s === bearer) continue;
          samples++;
          if (
            Math.hypot(s.pos.x - bearer.pos.x, s.pos.z - bearer.pos.z) <=
            SHIELD.STACK_ROW * 3 + 1.5
          )
            tight++;
        }
      }
    }
    expect(samples).toBeGreaterThan(50);
    // 大半の時間、隊員は盾持ちから数メートル以内にいる(壁際の詰まりなどで外れる瞬間はある)
    expect(tight / samples).toBeGreaterThan(0.7);
  });
});

describe("盾があっても陣営は読まない(仕様 §2/§13)", () => {
  it("両軍とも盾持ちありで、陣営ラベルを入れ替えると結果が厳密に反転する", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const make = (): Scenario =>
      companyClashScenario(3, both(spec({ scale: "platoon", shield: true })));
    const swap = (sc: Scenario): Scenario => {
      for (const s of sc.soldiers) s.side = flip(s.side);
      for (const p of sc.fireteamPlans ?? []) p.side = flip(p.side);
      for (const p of sc.squadPlans ?? []) p.side = flip(p.side);
      for (const p of sc.platoonPlans ?? []) p.side = flip(p.side);
      for (const p of sc.companyPlans ?? []) p.side = flip(p.side);
      if (sc.ccp) sc.ccp = { blue: sc.ccp.red, red: sc.ccp.blue };
      return sc;
    };
    const kia = (sc: Scenario): Record<Side, number> => {
      const w = createWorld(sc);
      runTicks(w, 3000);
      return {
        blue: w.soldiers.filter((s) => s.side === "blue" && s.status === "kia").length,
        red: w.soldiers.filter((s) => s.side === "red" && s.status === "kia").length,
      };
    };
    const a = kia(make());
    const b = kia(swap(make()));
    expect(a.blue + a.red).toBeGreaterThan(0);
    expect(b).toEqual({ blue: a.red, red: a.blue });
  });
});
