import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { stepWorld } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { FLASH_REPORT, REPORT_INTERVAL_SEC, SIM_HZ } from "../src/sim/constants.ts";
import type { Report } from "../src/sim/types.ts";
import type { World } from "../src/sim/world.ts";

/** ティックを進めながら、送信された報告をすべて拾う(world.reports は到達で消えるため) */
function runCollect(w: World, ticks: number, sent: Report[]): void {
  for (let i = 0; i < ticks; i++) {
    const before = new Set(w.reports);
    stepWorld(w);
    for (const r of w.reports) if (!before.has(r)) sent.push(r);
  }
}

describe("臨時報告(`[v7.3]` ロードマップ A-8)", () => {
  it("接敵したら定時を待たずに上がり、小隊長 → 中隊長へ1ホップずつ伝わる", () => {
    const w = createWorld(platoonClashScenario(3));
    const sent: Report[] = [];
    runCollect(w, 2400, sent);

    const squadFlash = sent.filter(
      (r) => r.fromEchelon === "squad" && r.flash?.includes("contact"),
    );
    expect(squadFlash.length).toBeGreaterThan(0);
    // 接敵の臨時報告は定時の周期(5秒)からずれた時刻に出ている = 定時を待っていない
    const interval = Math.round(REPORT_INTERVAL_SEC * SIM_HZ);
    expect(squadFlash.some((r) => r.sentTick % interval !== 0)).toBe(true);
    // 臨時報告にも確かな接触が載っている(中身は定時報告と同じ)
    for (const r of squadFlash) expect(r.contacts.length).toBeGreaterThan(0);

    // 小隊長の接敵の臨時報告は、最初の分隊の臨時報告が届いた後にしか出ない(生の視界を持たない)
    const firstSquad = Math.min(...squadFlash.map((r) => r.deliverTick));
    const plFlash = sent.filter((r) => r.fromEchelon === "platoon" && r.flash?.includes("contact"));
    expect(plFlash.length).toBeGreaterThan(0);
    for (const r of plFlash) expect(r.sentTick).toBeGreaterThanOrEqual(firstSquad);

    // UI 用の記録に受信分が残る(上限つき)
    expect(w.flashLog.length).toBeGreaterThan(0);
    expect(w.flashLog.length).toBeLessThanOrEqual(FLASH_REPORT.LOG_KEEP);
  });

  it("同じ送信元の臨時報告は最短間隔より詰まらない", () => {
    const w = createWorld(platoonClashScenario(2));
    const sent: Report[] = [];
    runCollect(w, 3000, sent);
    const gap = Math.round(FLASH_REPORT.MIN_GAP_SEC * SIM_HZ);
    const last = new Map<string, number>();
    for (const r of sent) {
      if (!r.flash) continue;
      const key = `${r.side}:${r.fromEchelon}:${r.fromUnitId}`;
      const prev = last.get(key);
      if (prev !== undefined) expect(r.sentTick - prev).toBeGreaterThanOrEqual(gap);
      last.set(key, r.sentTick);
    }
  });

  it("分隊長が倒れて次席者が継いだら、その分隊から臨時報告が上がる", () => {
    const w = createWorld(platoonClashScenario(1));
    const sent: Report[] = [];
    // 開戦直後の接敵の臨時報告から最短間隔ぶん離す
    runCollect(w, Math.round(FLASH_REPORT.MIN_GAP_SEC * SIM_HZ) + 30, sent);
    const sq = w.squads.find((s) => s.side === "blue" && s.commanderId !== null)!;
    const leader = w.soldierById.get(sq.commanderId!)!;
    leader.status = "kia";
    runCollect(w, 10, sent);
    expect(sq.commanderId).not.toBe(leader.id);
    const flash = sent.filter(
      (r) =>
        r.fromEchelon === "squad" && r.fromUnitId === sq.squadId && r.flash?.includes("commander"),
    );
    expect(flash.length).toBe(1);
  });

  it("開戦直後の指揮官の着任は臨時報告にならない", () => {
    const w = createWorld(platoonClashScenario(1));
    const sent: Report[] = [];
    runCollect(w, 20, sent);
    expect(sent.filter((r) => r.flash?.includes("commander"))).toHaveLength(0);
  });
});
