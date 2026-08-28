import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario, demoCrossingScenario } from "../src/sim/scenario.ts";
import { aidTicksFor } from "../src/sim/systems/casualties.ts";
import { BLEED_OUT_SEC, BUDDY_AID_SEC, SIM_DT, SIM_HZ } from "../src/sim/constants.ts";

describe("MOS / 資格(仕様 §14)", () => {
  it("各FTは リーダー/SAW/擲弾手/ライフルマン の4名で構成される", () => {
    const w = createWorld(demoCrossingScenario(1));
    const ft = w.soldiers.filter(
      (s) => s.side === "blue" && s.squadId === 0 && s.fireteamId === 0,
    );
    expect(ft.length).toBe(4);
    expect(ft.map((s) => s.role).sort()).toEqual(["grenadier", "leader", "rifleman", "saw"]);
  });

  it("各FTのライフルマン1名が衛生要員を兼任する(仕様 §9/§14 [v6])", () => {
    const w = createWorld(demoCrossingScenario(1));
    for (const ftIdx of [0, 1]) {
      const ft = w.soldiers.filter(
        (s) => s.side === "blue" && s.squadId === 0 && s.fireteamId === ftIdx,
      );
      const medics = ft.filter((s) => s.quals.medicalCrossTrained);
      expect(medics.length).toBe(1);
      expect(medics[0]!.role).toBe("rifleman");
    }
  });

  it("選抜射手は分隊に1名、ブラボー組のライフルマンが兼任する(仕様 §14)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const dms = squad.filter((s) => s.quals.designatedMarksman);
    expect(dms.length).toBe(1);
    expect(dms[0]!.fireteamId).toBe(1);
    expect(dms[0]!.role).toBe("rifleman");
  });
});

describe("バディエイド(仕様 §9)", () => {
  it("処置時間はFT単位MOS 2段階モデルに従う(通常3秒 / 衛生兼任1.5秒)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const medic = squad.find((s) => s.quals.medicalCrossTrained)!;
    const plain = squad.find((s) => !s.quals.medicalCrossTrained)!;

    expect(aidTicksFor(medic)).toBe(Math.round(BUDDY_AID_SEC.crossTrained / SIM_DT));
    expect(aidTicksFor(plain)).toBe(Math.round(BUDDY_AID_SEC.normal / SIM_DT));
    expect(aidTicksFor(medic)).toBeLessThan(aidTicksFor(plain));
  });

  it("負傷者に最寄りの健常な同分隊員が担当として割り当てられる", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const victim = squad.find((s) => !s.isSquadLeader)!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + Math.round(BLEED_OUT_SEC / SIM_DT);

    runTicks(w, 2);
    expect(victim.assignedAider).not.toBeNull();
    const aider = w.soldierById.get(victim.assignedAider!)!;
    expect(aider.side).toBe(victim.side);
    expect(aider.squadId).toBe(victim.squadId);
    expect(aider.status).toBe("ok");
  });

  it("脅威がなければ即座に手当し、止血して出血タイマーが止まる", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const victim = squad.find((s) => !s.isSquadLeader)!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + Math.round(BLEED_OUT_SEC / SIM_DT);

    // 敵はまだ遠く、交戦していない。移動+処置に十分な時間を与える
    runTicks(w, Math.round(20 * SIM_HZ));

    expect(victim.stabilized).toBe(true);
    expect(victim.bleedOutTick).toBe(0);
    expect(victim.status).toBe("wia"); // 止血しても行動不能のまま(仕様 §9)
  });

  it("止血済みの負傷者はもうKIAへ移行しない", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const victim = squad.find((s) => !s.isSquadLeader)!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + Math.round(BLEED_OUT_SEC / SIM_DT);

    runTicks(w, Math.round(20 * SIM_HZ));
    expect(victim.stabilized).toBe(true);

    // 出血タイマー分を大きく超えて回しても死なない
    runTicks(w, Math.round(BLEED_OUT_SEC * 2 * SIM_HZ));
    expect(victim.status).toBe("wia");
  });

  it("未処置のまま45秒経過すればKIAへ移行する(担当が到達できない場合)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue" && !s.isSquadLeader)!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + Math.round(BLEED_OUT_SEC / SIM_DT);
    // 全ての味方を戦闘不能にし、手当できる者がいない状況を作る
    for (const s of w.soldiers) {
      if (s.side === "blue" && s.id !== victim.id) s.status = "kia";
    }
    runTicks(w, Math.round((BLEED_OUT_SEC + 2) * SIM_HZ));
    expect(victim.status).toBe("kia");
  });

  it("処置中の兵士は射撃しない(仕様 §9: 処置中は無防備)", () => {
    const w = createWorld(demoCrossingScenario(1));
    const squad = w.soldiers.filter((s) => s.side === "blue" && s.squadId === 0);
    const victim = squad.find((s) => !s.isSquadLeader)!;
    victim.status = "wia";
    victim.bleedOutTick = w.tick + Math.round(BLEED_OUT_SEC / SIM_DT);

    let sawTreating = false;
    for (let i = 0; i < Math.round(20 * SIM_HZ); i++) {
      runTicks(w, 1);
      const aider = w.soldiers.find((s) => s.treating !== null && s.aidProgressTicks > 0);
      if (aider) {
        sawTreating = true;
        expect(aider.order.kind).toBe("hold");
      }
    }
    expect(sawTreating).toBe(true);
  });

  it("実戦の中で負傷者が救われる — 全員が出血死するわけではない", () => {
    let stabilizedTotal = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const w = createWorld(platoonClashScenario(seed));
      runTicks(w, 6000);
      stabilizedTotal += w.soldiers.filter((s) => s.stabilized).length;
    }
    expect(stabilizedTotal).toBeGreaterThan(0);
  }, 60000);
});
