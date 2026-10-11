import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { SIM_HZ } from "../src/sim/constants.ts";
import { PALETTE } from "../src/theme.ts";
import type { FxEvent } from "../src/sim/types.ts";

/**
 * 弾の色分け(`[v7.6]` プレイでの指摘「選抜射手や特別な役職の弾の色を変えたい」)。
 *
 * 色は描画の話だが、色の手がかりは射撃イベントの `weapon` だけなので、そこが撃った者の
 * 役職と一致していることを固定する。シムの結果には関わらない(fx は誰も読まない)。
 */
describe("弾の色分け(`[v7.6]`)", () => {
  it("射撃イベントの武器は撃った者の役職に一致する(選抜射手=dm / 機関銃手=mg)", () => {
    const w = createWorld(companyClashScenario(1));
    beginPlanning(w);
    beginBattle(w);
    // 撃った瞬間の役職で照らし合わせる(`[v7.6]` 射手が倒れると銃は副射手へ移る)
    const shots: Array<{ f: Extract<FxEvent, { kind: "shot" }>; s: { role: string; quals: { designatedMarksman: boolean } } }> = [];
    for (let t = 0; t < 200 * SIM_HZ; t++) {
      // 銃の受け渡しは同じティックの射撃のあとに起きるので、ティックの頭の役職を取っておく
      const roleAt = new Map(w.soldiers.map((s) => [s.id, s.role]));
      stepWorld(w);
      for (const f of w.fx) {
        if (f.kind !== "shot" || f.shooterId < 0 || f.targetId < 0) continue; // ドローンへの射撃は別に見る
        const s = w.soldierById.get(f.shooterId)!;
        shots.push({ f, s: { role: roleAt.get(s.id) ?? s.role, quals: { ...s.quals } } });
      }
    }
    const seen = new Set<string>();
    for (const { f, s } of shots) {
      const want =
        s.role === "mg"
          ? "mg"
          : s.role === "saw"
            ? "saw"
            : s.role === "shield"
              ? "pistol"
              : s.quals.designatedMarksman
                ? "dm"
                : "rifle";
      expect(f.weapon).toBe(want);
      seen.add(f.weapon);
    }
    // 中隊戦の200秒で、選抜射手・機関銃・小銃の弾は必ず飛ぶ
    expect(seen.has("dm")).toBe(true);
    expect(seen.has("mg")).toBe(true);
    expect(seen.has("rifle")).toBe(true);
  }, 300000);

  it("特別な射手の弾の色は互いに違い、陣営色・warn・live とも違う", () => {
    const special = [
      PALETTE.tracerDm,
      PALETTE.tracerMg,
      PALETTE.tracerPistol,
      PALETTE.tracerAt,
      PALETTE.tracerCuas,
    ];
    expect(new Set(special).size).toBe(special.length);
    for (const c of special) {
      for (const other of [PALETTE.blue, PALETTE.red, PALETTE.warn, PALETTE.live]) {
        expect(c).not.toBe(other);
      }
    }
  });
});
