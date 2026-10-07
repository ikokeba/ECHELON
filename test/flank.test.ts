import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks, stepWorld } from "../src/sim/step.ts";
import { demoCrossingScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import {
  chooseFlankSide,
  enemyFlankAnchor,
  flankSeparationDeg,
  flankWaypoint,
} from "../src/sim/c2/flank.ts";
import { FLANK } from "../src/sim/constants.ts";
import type { Contact, Vec2 } from "../src/sim/types.ts";

/**
 * 側面攻撃(`[v7.0]` 仕様 §6 / ATP 3-21.8 Battle Drill 1)。
 *
 * 以前は (1) 分隊長が 0.3 秒ごとに「敵に近いFT = ベース」を引き直すので役割が
 * 入れ替わり続け、(2) 機動組は接敵8秒で無条件に目標へ向き直り、(3) 小隊長には
 * 側面機動そのものが無かった。計測で、敵から見たベースと機動の角度差は
 * 分隊戦で平均26°、小隊戦で平均9.5°しかなかった。
 */

const contact = (pos: Vec2, confidence = 1): Contact => ({
  key: `c${pos.x},${pos.z}`,
  side: "red",
  pos,
  posError: 0,
  hopError: 0,
  lastSeenTick: 0,
  confidence,
});

describe("側面の幾何(c2/flank.ts)", () => {
  const threat = { x: 0, z: 0 };
  const base = { x: 0, z: -40 };

  it("経由点は決めた側へ STEP_DEG ずつ進み、90°で止まる", () => {
    let man: Vec2 = { ...base };
    const seps: number[] = [];
    for (let i = 0; i < 6; i++) {
      man = flankWaypoint(threat, base, man, 1, 30);
      seps.push(flankSeparationDeg(threat, base, man));
    }
    expect(seps[0]).toBeCloseTo(FLANK.STEP_DEG, 5);
    for (let i = 1; i < seps.length; i++)
      expect(seps[i]!).toBeGreaterThanOrEqual(seps[i - 1]! - 1e-9);
    expect(seps.at(-1)).toBeCloseTo(FLANK.TARGET_DEG, 5);
  });

  it("左右の符号は「ベース→敵の軸から見た向き」で、盤面を回しても同じ側になる", () => {
    // 軸を90°回した盤面で、同じ dir の経由点が同じ回転を受けること
    const a = flankWaypoint(threat, base, base, 1, 30);
    const base2 = { x: 40, z: 0 }; // base を +90° 回した位置
    const b = flankWaypoint(threat, base2, base2, 1, 30);
    // base (0,-40) → (40,0) の回転は (x,z) → (−z, x)
    expect(b.x).toBeCloseTo(-a.z, 5);
    expect(b.z).toBeCloseTo(a.x, 5);
  });

  it("別の敵がいる側には回らない", () => {
    const w = createWorld(demoCrossingScenario(1));
    const objective = { x: 0, z: 40 };
    const pick = (others: Contact[]) =>
      chooseFlankSide({
        threat: { x: 0, z: 0 },
        base: { x: 0, z: -30 },
        maneuver: { x: 0, z: -30 },
        objective,
        contacts: [contact({ x: 0, z: 0 }), ...others],
        radius: 25,
        cover: w.coverIndex,
        wallIndex: w.wallIndex,
        bounds: w.bounds,
      });
    // dir=+1 の90°地点。経由点を目標角まで進めて求める
    let left: Vec2 = { x: 0, z: -30 };
    for (let i = 0; i < 4; i++) left = flankWaypoint({ x: 0, z: 0 }, { x: 0, z: -30 }, left, 1, 25);
    const near = (p: Vec2): Contact[] => [
      contact({ x: p.x * 1.3, z: p.z * 1.3 }),
      contact({ x: p.x * 1.3 + 4, z: p.z * 1.3 }),
      contact({ x: p.x * 1.3 - 4, z: p.z * 1.3 }),
    ];
    // 左の90°地点のそばに別の敵の一団 → 右へ回る。右のそば → 左へ回る
    expect(pick(near(left))).toBe(-1);
    expect(pick(near({ x: -left.x, z: -left.z }))).toBe(1);
  });

  it("小隊は敵戦列の、回り込む側の端を中心に回る", () => {
    const line = [contact({ x: -20, z: 0 }), contact({ x: 0, z: 0 }), contact({ x: 20, z: 0 })];
    const t = { x: 0, z: 0 };
    const b = { x: 0, z: -40 };
    const wpLeft = flankWaypoint(t, b, b, 1, 30);
    const endLeft = enemyFlankAnchor(t, b, 1, line, 60);
    // 左回りの経由点と同じ側(x の符号)の端を選ぶ
    expect(Math.sign(endLeft.x)).toBe(Math.sign(wpLeft.x));
    expect(Math.abs(endLeft.x)).toBe(20);
    const endRight = enemyFlankAnchor(t, b, -1, line, 60);
    expect(endRight.x).toBe(-endLeft.x);
    // 遠すぎる接触は同じ列とみなさない
    expect(enemyFlankAnchor(t, b, 1, [contact({ x: wpLeft.x * 10, z: 0 })], 60)).toEqual(t);
  });
});

describe("分隊の側面攻撃(c2/squad.ts)", () => {
  it("一度決めたベース/機動の役割は、交戦中に入れ替わらない", () => {
    const w = createWorld(demoCrossingScenario(1));
    const prev = new Map<string, string>();
    let flips = 0;
    let assigned = 0;
    for (let t = 0; t < 2400; t++) {
      stepWorld(w);
      for (const sq of w.squads) {
        // 段取りを組み直した(突撃が一段落 / FT喪失)周期は数えない
        if (!sq.flank || sq.flank.sinceTick === w.tick) continue;
        for (const ft of w.fireteams) {
          if (ft.side !== sq.side || ft.squadId !== sq.squadId || !ft.assignedRole) continue;
          const k = `${ft.side}:${ft.squadId}:${ft.ftIndex}:${sq.flank.sinceTick}`;
          const p = prev.get(k);
          if (p && p !== ft.assignedRole) flips++;
          prev.set(k, ft.assignedRole);
          assigned++;
        }
      }
    }
    expect(assigned).toBeGreaterThan(0);
    expect(flips).toBe(0);
  });

  it("機動FTは敵から見てベースと60°以上離れた位置まで回り込む", () => {
    let best = 0;
    for (const seed of [1, 2]) {
      const w = createWorld(demoCrossingScenario(seed));
      for (let t = 0; t < 3600; t++) {
        stepWorld(w);
        if (t % 15) continue;
        for (const sq of w.squads) {
          const f = sq.flank;
          if (!f) continue;
          let th: Contact | null = null;
          for (const c of sq.belief.values())
            if (c.confidence > 0 && (!th || c.confidence > th.confidence)) th = c;
          if (!th) continue;
          const cen = (ftIndex: number): Vec2 | null => {
            const m = w.soldiers.filter(
              (s) =>
                s.side === sq.side &&
                s.squadId === sq.squadId &&
                s.fireteamId === ftIndex &&
                s.status === "ok",
            );
            if (m.length === 0) return null;
            return {
              x: m.reduce((a, s) => a + s.pos.x, 0) / m.length,
              z: m.reduce((a, s) => a + s.pos.z, 0) / m.length,
            };
          };
          const b = cen(f.baseKey);
          const m = cen(f.maneuverKey);
          if (b && m) best = Math.max(best, flankSeparationDeg(th.pos, b, m));
        }
      }
    }
    expect(best).toBeGreaterThanOrEqual(60);
  });
});

describe("小隊の側面攻撃(c2/platoon.ts)", () => {
  it("接敵すると1個分隊が支援射撃、別の1個分隊が側面へ回る", () => {
    const w = createWorld(platoonClashScenario(1));
    let seen = false;
    for (let i = 0; i < 90 && !seen; i++) {
      runTicks(w, 30);
      for (const pl of w.platoons) {
        if (!pl.flank) continue;
        const base = w.squads.find((s) => s.side === pl.side && s.squadId === pl.flank!.baseKey)!;
        const man = w.squads.find(
          (s) => s.side === pl.side && s.squadId === pl.flank!.maneuverKey,
        )!;
        expect(base.squadId).not.toBe(man.squadId);
        expect(base.mission.kind).toBe("support_by_fire");
        // 機動分隊は経由点へ向かっている(回り込み中)か、突撃に移っている
        expect(man.flankGoal !== null || man.flankAssault).toBe(true);
        seen = true;
      }
    }
    expect(seen).toBe(true);
  });
});
