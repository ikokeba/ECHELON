import { describe, it, expect } from "vitest";
import { createWorld, type World } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { beginPlanning, beginBattle } from "../src/sim/c2/planning.ts";
import {
  assignPlatoonMission,
  orderControlledTo,
  orderFireMission,
  orderSmoke,
} from "../src/sim/playerOrders.ts";
import { applyReplay, replayCursor, startRecording, type ReplayEntry } from "../src/sim/replay.ts";
import { createLlmSession } from "../src/llm/session.ts";
import { ruleAgent } from "../src/llm/agent.ts";
import { SIM_HZ } from "../src/sim/constants.ts";

/**
 * 振り返り・リプレイ(`[v7.2]` ロードマップ S-4)。
 *
 * 守りたいのは1つ: **初期条件 + 命令の記録 = 同じ戦闘**。記録の中身は人間・LLM の命令と、
 * 外から変えられる設定(座席・スライダー・ドクトリン)の変化だけで、AI の判断は記録しない。
 */

function fresh(): World {
  const w = createWorld(companyClashScenario(3));
  beginPlanning(w);
  beginBattle(w);
  return w;
}

const fingerprint = (w: World) =>
  JSON.stringify({
    t: w.tick,
    s: w.soldiers.map((s) => [s.id, s.status, s.pos.x, s.pos.z]),
    o: w.objectives.map((o) => [o.owner, o.progress]),
    m: w.companies.map((c) => c.mortarRoundsUsed),
    k: w.smokes.length,
  });

/** 人間が色々触った戦闘を記録する */
async function playLive(): Promise<{ w: World; log: ReplayEntry[] }> {
  const w = fresh();
  startRecording(w);
  const co = w.companies.find((c) => c.side === "blue")!;
  const pl = w.platoons.find((p) => p.side === "blue")!;
  const sq = w.squads.find((s) => s.side === "blue")!;
  // LLM(規則エージェント)を赤の中隊長に座らせる。命令は同じ playerOrders を通る
  const llm = createLlmSession({
    seat: { side: "red", echelon: "company", unitId: w.companies.find((c) => c.side === "red")!.companyId },
    agent: ruleAgent(),
    intervalSec: 10,
  });
  llm.attach(w);
  for (let t = 0; t < 90 * SIM_HZ; t++) {
    if (t === 5 * SIM_HZ) {
      w.control = { side: "blue", echelon: "company", unitId: co.companyId };
      assignPlatoonMission(w, pl.platoonId, { kind: "support_by_fire", target: { x: 0, z: 0 } });
    }
    if (t === 20 * SIM_HZ) w.tuning.detectRange = 120; // 戦闘中のスライダー
    if (t === 30 * SIM_HZ) {
      w.control = { side: "blue", echelon: "squad", unitId: sq.squadId };
      const sl = w.soldierById.get(sq.commanderId!)!;
      orderSmoke(w, { x: sl.pos.x, z: sl.pos.z + 10 });
      orderControlledTo(w, { x: 10, z: 20 });
    }
    if (t === 50 * SIM_HZ) {
      w.control = { side: "blue", echelon: "company", unitId: co.companyId };
      orderFireMission(w, { x: 0, z: 60 });
    }
    if (t === 70 * SIM_HZ) w.control = null;
    if (t % (10 * SIM_HZ) === 0) await llm.decideNow(w);
    stepWorld(w);
  }
  llm.detach(w);
  return { w, log: w.log! };
}

describe("振り返り・リプレイ(`[v7.2]` S-4)", () => {
  it("記録は命令と設定の変化だけで、AI の判断は入らない", async () => {
    const { log } = await playLive();
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.kind === "order" && e.fn === "assignPlatoonMission")).toBe(true);
    expect(log.some((e) => e.kind === "order" && e.fn === "orderSmoke")).toBe(true);
    expect(log.some((e) => e.kind === "state" && e.state.tuning.detectRange === 120)).toBe(true);
    // 数十件で済む(90秒・2700ティックぶんの盤面を持つのではない)
    expect(log.length).toBeLessThan(200);
    // orderControlledTo の中で呼ばれる orderSquadTo は二重に記録しない
    expect(log.some((e) => e.kind === "order" && e.fn === "orderSquadTo")).toBe(false);
  }, 300000);

  it("初期条件 + 記録 で、同じ戦闘が1ビットも違わず再生される", async () => {
    const { w, log } = await playLive();
    const r = fresh();
    startRecording(r); // 再生しながら記録すれば、同じ記録ができる(続きから遊べる)
    const cur = replayCursor(log);
    while (r.tick < w.tick) {
      applyReplay(r, cur);
      stepWorld(r);
    }
    expect(fingerprint(r)).toBe(fingerprint(w));
    expect(JSON.stringify(r.log)).toBe(JSON.stringify(log));
  }, 300000);

  it("記録を入れずに回すと別の戦闘になる(記録が効いていることの確認)", async () => {
    const { w } = await playLive();
    const r = fresh();
    while (r.tick < w.tick) stepWorld(r);
    expect(fingerprint(r)).not.toBe(fingerprint(w));
  }, 300000);
});

describe("AAR — 信じていた位置と実際の位置(`[v7.2]` S-4)", () => {
  it("上の階層ほど像のずれが大きい(仕様 §5 の情報の階層が見える)", async () => {
    const { captureAarFrame, aarDue, aarMissByEchelon } = await import("../src/sim/aar.ts");
    const w = fresh();
    const frames = [];
    for (let t = 0; t < 180 * SIM_HZ; t++) {
      stepWorld(w);
      if (aarDue(w)) frames.push(captureAarFrame(w));
    }
    expect(frames.length).toBeGreaterThan(80);
    // 戦闘全体で平均を取る(陣営ごと)
    for (const side of ["blue", "red"] as const) {
      const acc = { company: [0, 0], platoon: [0, 0], squad: [0, 0] } as Record<string, number[]>;
      for (const f of frames) {
        const m = aarMissByEchelon(f, side);
        for (const e of ["company", "platoon", "squad"]) {
          const v = m[e as "company"];
          if (v.miss !== null) {
            acc[e]![0]! += v.miss;
            acc[e]![1]! += 1;
          }
        }
      }
      const avg = (e: string) => acc[e]![0]! / Math.max(1, acc[e]![1]!);
      expect(acc.squad![1]).toBeGreaterThan(0);
      expect(avg("platoon")).toBeGreaterThan(avg("squad"));
      expect(avg("company")).toBeGreaterThan(avg("squad"));
    }
    // フレームは読むだけ — 取っても取らなくても戦闘は同じ
    const r = fresh();
    while (r.tick < w.tick) stepWorld(r);
    expect(r.soldiers.map((s) => s.pos)).toEqual(w.soldiers.map((s) => s.pos));
  }, 300000);
});
