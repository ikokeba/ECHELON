import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { collidesWallIndexed } from "../src/sim/wallIndex.ts";
import { insideBounds } from "../src/sim/cqb.ts";
import { assignFires } from "../src/sim/c2/fireControl.ts";
import type { Soldier } from "../src/sim/types.ts";

/** 最寄りの壁までのおおよその距離 m(空間索引への段階的な問い合わせで近似)。 */
function wallDist(w: ReturnType<typeof createWorld>, s: Soldier): number {
  for (const r of [1.4, 3.0, 6.0]) {
    if (collidesWallIndexed(w.wallIndex, s.pos.x, s.pos.z, r)) return r;
  }
  return 99;
}

/**
 * 接敵時の姿勢と選抜射手の運用(`[v6.4]` 4回目のテストプレイ指摘②③⑤)。
 *
 * ②「敵を目視したらまず隠れるのが基本では?」 → ATP 3-21.8 Battle Drill 2。
 * ③「道の真ん中で打ち合ってるのはなんで?」
 * ⑤「マークスマンは射界のとおる有利な場所に陣取ってる?」 → TC 3-22.9 / ATP 3-21.8。
 */
describe("接敵時の姿勢と選抜射手の運用(`[v6.4]`)", () => {
  it("指揮所と負傷者集合点は、部隊の後方にある(仕様 §11)", () => {
    // `[v6.3]` の盤面2倍化で展開線だけ動かした結果、中隊長・XO・無線手が
    // 自軍より70m前方に立ち、担架班は負傷者を敵側へ運んでいた。
    const w = createWorld(companyClashScenario(1));
    for (const side of ["blue", "red"] as const) {
      const line = w.soldiers.filter((s) => s.side === side && s.fireteamId >= 0);
      const co = w.companies.find((c) => c.side === side)!;
      const fwd = co.advanceDir;
      const lineDepth =
        line.reduce((a, s) => a + (s.pos.x * fwd.x + s.pos.z * fwd.z), 0) / line.length;
      const cpDepth = co.cp.x * fwd.x + co.cp.z * fwd.z;
      const ccp = w.ccp[side];
      const ccpDepth = ccp.x * fwd.x + ccp.z * fwd.z;
      // 前進方向に射影した深さが、戦列より小さい = 後方にある
      expect(cpDepth).toBeLessThan(lineDepth);
      expect(ccpDepth).toBeLessThan(cpDepth);
      // 盤外に出ていないこと(ナビグリッドは bounds から作られる)
      expect(ccp.x).toBeGreaterThan(w.bounds.minX);
      expect(ccp.x).toBeLessThan(w.bounds.maxX);
      expect(ccp.z).toBeGreaterThan(w.bounds.minZ);
      expect(ccp.z).toBeLessThan(w.bounds.maxZ);
    }
  });

  it("敵の選抜射手は優先目標として扱われる(ATP 3-21.8 火力の統制)", () => {
    const w = createWorld(companyClashScenario(1));
    const blue = w.soldiers.filter((s) => s.side === "blue").slice(0, 4);
    const redAll = w.soldiers.filter((s) => s.side === "red");
    const dm = redAll.find((s) => s.quals.designatedMarksman)!;
    const plain = redAll.find((s) => !s.quals.designatedMarksman && s.role === "rifleman")!;

    // 射手全員に「選抜射手と一般兵の2名だけが見えている」状態を作る
    for (const s of blue) {
      s.pos = { x: dm.pos.x, z: dm.pos.z - 20 };
      s.sees = [dm.id, plain.id];
      s.assignedTarget = null;
    }
    plain.pos = { x: dm.pos.x + 3, z: dm.pos.z };
    assignFires(w, blue);
    // 1名あたりの上限があるので全員ではないが、少なくとも1名は選抜射手へ向く
    expect(blue.some((s) => s.assignedTarget === dm.id)).toBe(true);
    // 優先度が同じなら順序で決まってしまうので、選抜射手のほうが先に埋まること
    const onDm = blue.filter((s) => s.assignedTarget === dm.id).length;
    const onPlain = blue.filter((s) => s.assignedTarget === plain.id).length;
    expect(onDm).toBeGreaterThanOrEqual(onPlain);
  });

  it("接敵中、選抜射手は一般兵より遠くから撃ち、前線には出ない", () => {
    const w = createWorld(companyClashScenario(1));
    let dmRange = 0;
    let dmN = 0;
    let rifRange = 0;
    let rifN = 0;
    let dmAhead = 0;
    let dmSamples = 0;
    let rifAhead = 0;
    let rifSamples = 0;

    for (let t = 0; t < 300; t++) {
      runTicks(w, 30);
      for (const s of w.soldiers) {
        if (s.status !== "ok" || s.fireteamId < 0) continue;
        const ft = w.fireteams.find(
          (f) => f.side === s.side && f.squadId === s.squadId && f.ftIndex === s.fireteamId,
        );
        if (ft?.mode !== "CONTACT") continue;
        const mates = w.soldiers.filter(
          (o) => o.side === s.side && o.squadId === s.squadId && o.status === "ok" && o.id !== s.id,
        );
        if (mates.length === 0) continue;
        const cz = mates.reduce((a, o) => a + o.pos.z, 0) / mates.length;
        const fwd = s.side === "blue" ? 1 : -1;
        const ahead = (s.pos.z - cz) * fwd > 0;
        if (s.quals.designatedMarksman) {
          dmSamples++;
          if (ahead) dmAhead++;
        } else if (s.role === "rifleman") {
          rifSamples++;
          if (ahead) rifAhead++;
        }
        if (s.sees.length === 0) continue;
        let nearest = Infinity;
        for (const id of s.sees) {
          const e = w.soldierById.get(id);
          if (e) nearest = Math.min(nearest, Math.hypot(e.pos.x - s.pos.x, e.pos.z - s.pos.z));
        }
        if (nearest === Infinity) continue;
        if (s.quals.designatedMarksman) {
          dmRange += nearest;
          dmN++;
        } else if (s.role === "rifleman") {
          rifRange += nearest;
          rifN++;
        }
      }
    }
    expect(dmN).toBeGreaterThan(50);
    expect(rifN).toBeGreaterThan(50);
    // 長射程の利を使っていること(修正前は 94m 対 67m で差が小さかった)
    expect(dmRange / dmN).toBeGreaterThan(rifRange / rifN + 15);
    // 突撃線に混ざっていないこと(修正前は選抜射手 36% 対 一般 74%)
    expect(dmAhead / dmSamples).toBeLessThan(rifAhead / rifSamples);
  }, 180000);

  it("開豁地に静止したまま撃ち合う兵士が少ない(ATP 3-21.8 Battle Drill 2)", () => {
    const w = createWorld(companyClashScenario(1));
    let engaged = 0;
    let exposedStatic = 0;
    const prev = new Map<number, { x: number; z: number }>();

    for (let t = 0; t < 400; t++) {
      runTicks(w, 15);
      for (const s of w.soldiers) {
        if (s.status !== "ok") continue;
        const p = prev.get(s.id);
        const moved = p ? Math.hypot(s.pos.x - p.x, s.pos.z - p.z) : 99;
        prev.set(s.id, { x: s.pos.x, z: s.pos.z });
        if (s.sees.length === 0) continue;
        if (w.buildings.some((b) => insideBounds(b.bounds, s.pos))) continue;
        engaged++;
        if (wallDist(w, s) > 3 && moved < 0.4) exposedStatic++;
      }
    }
    expect(engaged).toBeGreaterThan(1000);
    // 修正前は 10〜12%。横断中の一時的な露出は正常なので、静止したままのものだけを見る
    expect(exposedStatic / engaged).toBeLessThan(0.1);
  }, 180000);
});
