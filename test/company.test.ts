import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { commandFactor, isDegraded } from "../src/sim/c2/succession.ts";
import {
  CASEVAC_ARRIVAL_SEC,
  DEGRADE_FACTOR,
  DEGRADE_SEC,
  REPORT_INTERVAL_SEC,
  SIM_HZ,
} from "../src/sim/constants.ts";

describe("中隊層(仕様 §3①, §5, §11)", () => {
  it("中隊本部はCPに、1SGはCCPに常駐する(仕様 §2, §11)", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    const hq = w.soldiers.filter((s) => s.side === "blue" && s.hqRole !== null);

    for (const role of ["co", "xo", "coRto"] as const) {
      const m = hq.find((s) => s.hqRole === role)!;
      expect(Math.hypot(m.pos.x - co.cp.x, m.pos.z - co.cp.z)).toBeLessThan(4);
    }
    const sgt = hq.find((s) => s.hqRole === "firstSergeant")!;
    const ccp = w.ccp.blue;
    expect(Math.hypot(sgt.pos.x - ccp.x, sgt.pos.z - ccp.z)).toBeLessThan(1);
  });

  it("中隊長のbeliefは小隊長より遅れて埋まる(仕様 §5: 無線2ホップ)", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    expect(co.belief.size).toBe(0);

    // 分隊→小隊→中隊で報告が2ホップ必要なので、中隊長が知るのは必ず後になる
    let platoonKnewAtTick = -1;
    let companyKnewAtTick = -1;
    for (let t = 0; t < 200 * SIM_HZ; t++) {
      runTicks(w, 1);
      const anyPlatoon = w.platoons.some((p) => p.side === "blue" && p.belief.size > 0);
      if (platoonKnewAtTick < 0 && anyPlatoon) platoonKnewAtTick = w.tick;
      if (companyKnewAtTick < 0 && co.belief.size > 0) companyKnewAtTick = w.tick;
      if (companyKnewAtTick >= 0) break;
    }

    expect(platoonKnewAtTick).toBeGreaterThan(0);
    expect(companyKnewAtTick).toBeGreaterThan(platoonKnewAtTick);
  }, 120000);

  it("中隊長が知る敵位置は、小隊長のそれより粗い(仕様 §5: ホップごとに粒度低下)", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    for (let t = 0; t < 200 * SIM_HZ && co.belief.size === 0; t++) runTicks(w, 1);
    expect(co.belief.size).toBeGreaterThan(0);

    // 同じ接触について、中隊長の hopError は小隊長のそれより必ず大きい
    let compared = 0;
    for (const [key, c] of co.belief) {
      for (const pl of w.platoons.filter((p) => p.side === "blue")) {
        const p = pl.belief.get(key);
        if (!p) continue;
        expect(c.hopError).toBeGreaterThan(p.hopError);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  }, 120000);

  it("中隊長が麾下小隊へ担当区域を割り当てる(仕様 §3①)", () => {
    const w = createWorld(companyClashScenario(1));
    runTicks(w, Math.round(10 * SIM_HZ));
    const co = w.companies.find((c) => c.side === "blue")!;
    expect(co.platoonObjectives.size).toBe(3);
    // 3個小隊の目標が互いに離れている = 区域として分けられている
    const objs = [...co.platoonObjectives.values()];
    const spread = Math.max(...objs.map((o) => Math.hypot(o.x - objs[0]!.x, o.z - objs[0]!.z)));
    expect(spread).toBeGreaterThan(10);
  }, 30000);
});

