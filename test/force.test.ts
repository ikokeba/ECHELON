import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario, urbanAssaultScenario } from "../src/sim/scenario.ts";
import {
  DEFAULT_FORCE,
  FORCE_SCALE_KEYS,
  HEADCOUNT,
  defaultForce,
  forceSize,
  type ForceScale,
  type ForceSpec,
} from "../src/sim/force.ts";
import { DM_DETECT_RANGE } from "../src/sim/constants.ts";
import { hasLineOfSightIndexed } from "../src/sim/wallIndex.ts";
import type { Side } from "../src/sim/types.ts";

/**
 * 陣営ごとの編成プリセット。`[v6.9]` 仕様 §2 編成 / §14 MOS。
 *
 * 検証したいのは4点:
 *   1. 既定(完全編成の中隊)が、編成機構を入れる前と**1名も変わらない**こと
 *   2. `forceSize()` の予告と、実際に組み上がる人数が一致すること
 *      — 頭数の定数が `scenario.ts` の組み立てループと二重管理になっているため
 *   3. 特技のトグルが**頭数を変えずに中身だけ**変えること
 *   4. 左右同じ編成なら、陣営ラベルの入替に対して結果が厳密に反転すること
 *      (編成のどこにも陣営を見た分岐が無い = 仕様 §2/§13)
 */

const spec = (patch: Partial<ForceSpec> = {}): ForceSpec => ({ ...DEFAULT_FORCE, ...patch });
const both = (s: ForceSpec): Record<Side, ForceSpec> => ({ blue: { ...s }, red: { ...s } });
const count = (sc: { soldiers: Array<{ side: Side }> }, side: Side) =>
  sc.soldiers.filter((s) => s.side === side).length;

