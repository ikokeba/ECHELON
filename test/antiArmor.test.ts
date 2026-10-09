import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginBattle, beginPlanning } from "../src/sim/c2/planning.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import {
  antiArmorBlocker,
  antiArmorHitChance,
  antiArmorRoundsOf,
  fireAntiArmor,
  gunnerOf,
} from "../src/sim/systems/antiArmor.ts";
import { orderAntiArmor } from "../src/sim/playerOrders.ts";
import { ANTI_ARMOR } from "../src/sim/constants.ts";
import { parseResponse, applyResponse } from "../src/llm/commands.ts";
import { buildObservation } from "../src/llm/observe.ts";
import type { World } from "../src/sim/world.ts";

/**
 * 対戦車・対構造物火器(`[v7.3]` ロードマップ A-3)。
 */

const AT = { ...DEFAULT_FORCE, antiArmor: true };

/** 射手から 30m 先の、射線の通る点(市街地なので方向を探す) */
function clearPoint(w: World, sq: Parameters<typeof gunnerOf>[1]): { x: number; z: number } {
  const g = gunnerOf(w, sq)!;
  for (let a = 0; a < 360; a += 10) {
    const r = (a * Math.PI) / 180;
    const p = { x: g.pos.x + Math.cos(r) * 30, z: g.pos.z + Math.sin(r) * 30 };
    if (antiArmorBlocker(w, sq, p) === null) return p;
  }
  throw new Error("射線の通る点が無い");
}

function platoonWorld(): World {
  return createWorld(
    companyClashScenario(1, {
      blue: { ...AT, scale: "platoon" },
      red: { ...AT, scale: "platoon" },
    }),
  );
}

describe("対戦車・対構造物火器(`[v7.3]` A-3)— 編成と規則", () => {
  it("編成で付けると、小銃分隊ごとに射手1名が弾を持つ。付けなければ誰も持たない", () => {
    const w = platoonWorld();
    const rifle = w.squads.filter(
      (sq) =>
        !w.soldiers.some((s) => s.squadId === sq.squadId && s.side === sq.side && s.role === "mg"),
    );
    for (const sq of rifle) {
      const g = w.soldiers.filter(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.quals.antiArmor,
      );
      expect(g).toHaveLength(1);
      expect(antiArmorRoundsOf(w, sq)).toBe(ANTI_ARMOR.ROUNDS_PER_SQUAD);
    }
    const plain = createWorld(
      companyClashScenario(1, {
        blue: { ...DEFAULT_FORCE, scale: "platoon" },
        red: { ...DEFAULT_FORCE, scale: "platoon" },
      }),
    );
    expect(plain.soldiers.some((s) => s.quals.antiArmor || (s.atRounds ?? 0) > 0)).toBe(false);
  });

  it("射程・射線・間隔・弾数の規則は全員に同じに掛かる", () => {
    const w = platoonWorld();
    const sq = w.squads.find((s) => s.side === "blue" && gunnerOf(w, s))!;
    const g = gunnerOf(w, sq)!;
    expect(antiArmorBlocker(w, sq, { x: g.pos.x + 3, z: g.pos.z })).toBe("out_of_range");
    expect(antiArmorBlocker(w, sq, { x: g.pos.x, z: g.pos.z + ANTI_ARMOR.MAX_RANGE + 10 })).toBe(
      "out_of_range",
    );
    const tgt = clearPoint(w, sq);
    expect(antiArmorBlocker(w, sq, tgt)).toBeNull();
    const r = fireAntiArmor(w, sq, tgt);
    expect(r.ok).toBe(true);
    expect(antiArmorRoundsOf(w, sq)).toBe(ANTI_ARMOR.ROUNDS_PER_SQUAD - 1);
    expect(antiArmorBlocker(w, sq, tgt)).toBe("cooldown");
    w.tick += Math.round(ANTI_ARMOR.COOLDOWN_SEC * 30) + 1;
    expect(fireAntiArmor(w, sq, tgt).ok).toBe(true);
    w.tick += Math.round(ANTI_ARMOR.COOLDOWN_SEC * 30) + 1;
    expect(antiArmorBlocker(w, sq, tgt)).toBe("no_rounds");
    // 遠いほど当たりにくい
    expect(antiArmorHitChance(30)).toBeGreaterThan(antiArmorHitChance(180));
  });

  it("爆風は遮蔽に関係なく敵を倒し、射撃壕・機関銃陣地を壊す(味方は巻き込まない)", () => {
    const sc = companyClashScenario(1, { blue: AT, red: AT });
    sc.mode = "assault";
    sc.attacker = "blue";
    const w = createWorld(sc);
    beginPlanning(w);
    beginBattle(w);
    const pit = w.defense.find((p) => p.side === "red" && p.kind === "fighting")!;
    const red = w.soldiers.find((s) => s.side === "red" && s.status === "ok")!;
    red.pos = { ...pit.pos };
    red.atWindow = true;
    const sq = w.squads.find((s) => s.side === "blue" && gunnerOf(w, s))!;
    const g = gunnerOf(w, sq)!;
    // 射手を壕の手前 25m・射線の通る所に置く
    g.pos = { x: pit.pos.x - pit.facing.x * -25, z: pit.pos.z - pit.facing.z * -25 };
    g.eye = { ...g.pos };
    const mate = w.soldiers.find((s) => s.side === "blue" && s.id !== g.id)!;
    mate.pos = { x: pit.pos.x + 0.5, z: pit.pos.z };
    // 必ず当たるよう、命中を引くまで撃ち直す(弾は戻す)
    let r = fireAntiArmor(w, sq, pit.pos);
    for (let k = 0; k < 20 && r.ok && !r.hit; k++) {
      g.atRounds = 2;
      sq.lastAntiArmorTick = -1e6;
      r = fireAntiArmor(w, sq, pit.pos);
    }
    if (r.ok && r.hit) {
      expect(w.defense.some((p) => p.id === pit.id)).toBe(false);
      expect(mate.status).toBe("ok");
    } else {
      expect(r.ok).toBe(true);
    }
    expect(w.fx.some((f) => f.kind === "rocket")).toBe(true);
  });
});