describe("指揮継承(仕様 §12 C2 Decapitation)", () => {
  it("開始時点で全階層に指揮官が着任していて、劣化していない", () => {
    const w = createWorld(companyClashScenario(1));
    for (const sq of w.squads) {
      expect(sq.commanderId).not.toBeNull();
      expect(isDegraded(sq)).toBe(false);
    }
    for (const pl of w.platoons) expect(isDegraded(pl)).toBe(false);
    for (const co of w.companies) expect(isDegraded(co)).toBe(false);
  });

  it("分隊長が倒れると次席のFTリーダーへ即時継承される", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads.find((s) => s.side === "blue")!;
    const leader = w.soldierById.get(sq.commanderId!)!;
    expect(leader.isSquadLeader).toBe(true);

    leader.status = "kia";
    runTicks(w, 1);

    expect(sq.commanderId).not.toBe(leader.id);
    const successor = w.soldierById.get(sq.commanderId!)!;
    expect(successor.isFireteamLeader).toBe(true);
    expect(successor.squadId).toBe(sq.squadId);
    // 継承は即時。ただし引き継ぎ直後の判断の質は落ちる(仕様 §12)
    expect(isDegraded(sq)).toBe(true);
  });

  it("中隊長が倒れるとXOが繰り上がる(仕様 §11)", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    const commander = w.soldierById.get(co.commanderId!)!;
    expect(commander.hqRole).toBe("co");

    commander.status = "kia";
    runTicks(w, 1);

    const successor = w.soldierById.get(co.commanderId!)!;
    expect(successor.hqRole).toBe("xo");
    expect(isDegraded(co)).toBe(true);
  });

  it("判断の質は継承直後に最も低く、階層ごとの時間で線形に回復する", () => {
    const w = createWorld(platoonClashScenario(1));
    const sq = w.squads.find((s) => s.side === "blue")!;
    sq.degradedSinceTick = w.tick;

    expect(commandFactor(sq, w.tick, "squad")).toBeCloseTo(DEGRADE_FACTOR, 5);
    const half = w.tick + Math.round((DEGRADE_SEC.squad / 2) * SIM_HZ);
    expect(commandFactor(sq, half, "squad")).toBeCloseTo((1 + DEGRADE_FACTOR) / 2, 2);
    // 回復窓を過ぎたら平常に戻り、劣化フラグ自体が下りる
    expect(commandFactor(sq, w.tick + DEGRADE_SEC.squad * SIM_HZ, "squad")).toBe(1);
    expect(isDegraded(sq)).toBe(false);
  });

  it("影響の持続時間は階層が上がるほど長い(仕様 §12)", () => {
    expect(DEGRADE_SEC.squad).toBeLessThan(DEGRADE_SEC.platoon);
    expect(DEGRADE_SEC.platoon).toBeLessThan(DEGRADE_SEC.company);
  });

  it("中隊長が無力化されている間は小隊→中隊の報告が遅延する(仕様 §11)", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    // 中隊長とXOを倒し、繰り上がりを発生させる
    for (const s of w.soldiers) {
      if (s.side === "blue" && (s.hqRole === "co" || s.hqRole === "xo")) s.status = "kia";
    }
    runTicks(w, 1);
    expect(isDegraded(co)).toBe(true);

    // 劣化中に送られた小隊→中隊の報告は、通常より長い遅延を持つ
    runTicks(w, Math.round(REPORT_INTERVAL_SEC * SIM_HZ) + 2);
    const blueUp = w.reports.filter((r) => r.side === "blue" && r.fromEchelon === "platoon");
    const redUp = w.reports.filter((r) => r.side === "red" && r.fromEchelon === "platoon");
    expect(blueUp.length).toBeGreaterThan(0);
    expect(redUp.length).toBeGreaterThan(0);
    const blueLatency = blueUp[0]!.deliverTick - blueUp[0]!.sentTick;
    const redLatency = redUp[0]!.deliverTick - redUp[0]!.sentTick;
    expect(blueLatency).toBeGreaterThan(redLatency);
  }, 30000);
});

