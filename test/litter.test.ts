import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { bearersNeeded, evacuatedCount } from "../src/sim/systems/litter.ts";
import { applyHit } from "../src/sim/systems/combat.ts";
import { orderCasevac } from "../src/sim/playerOrders.ts";
import { LITTER, SIM_HZ } from "../src/sim/constants.ts";
import type { Soldier } from "../src/sim/types.ts";

/** 分隊内の1名を「止血済みの負傷者」にする。 */
function downAndStabilize(w: ReturnType<typeof createWorld>, s: Soldier): void {
  s.status = "wia";
  s.stabilized = true;
  s.bleedOutTick = 0;
  void w;
}

describe("担架搬送(仕様 §9 [v5])", () => {
  it("搬送距離が50m以内なら2名、超えるなら4名を要する", () => {
    const w = createWorld(demoCrossingScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue")!;
    const ccp = w.ccp.blue;

    victim.pos = { x: ccp.x + 10, z: ccp.z };
    expect(bearersNeeded(victim, ccp)).toBe(2);

    victim.pos = { x: ccp.x + LITTER.TWO_MAN_MAX_DIST + 5, z: ccp.z };
    expect(bearersNeeded(victim, ccp)).toBe(4);
  });

  it("後送命令なしでは担架班が編成されない(仕様 §9: 搬送は明示的な命令を要する)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    downAndStabilize(w, victim);

    // この分隊長を人間の操作下に置き、AIの自動発令を止める(仕様 §4)。
    // 命令が出ていない状態で担架班が勝手に組まれないことを確認する。
    w.control = { echelon: "squad", side: "blue", unitId: victim.squadId };
    runTicks(w, SIM_HZ);
    expect(victim.evac).toBe("none");
    expect(victim.bearers.length).toBe(0);

    // 人間の分隊長が発令すれば、AIと同じ経路で担架班が組まれる
    expect(orderCasevac(w)).toBe(true);
    expect(victim.evac).toBe("requested");
    runTicks(w, 2);
    expect(victim.bearers.length).toBeGreaterThan(0);
  });

  it("止血済みの負傷者はAI分隊長の命令で担架班が編成され、CCPまで後送される", () => {
    const w = createWorld(demoCrossingScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    downAndStabilize(w, victim);

    // 敵と接触する前に決着させたいので、赤軍は戦場から外しておく
    for (const s of w.soldiers) if (s.side === "red") s.status = "kia";

    let sawCarrying = false;
    for (let i = 0; i < 120 * SIM_HZ; i++) {
      runTicks(w, 1);
      if (victim.evac === "carrying") sawCarrying = true;
      if (victim.evac === "evacuated") break;
    }

    expect(sawCarrying).toBe(true);
    expect(victim.evac).toBe("evacuated");
    // 後送完了時点でCCPの判定半径内にいる(仕様 §9: 3.0m)
    const d = Math.hypot(victim.pos.x - w.ccp.blue.x, victim.pos.z - w.ccp.blue.z);
    expect(d).toBeLessThanOrEqual(LITTER.EVAC_RADIUS + 0.01);
    // 担架要員は解放されている
    expect(w.soldiers.filter((s) => s.bearing !== null).length).toBe(0);
  }, 30000);

  it("担架要員は搬送中に射撃できない(仕様 §9)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    downAndStabilize(w, victim);

    let checked = false;
    for (let i = 0; i < 60 * SIM_HZ; i++) {
      runTicks(w, 1);
      if (victim.evac !== "carrying") continue;
      for (const id of victim.bearers) {
        const b = w.soldierById.get(id)!;
        // 搬送中は hold 命令で拘束され、combat も bearing を見て射撃を止める
        expect(b.order.kind).toBe("hold");
        expect(b.bearing).toBe(victim.id);
        checked = true;
      }
      if (checked) break;
    }
    expect(checked).toBe(true);
  }, 30000);

  it("分隊の戦力が足りなければ分隊長は後送を命じない(仕様 §9 のトレードオフ)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const victim = squad.find((s) => !s.isSquadLeader)!;
    downAndStabilize(w, victim);
    // 健常者を担架要員に必要な人数ぎりぎりまで減らす
    let left = 2;
    for (const s of squad) {
      if (s.id === victim.id) continue;
      if (left > 0) {
        left--;
        continue;
      }
      s.status = "kia";
    }

    runTicks(w, SIM_HZ);
    expect(victim.evac).toBe("none");
    expect(victim.bearers.length).toBe(0);
  });

  it("担架要員が倒れると班は解散し、条件が整えば組み直される", () => {
    const w = createWorld(demoCrossingScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    downAndStabilize(w, victim);
    for (const s of w.soldiers) if (s.side === "red") s.status = "kia";

    // 班が編成されるまで回す
    for (let i = 0; i < 30 * SIM_HZ && victim.bearers.length === 0; i++) runTicks(w, 1);
    expect(victim.bearers.length).toBeGreaterThan(0);

    const fallen = w.soldierById.get(victim.bearers[0]!)!;
    fallen.status = "kia";
    runTicks(w, 2);
    expect(fallen.bearing).toBeNull();
    expect(victim.bearers).not.toContain(fallen.id);
  }, 30000);

  it("実戦の中で後送が成立する — 止血だけで終わらない", () => {
    let evacuated = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const w = createWorld(platoonClashScenario(seed));
      runTicks(w, 9000);
      evacuated += evacuatedCount(w, "blue") + evacuatedCount(w, "red");
    }
    expect(evacuated).toBeGreaterThan(0);
  }, 120000);
});

