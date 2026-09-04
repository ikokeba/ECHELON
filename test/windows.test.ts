import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import { rollShot } from "../src/sim/systems/combat.ts";
import { windowPost, windowPostOf } from "../src/sim/systems/windows.ts";
import { createRng } from "../src/sim/rng.ts";
import { SIM_HZ, WINDOW } from "../src/sim/constants.ts";
import { collidesWall } from "../src/sim/geometry.ts";

/**
 * 窓(`[v6.10]` 仕様 §7/§8)。
 *
 * 窓と扉の違いはただ1つ、**視線は通すが人は通さない**こと。そこが崩れると
 * 突入ドリル(仕様 §7.2)が意味を失うので、いちばん厚く固定する。
 */
describe("窓(`[v6.10]` 仕様 §7/§8)", () => {
  const world = () => createWorld(companyClashScenario(1));

  it("すべての建物に窓がある", () => {
    const w = world();
    expect(w.buildings.length).toBeGreaterThan(0);
    for (const b of w.buildings) expect(b.windows.length).toBeGreaterThan(0);
  });

  /**
   * この2本が窓の定義そのもの。片方でも崩れたら窓は扉か壁のどちらかになる。
   *
   * 判定は**開口そのもの**で行う。「壁を跨いだ2点に射線が通るか」で書くと、
   * 窓のすぐ内側に中廊下の間仕切りがある建物で落ちる — 測っているのが窓ではなく
   * その建物の間取りになってしまう。
   */
  it("窓は視線を通す(視線用の壁に開口がある)", () => {
    const w = world();
    let checked = 0;
    for (const b of w.buildings.slice(0, 12)) {
      for (const win of b.windows) {
        expect(collidesWall(w.walls, win.pos.x, win.pos.z, 0.05)).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("窓は人を通さない(経路用の壁は塞がっている)", () => {
    const w = world();
    for (const b of w.buildings.slice(0, 12)) {
      for (const win of b.windows) {
        expect(collidesWall(w.navWalls, win.pos.x, win.pos.z, 0.05)).toBe(true);
      }
    }
  });

  /**
   * `[v6.10]` 経路用の壁は「視線用の壁 + 窓の栓」として導出する、という設計の確認。
   * 2本を別々に組み立てていたときは街路の塀を片方へ積み忘れ、経路探索が塀を素通り
   * できると誤認して担架班が900秒で5mしか進まなかった。**窓以外は完全に一致する**。
   */
  it("経路用の壁は、窓の栓を除いて視線用の壁と一致する", () => {
    const w = world();
    const key = (x: { cx: number; cz: number; hw: number; hd: number }) =>
      `${x.cx.toFixed(3)},${x.cz.toFixed(3)},${x.hw.toFixed(3)},${x.hd.toFixed(3)}`;
    const nav = new Set(w.navWalls.map(key));
    for (const wall of w.structuralWalls) expect(nav.has(key(wall))).toBe(true);
    // 差は窓の数ぶんだけ
    const windows = w.buildings.reduce((a, b) => a + b.windows.length, 0);
    expect(w.navWalls.length).toBe(w.structuralWalls.length + windows);
  });

  it("窓の法線は屋外を向いている", () => {
    const w = world();
    for (const b of w.buildings.slice(0, 8)) {
      const cx = (b.bounds.minX + b.bounds.maxX) / 2;
      const cz = (b.bounds.minZ + b.bounds.maxZ) / 2;
      for (const win of b.windows) {
        // 中心 → 窓 のベクトルと法線が同じ側を向く
        const dot = (win.pos.x - cx) * win.normal.x + (win.pos.z - cz) * win.normal.z;
        expect(dot).toBeGreaterThan(0);
      }
    }
  });

  it("窓の持ち場は建物の内側にあり、そこに立つと窓に就いた判定になる", () => {
    const w = world();
    const b = w.buildings[0]!;
    const win = b.windows[0]!;
    const post = windowPost(win);
    const s = w.soldiers[0]!;
    s.pos = { ...post };
    expect(windowPostOf(w, s)).not.toBeNull();
    // 部屋の中央へ動かすと外れる
    s.pos = { x: (b.bounds.minX + b.bounds.maxX) / 2, z: (b.bounds.minZ + b.bounds.maxZ) / 2 };
    expect(windowPostOf(w, s)).toBeNull();
  });

  /** 仕様 §8 の非対称。係数であって新しい機構ではない。 */
  it("窓から撃つと命中が上がり、窓の者を撃つと命中が下がる(仕様 §8)", () => {
    const N = 200000;
    const hits = (ctx: Parameters<typeof rollShot>[1]) => {
      const rng = createRng(4242);
      let n = 0;
      for (let i = 0; i < N; i++) if (rollShot(rng, ctx).hit) n++;
      return n;
    };
    const base = {
      shooterSuppressed: false,
      shooterIsMarksman: false,
      shooterMoving: false,
      shooterIsSaw: false,
    };
    const plain = hits(base);
    const fromWindow = hits({ ...base, shooterAtWindow: true });
    const atWindow = hits({ ...base, targetAtWindow: true });

    expect(fromWindow / plain).toBeGreaterThan(WINDOW.SHOOTER_ACC_MUL - 0.05);
    expect(fromWindow / plain).toBeLessThan(WINDOW.SHOOTER_ACC_MUL + 0.05);
    expect(atWindow / plain).toBeGreaterThan(WINDOW.TARGET_ACC_MUL - 0.05);
    expect(atWindow / plain).toBeLessThan(WINDOW.TARGET_ACC_MUL + 0.05);

    // 窓越しの撃ち合いは両方の係数が掛かる
    const both = hits({ ...base, shooterAtWindow: true, targetAtWindow: true });
    const expected = WINDOW.SHOOTER_ACC_MUL * WINDOW.TARGET_ACC_MUL;
    expect(both / plain).toBeGreaterThan(expected - 0.05);
    expect(both / plain).toBeLessThan(expected + 0.05);
  });

  /** 要望「防衛時に積極的に活用するようなロジック」の確認。 */
  it("実戦で守勢の部隊が窓に就く", () => {
    const w = world();
    beginPlanning(w);
    beginBattle(w);
    let peak = 0;
    let total = 0;
    let samples = 0;
    for (let t = 0; t < 240 * SIM_HZ; t++) {
      stepWorld(w);
      if (t % SIM_HZ !== 0) continue;
      const n = w.soldiers.filter((s) => s.atWindow).length;
      peak = Math.max(peak, n);
      total += n;
      samples++;
    }
    // 実測は平均15名前後・最大30名。機能していることだけを固定する
    expect(peak).toBeGreaterThanOrEqual(8);
    expect(total / samples).toBeGreaterThan(2);
  }, 300000);
});