describe("後送要請・補充兵(仕様 §9)", () => {
  it("後送アセットは中隊が保有し、要請があって初めて発進する", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    expect(co.assets.length).toBeGreaterThan(0);
    expect(co.assets.every((a) => a.arriveTick === null)).toBe(true);

    // CCPへ到達済みの負傷者を1名でっち上げる
    const victim = w.soldiers.find(
      (s) => s.side === "blue" && s.hqRole === null && !s.isSquadLeader,
    )!;
    victim.status = "wia";
    victim.stabilized = true;
    victim.evac = "evacuated";

    runTicks(w, 2);
    const busy = co.assets.filter((a) => a.arriveTick !== null);
    expect(busy.length).toBe(1);
    // 到着まで仕様 §9 の3〜8分の幅に収まる
    const sec = (busy[0]!.arriveTick! - w.tick) / SIM_HZ;
    expect(sec).toBeGreaterThanOrEqual(CASEVAC_ARRIVAL_SEC.min - 1);
    expect(sec).toBeLessThanOrEqual(CASEVAC_ARRIVAL_SEC.max);
  });

  it("アセット到着で負傷者が収容され、同じMOSの補充兵が分隊へ合流する(仕様 §9)", () => {
    const w = createWorld(companyClashScenario(1));
    const victim = w.soldiers.find(
      (s) => s.side === "blue" && s.role === "saw" && s.squadId === 0,
    )!;
    victim.status = "wia";
    victim.stabilized = true;
    victim.evac = "evacuated";

    // 補充兵は新しいIDで追加されるので、開始時点のIDの上限で切り分ける
    const idCeiling = w.nextSoldierId;

    runTicks(w, Math.round((CASEVAC_ARRIVAL_SEC.max + 10) * SIM_HZ));

    expect(victim.evac).toBe("collected");
    const joined = w.soldiers.filter((s) => s.id >= idCeiling && s.side === "blue");
    const replacement = joined.find((s) => s.squadId === 0 && s.role === "saw");
    expect(replacement).toBeDefined();
    // MOSと編成上の居場所は継承する
    expect(replacement!.fireteamId).toBe(victim.fireteamId);
    expect(replacement!.quals.medicalCrossTrained).toBe(victim.quals.medicalCrossTrained);
    // 階級章は継承しない — 補充されるのは一兵卒であって下士官ではない
    expect(replacement!.isSquadLeader).toBe(false);
    expect(replacement!.isFireteamLeader).toBe(false);
    // 合流後は普通の隊員として扱われる — 後送状態を引き継いだりはしない。
    // (合流後に戦死しうるので status までは問わない。それは戦況の話)
    expect(replacement!.evac).toBe("none");
  }, 120000);

  it("後送済み・収容済みの兵士は戦場から外れる(索敵にも戦闘にも出てこない)", () => {
    const w = createWorld(companyClashScenario(1));
    const victim = w.soldiers.find((s) => s.side === "blue" && s.hqRole === null)!;
    victim.status = "wia";
    victim.stabilized = true;
    victim.evac = "evacuated";
    runTicks(w, 2);
    expect(w.soldiers.every((s) => !s.sees.includes(victim.id))).toBe(true);
  });
});

describe("任務種別(WHAT。`[v6.1]` OQ-3)", () => {
  it("初期状態は全階層 seize、火器分隊も seize から始まる", () => {
    const w = createWorld(companyClashScenario(1));
    expect(w.platoons.every((p) => p.mission.kind === "seize")).toBe(true);
    expect(w.squads.every((s) => s.mission.kind === "seize")).toBe(true);
  });

  it("展開すると seize / support_by_fire / screen の3種が使われる", () => {
    const w = createWorld(companyClashScenario(1));
    const kinds = new Set<string>();
    for (let i = 0; i < 30 && !w.victory; i++) {
      runTicks(w, 5 * 30);
      for (const sq of w.squads) kinds.add(sq.mission.kind);
      for (const pl of w.platoons) kinds.add(pl.mission.kind);
    }
    // 火器分隊は必ず support_by_fire、ライフル分隊は seize、両端小隊は screen
    expect(kinds.has("support_by_fire")).toBe(true);
    expect(kinds.has("seize")).toBe(true);
    expect(kinds.has("screen")).toBe(true);
  }, 60000);

  it("火器分隊は常に support_by_fire を受け、機動には出ない", () => {
    const w = createWorld(companyClashScenario(1));
    runTicks(w, 40 * 30);
    for (const sq of w.squads) {
      const isWeapons = w.soldiers.some(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.role === "mg",
      );
      if (isWeapons) expect(sq.mission.kind).toBe("support_by_fire");
    }
    // support_by_fire / screen の分隊のFTは maneuver 役を持たない
    for (const sq of w.squads) {
      if (sq.mission.kind === "seize") continue;
      const fts = w.fireteams.filter((f) => f.side === sq.side && f.squadId === sq.squadId);
      expect(fts.every((f) => f.assignedRole !== "maneuver")).toBe(true);
    }
  }, 60000);
});