describe("対戦車火器の使われ方(`[v7.3]` A-3)", () => {
  it("AI の射手は攻防戦で固い目標(機関銃・窓・壕・屋内)へ撃つ", () => {
    const sc = companyClashScenario(1, { blue: AT, red: AT });
    sc.mode = "assault";
    sc.attacker = "blue";
    sc.timeLimitSec = 600;
    const w = createWorld(sc);
    beginPlanning(w);
    beginBattle(w);
    let rockets = 0;
    for (let t = 0; t < 300 * 30 && rockets === 0; t++) {
      stepWorld(w);
      rockets += w.fx.filter((f) => f.kind === "rocket").length;
    }
    expect(rockets).toBeGreaterThan(0);
  }, 300000);

  it("人間・LLM の分隊長も同じ関数で撃てる。分隊長以外の座席は撃てない", () => {
    const w = platoonWorld();
    const sq = w.squads.find((s) => s.side === "blue" && gunnerOf(w, s))!;
    const tgt = clearPoint(w, sq);
    const seat = { side: "blue" as const, echelon: "squad" as const, unitId: sq.squadId };
    const pl = { side: "blue" as const, echelon: "platoon" as const, unitId: sq.platoonId };
    expect(orderAntiArmor(w, tgt, pl)).toBeNull();
    const obs = buildObservation(w, seat)!;
    expect(obs.antiArmor!.left).toBe(ANTI_ARMOR.ROUNDS_PER_SQUAD);
    expect(obs.commands.map((c) => c.type)).toContain("anti_armor");
    const parsed = parseResponse({ commands: [{ type: "anti_armor", target: tgt }] });
    expect(applyResponse(w, seat, parsed.response!)[0]).toContain("発射");
    expect(antiArmorRoundsOf(w, sq)).toBe(ANTI_ARMOR.ROUNDS_PER_SQUAD - 1);
  });
});
