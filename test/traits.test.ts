import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { traitMul, traitProfile } from "../src/sim/traits.ts";
import type { Side } from "../src/sim/types.ts";

/**
 * 個体差パラメータ(仕様 §14 `[v6.2]`)。
 *
 * ここで守りたいのは2つ。
 *   1. **個体差が実際に存在する**(全員 0.5 のままでは仕様を満たさない)
 *   2. **両陣営で厳密に同一**。中隊マップは点対称なので、鏡像の位置に立つ兵士どうしが
 *      違う性格だと、地形由来ではない有利不利が生まれる(仕様 §2/§13)
 */
describe("個体差パラメータ(仕様 §14 `[v6.2]`)", () => {
  it("t=0.5 の倍率はちょうど1.0 — 既定の部隊は定数どおりに振る舞う", () => {
    expect(traitMul(0.5, 0.4)).toBe(1);
    expect(traitMul(0.5, 0)).toBe(1);
    // 端でも span の範囲に収まる
    expect(traitMul(1, 0.4)).toBeCloseTo(1.4, 10);
    expect(traitMul(0, 0.4)).toBeCloseTo(0.6, 10);
  });

  it("プロファイルは 0..1 に収まり、1周ぶんの平均が 0.5 になる", () => {
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < 4; i++) {
      const t = traitProfile(i);
      for (const v of [t.aggressiveness, t.boldness, t.caution]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      a += t.aggressiveness;
      b += t.boldness;
      c += t.caution;
    }
    expect(a / 4).toBeCloseTo(0.5, 10);
    expect(b / 4).toBeCloseTo(0.5, 10);
    expect(c / 4).toBeCloseTo(0.5, 10);
  });

  it("実際にばらついている — 全員が既定値のままではない", () => {
    const w = createWorld(platoonClashScenario(1));
    const vals = new Set(w.soldiers.map((s) => s.traits.aggressiveness.toFixed(3)));
    expect(vals.size).toBeGreaterThan(1);
  });

  it("両陣営の性格の分布が完全に一致する(仕様 §2/§13)", () => {
    for (const sc of [platoonClashScenario(1), companyClashScenario(1)]) {
      const w = createWorld(sc);
      const profile = (side: Side) =>
        w.soldiers
          .filter((s) => s.side === side)
          .map(
            (s) =>
              `${s.traits.aggressiveness.toFixed(4)}:${s.traits.boldness.toFixed(4)}:${s.traits.caution.toFixed(4)}`,
          )
          .sort()
          .join("|");
      expect(profile("blue")).toBe(profile("red"));
    }
  }, 30000);

  it("鏡像の位置に立つ兵士どうしが同じ性格を持つ(中隊マップは点対称)", () => {
    const w = createWorld(companyClashScenario(1));
    const red = w.soldiers.filter((s) => s.side === "red" && s.hqRole === null);
    let checked = 0;
    for (const b of w.soldiers.filter((s) => s.side === "blue" && s.hqRole === null)) {
      // blue の (x,z) に対する鏡像 (-x,-z) にいる red を探す
      const twin = red.find(
        (r) => Math.abs(r.pos.x + b.pos.x) < 1e-6 && Math.abs(r.pos.z + b.pos.z) < 1e-6,
      );
      if (!twin) continue;
      expect(twin.traits).toEqual(b.traits);
      checked++;
    }
    // 点対称なので全ライフル/火器分隊員に相方がいるはず
    expect(checked).toBeGreaterThan(100);
  }, 30000);
});