describe("編成プリセット(`[v6.9]` 仕様 §2/§14)", () => {
  it("既定は完全編成の中隊で、両軍とも112名(機構を入れる前と同一)", () => {
    const sc = companyClashScenario(1);
    expect(count(sc, "blue")).toBe(112);
    expect(count(sc, "red")).toBe(112);
    // 引数を明示的に渡しても同じであること(既定値の取り違えを防ぐ)
    const explicit = companyClashScenario(1, defaultForce());
    expect(count(explicit, "blue")).toBe(112);
  });

  /**
   * `HEADCOUNT` は `scenario.ts` の組み立てループの人数を写したものなので、
   * 放っておくと必ずずれる。予告と実物をここで突き合わせておく。
   */
  it.each(FORCE_SCALE_KEYS)("forceSize('%s') が実際に組み上がる人数と一致する", (scale) => {
    for (const weaponsSquad of [true, false]) {
      const s = spec({ scale: scale as ForceScale, weaponsSquad });
      const sc = companyClashScenario(1, both(s));
      expect(count(sc, "blue")).toBe(forceSize(s));
      expect(count(sc, "red")).toBe(forceSize(s));
    }
  });

  it("規模を下げると階層が1つずつ消える(仕様 §2)", () => {
    const co = createWorld(companyClashScenario(1, both(spec({ scale: "company" }))));
    const pl = createWorld(companyClashScenario(1, both(spec({ scale: "platoon" }))));
    const sq = createWorld(companyClashScenario(1, both(spec({ scale: "squad" }))));

    // 中隊本部は中隊規模だけが持つ
    const hq = (w: typeof co, side: Side) =>
      w.soldiers.filter((s) => s.side === side && s.hqRole === "co").length;
    expect(hq(co, "blue")).toBe(1);
    expect(hq(pl, "blue")).toBe(0);
    expect(hq(sq, "blue")).toBe(0);

    // 小隊本部は分隊規模だけが持たない
    const plHq = (w: typeof co, side: Side) =>
      w.soldiers.filter((s) => s.side === side && s.hqRole === "pl").length;
    expect(plHq(co, "blue")).toBe(3);
    expect(plHq(pl, "blue")).toBe(1);
    expect(plHq(sq, "blue")).toBe(0);

    // 分隊の数: 中隊=3小隊×(ライフル3+火器1)、小隊=4、分隊=1
    const squads = (w: typeof co, side: Side) => w.squads.filter((s) => s.side === side).length;
    expect(squads(co, "blue")).toBe(12);
    expect(squads(pl, "blue")).toBe(4);
    expect(squads(sq, "blue")).toBe(1);
  });

  it("特技のトグルは頭数を変えず、その枠の中身だけを変える(仕様 §14)", () => {
    const full = createWorld(companyClashScenario(1, both(spec({ scale: "platoon" }))));
    const bare = createWorld(
      companyClashScenario(1, both(spec({ scale: "platoon", marksman: false, grenadier: false }))),
    );
    const blue = (w: typeof full) => w.soldiers.filter((s) => s.side === "blue");
    expect(blue(bare).length).toBe(blue(full).length);

    // 選抜射手: ライフル分隊に1名ずつ(3個分隊 = 3名) → 0名
    expect(blue(full).filter((s) => s.quals.designatedMarksman).length).toBe(3);
    expect(blue(bare).filter((s) => s.quals.designatedMarksman).length).toBe(0);

    // 擲弾手: 各FTに1名(3個分隊×2FT = 6名) → 0名。擲弾も一緒に消える
    expect(blue(full).filter((s) => s.role === "grenadier").length).toBe(6);
    expect(blue(bare).filter((s) => s.role === "grenadier").length).toBe(0);
    expect(blue(full).reduce((n, s) => n + s.grenades, 0)).toBeGreaterThan(0);
    expect(blue(bare).reduce((n, s) => n + s.grenades, 0)).toBe(0);

    // 空いた枠はライフルマンになる(消えるのではない)
    const rifles = (w: typeof full) => blue(w).filter((s) => s.role === "rifleman").length;
    expect(rifles(bare)).toBe(rifles(full) + 6);
  });

  it("火器分隊を外すと小隊から機関銃手が消える(仕様 §2)", () => {
    const on = createWorld(companyClashScenario(1, both(spec({ scale: "platoon" }))));
    const off = createWorld(
      companyClashScenario(1, both(spec({ scale: "platoon", weaponsSquad: false }))),
    );
    expect(on.soldiers.filter((s) => s.side === "blue" && s.role === "mg").length).toBe(2);
    expect(off.soldiers.filter((s) => s.side === "blue" && s.role === "mg").length).toBe(0);
    // 消えるのは火器分隊まるごと1個ぶん(7名)
    expect(off.soldiers.filter((s) => s.side === "blue").length).toBe(
      on.soldiers.filter((s) => s.side === "blue").length - HEADCOUNT.weaponsSquad,
    );
  });

  it("左右で規模を変えられ、頭数がそのまま非対称になる", () => {
    const sc = companyClashScenario(1, {
      blue: spec({ scale: "company" }),
      red: spec({ scale: "squad" }),
    });
    expect(count(sc, "blue")).toBe(112);
    expect(count(sc, "red")).toBe(9);
  });

  /**
   * `[v6.9]` 非対称の盤面も中隊まで受け止める(旧 168×144m を 300×236m へ広げた)。
   * 規模ごとの頭数が広域マップと一致すること = 盤面が編成を歪めていないこと。
   */
  it.each(FORCE_SCALE_KEYS)("非対称な戦場でも '%s' が編成どおりの頭数で出る", (scale) => {
    const s = spec({ scale: scale as ForceScale });
    const sc = urbanAssaultScenario(1, both(s));
    expect(count(sc, "blue")).toBe(forceSize(s));
    expect(count(sc, "red")).toBe(forceSize(s));
  });

  /**
   * 盤面を広げたときに毎回やり直しになる確認(`[v6.2]` の教訓)。展開地から敵展開地まで
   * 一直線に抜ける街路が残っていると、選抜射手(索敵300m)が誰も動かないうちから
   * 200m先を撃ち始め、仕様 §10 が前提にしている「市街地の見通し距離が交戦距離を
   * 自然に制限する」が成り立たなくなる。基準は同条件の広域マップ(2本 / 282m)。
   */
  it("展開地から敵展開地まで抜ける射線がほとんど残っていない(仕様 §10)", () => {
    for (const sc of [companyClashScenario(1), urbanAssaultScenario(1)]) {
      const w = createWorld(sc);
      let open = 0;
      for (const a of w.soldiers.filter((s) => s.side === "blue")) {
        for (const d of w.soldiers.filter((s) => s.side === "red")) {
          if (Math.hypot(a.pos.x - d.pos.x, a.pos.z - d.pos.z) > DM_DETECT_RANGE) continue;
          if (hasLineOfSightIndexed(w.wallIndex, a.eye.x, a.eye.z, d.eye.x, d.eye.z)) open++;
        }
      }
      // 224名 × 224名 の組のうち、開幕から射線が通っているのは数本まで
      expect.soft(open, `${sc.name} の開幕の通し射線`).toBeLessThanOrEqual(20);
    }
  });

  /**
   * 編成のどこにも陣営を見た分岐が無いことの確認。`symmetry.test.ts` と同じ
   * ラベル入替で見る(幾何的な鏡像ではなく、ラベルを入れ替えたら結果が反転すること)。
   */
  it("左右同じ編成なら、陣営ラベルの入替で結果が厳密に反転する(仕様 §2/§13)", () => {
    const s = spec({ scale: "platoon", marksman: false });
    const base = companyClashScenario(7, both(s));
    const swapped = companyClashScenario(7, both(s));
    for (const sol of swapped.soldiers) sol.side = sol.side === "blue" ? "red" : "blue";
    for (const p of swapped.fireteamPlans ?? []) p.side = p.side === "blue" ? "red" : "blue";
    for (const p of swapped.squadPlans ?? []) p.side = p.side === "blue" ? "red" : "blue";
    for (const p of swapped.platoonPlans ?? []) p.side = p.side === "blue" ? "red" : "blue";
    for (const p of swapped.companyPlans ?? []) p.side = p.side === "blue" ? "red" : "blue";

    const a = createWorld(base);
    const b = createWorld(swapped);
    runTicks(a, 30 * 60);
    runTicks(b, 30 * 60);

    const kia = (w: typeof a, side: Side) =>
      w.soldiers.filter((s) => s.side === side && s.status === "kia").length;
    expect(kia(a, "blue")).toBe(kia(b, "red"));
    expect(kia(a, "red")).toBe(kia(b, "blue"));
  });
});
