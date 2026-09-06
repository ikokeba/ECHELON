import { describe, it, expect } from "vitest";
import {
  decodeSetup,
  defaultSetup,
  encodeSetup,
  normalizeSetup,
  type BattleSetup,
  type SetupTuning,
} from "../src/sim/setupCode.ts";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { SCENARIOS, type ScenarioKey } from "../src/sim/scenario.ts";
import { applyDeployment } from "../src/sim/deployment.ts";
import { SIM_HZ } from "../src/sim/constants.ts";

/**
 * 初期条件コード(`[v6.18]`)。
 *
 * 固定するのは3つ:
 *   1. **往復する**。畳んで戻すと同じ初期条件になる(丸めの後は冪等)
 *   2. **壊れたコードは復元しない**。打ち間違いを黙って別の盤面にしない
 *   3. **同じコードなら同じ戦闘になる**。コードが担保したいのは結局これ
 */

const TUNING: SetupTuning = {
  detectRange: 150,
  fovDeg: 120,
  fireAlignDeg: 25,
  moveSpeed: 3.4,
  turnRateDeg: 180,
};

function sample(): BattleSetup {
  return {
    scenario: "oldQuarter",
    seed: 7,
    force: {
      blue: { scale: "platoon", marksman: false, grenadier: true, weaponsSquad: true },
      red: { scale: "company", marksman: true, grenadier: true, weaponsSquad: false },
    },
    doctrine: { blue: "irregular", red: "regular" },
    risk: { blue: 0.732, red: 0.5 },
    tuning: { ...TUNING, detectRange: 96.5 },
    deployment: {
      spawn: {
        blue: { pos: { x: -12.345, z: -140.987 }, facing: { x: 0, z: 1 } },
      },
      objectives: [{ label: "OBJ ALPHA", pos: { x: 1.234, z: -5.678 }, radius: 10 }],
      mode: "assault",
      attacker: "blue",
      timeLimitSec: 900,
    },
  };
}

describe("初期条件コード(`[v6.18]`)", () => {
  it("既定の初期条件は短いコードになる", () => {
    const code = encodeSetup(defaultSetup("oldQuarter", TUNING), TUNING);
    expect(code.startsWith("ECH1-")).toBe(true);
    expect(code.length, code).toBeLessThan(48);
  });

  it("畳んで戻すと同じ初期条件になる(丸めの後は冪等)", () => {
    const s = sample();
    const code = encodeSetup(s, TUNING);
    const back = decodeSetup(code, TUNING);
    expect(back).not.toBeNull();
    // 丸めを通した状態と一致する
    expect(back).toEqual(normalizeSetup(s));
    // もう一度畳んでも同じコード = コード自体が正規形
    expect(encodeSetup(back!, TUNING)).toBe(code);
  });

  it("既定のままの項目はコードに載らない", () => {
    const s = defaultSetup("trench", TUNING);
    const only = encodeSetup(s, TUNING);
    const withSeed = encodeSetup({ ...s, seed: 42 }, TUNING);
    expect(withSeed.length).toBeGreaterThan(only.length);
    expect(decodeSetup(withSeed, TUNING)!.seed).toBe(42);
  });

  it.each([
    ["空", ""],
    ["版が違う", "ECH9-eyJzIjoib2xkUXVhcnRlciJ9-abcd"],
    ["区切りが足りない", "ECH1-eyJzIjoib2xkUXVhcnRlciJ9"],
    ["中身がJSONでない", "ECH1-Zm9vYmFy-0000"],
  ])("壊れたコード(%s)は復元しない", (_label, code) => {
    expect(decodeSetup(code, TUNING)).toBeNull();
  });

  it("1文字でも違えばチェックサムで弾く", () => {
    const code = encodeSetup(sample(), TUNING);
    const body = code.split("-");
    const payload = body.slice(1, -1).join("-");
    // payload の1文字を別の文字へ替える
    const broken = payload[0] === "A" ? "B" + payload.slice(1) : "A" + payload.slice(1);
    expect(decodeSetup(`${body[0]}-${broken}-${body[body.length - 1]}`, TUNING)).toBeNull();
  });

  /**
   * コードが担保したいのは結局これ。**同じコードから作った世界は同じ戦闘になる。**
   * `src/sim` が決定論的であることに乗っているだけだが、コードが初期条件を取り
   * こぼしていたらここで落ちる。
   */
  /**
   * **120秒で見る。** 60秒では両軍がまだ接敵しておらず1発も撃っていないので、
   * 乱数が1つも引かれず、種を変えても状態が完全に一致する(実測: 60秒で戦死0・
   * 兵士の座標まで同一、90秒で分岐、120秒で戦死 8 対 15)。ここで60秒を使うと
   * 「種が効いている」ことを確かめたつもりで何も確かめていないテストになる。
   */
  it("同じコードから作った世界は同じ経過をたどる", () => {
    const code = encodeSetup(
      { ...defaultSetup("oldQuarter", TUNING), seed: 3 },
      TUNING,
    );
    const build = () => {
      const s = decodeSetup(code, TUNING)!;
      const base = SCENARIOS[s.scenario as ScenarioKey].make(s.seed, s.force);
      return createWorld(s.deployment ? applyDeployment(base, s.deployment) : base);
    };
    const a = build();
    const b = build();
    runTicks(a, 120 * SIM_HZ);
    runTicks(b, 120 * SIM_HZ);
    const fingerprint = (w: typeof a) =>
      w.soldiers.map((s) => `${s.status}${s.pos.x.toFixed(4)},${s.pos.z.toFixed(4)}`).join("|");
    expect(fingerprint(a)).toBe(fingerprint(b));
    // 種を変えれば別の戦闘になる(コードが種を運んでいることの裏)
    const other = SCENARIOS.oldQuarter.make(9);
    const c = createWorld(other);
    runTicks(c, 120 * SIM_HZ);
    expect(fingerprint(c)).not.toBe(fingerprint(a));
  }, 300000);
});