describe("即死ルール(仕様 §9)", () => {
  /**
   * `[v7.4]` 規則そのものを確かめる。直接射撃は負傷者を狙わなくなったので、
   * 規則が効くのは範囲攻撃の巻き添えのとき。ここでは被弾の適用だけを見る。
   */
  it("行動不能中の兵士への追加被弾は、止血の有無に関わらず即時戦死", () => {
    const w = createWorld(demoCrossingScenario(2));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    victim.status = "wia";
    victim.stabilized = true;
    victim.bleedOutTick = 0;
    // 致死でない被弾でも、行動不能中なら中間状態を経ずに直接KIA
    applyHit(w, victim, true, false);
    expect(w.soldierById.get(victim.id)!.status).toBe("kia");
  });

  /**
   * `[v7.4]` 戦えない負傷者は戦闘外(hors de combat)。他に撃つ相手がいなくても、
   * 直接射撃の目標にはしない。以前はここで負傷者を死ぬまで撃っていた。
   */
  it("負傷して戦えない敵は、他に撃つ相手がいなくても直接射撃の目標にしない", () => {
    const w = createWorld(demoCrossingScenario(2));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    victim.status = "wia";
    victim.stabilized = true; // 出血で死なないようにして、被弾だけを見る
    victim.bleedOutTick = 0;
    for (const s of w.soldiers) {
      if (s.side === "blue" && s.id !== victim.id) s.status = "kia";
    }
    const shooter = w.soldiers.find((s) => s.side === "red" && s.role !== "grenadier")!;
    for (const s of w.soldiers) {
      if (s.side === "red" && s.id !== shooter.id) s.status = "kia";
    }
    const statusOf = () => w.soldierById.get(victim.id)!.status;
    // 負傷者の目の前6mに正対させ続ける。以前の実装ならこの条件で確実に撃ち殺していた
    for (let i = 0; i < 60 * SIM_HZ; i++) {
      shooter.pos = { x: victim.pos.x, z: victim.pos.z - 6 };
      shooter.facing = { x: 0, z: 1 };
      shooter.path = [];
      shooter.pathIdx = 0;
      runTicks(w, 1);
      if (statusOf() !== "wia") break;
    }
    expect(statusOf()).toBe("wia");
  }, 30000);
});
