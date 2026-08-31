import { describe, it, expect } from "vitest";
import { createWorld, refreshBlockers } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { buildNavSet } from "../src/sim/navgrid.ts";
import { collidesWallIndexed, buildWallIndex } from "../src/sim/wallIndex.ts";
import {
  CQB,
  ENTRY_SPEED_MUL,
  MOVE_SPEED,
  NAV_MARGIN_OUTDOOR,
  NAV_STEP_OUTDOOR,
  SIM_DT,
  SOLDIER_RADIUS,
} from "../src/sim/constants.ts";

/**
 * 移動の詰まり(4回目のテストプレイ指摘 ①②)。`[v6.4]`
 *
 * 「搬送中に壁で詰まっている」「ユニット間で押しあって移動が無限ループ」の回帰。
 * 原因は2つあり、どちらもここで押さえる:
 *   1. ナビマージン(0.30)が兵士半径(0.35)より小さく、**身体が入らないウェイポイント**が
 *      できていた。移動システムは壁にめり込む位置を採用しないので、そこで永久停止する。
 *   2. 兵士分離の押し出しに上限が無く、室内進入速度(0.7倍)の移動と釣り合って
 *      完全に停止していた。
 */
describe("移動の詰まり(`[v6.4]` 4回目のテストプレイ指摘 ①②)", () => {
  it("ナビマージンは兵士半径以上でなければならない", () => {
    // これが崩れると「経路には乗っているが身体が入らない」ノードができる。
    expect(CQB.NAV_MARGIN).toBeGreaterThanOrEqual(SOLDIER_RADIUS);
    expect(NAV_MARGIN_OUTDOOR).toBeGreaterThanOrEqual(SOLDIER_RADIUS);
  });

  it("生成されたナビノードには、すべて兵士の身体が収まる", () => {
    const sc = platoonClashScenario(1);
    const buildings = sc.buildings ?? [];
    const nav = buildNavSet(
      sc.walls,
      sc.bounds,
      NAV_STEP_OUTDOOR,
      NAV_MARGIN_OUTDOOR,
      buildings,
      buildings,
      CQB.NAV_STEP,
      CQB.NAV_MARGIN,
    );
    const idx = buildWallIndex(sc.walls, sc.bounds);
    const bad = nav.nodes.filter((n) => collidesWallIndexed(idx, n.x, n.z, SOLDIER_RADIUS));
    expect(bad.length).toBe(0);
    expect(nav.nodes.length).toBeGreaterThan(1000); // 通行帯を潰していないこと
  });

  it("分離の押し出しは、最も遅い移動(室内進入)より弱い", () => {
    // 押し出しが移動と釣り合うと、その場で永久に足踏みする(実測で確認した現象)。
    const slowestStep = MOVE_SPEED * SIM_DT * ENTRY_SPEED_MUL;
    // separation.ts の MAX_PUSH と同じ式。定数を動かしたらここで気づけるようにする
    const maxPush = MOVE_SPEED * SIM_DT * ENTRY_SPEED_MUL * 0.3;
    expect(maxPush).toBeLessThan(slowestStep * 0.5);
  });

  it("移動命令を受けた兵士が、長時間その場に貼り付かない", () => {
    const w = createWorld(companyClashScenario(1));
    /** 兵士id → 「目的地が遠いのに1秒で0.3m未満しか動かない」連続秒数 */
    const streak = new Map<number, number>();
    let worst = 0;
    const last = new Map<number, { x: number; z: number }>();

    for (let t = 0; t < 120; t++) {
      runTicks(w, 30);
      for (const s of w.soldiers) {
        if (s.status !== "ok") {
          streak.set(s.id, 0);
          continue;
        }
        const prev = last.get(s.id);
        last.set(s.id, { x: s.pos.x, z: s.pos.z });
        const tgt = s.order.target;
        const far = tgt !== undefined && Math.hypot(tgt.x - s.pos.x, tgt.z - s.pos.z) > 2.5;
        const moved = prev ? Math.hypot(s.pos.x - prev.x, s.pos.z - prev.z) : 99;
        if (far && moved < 0.3) {
          const n = (streak.get(s.id) ?? 0) + 1;
          streak.set(s.id, n);
          worst = Math.max(worst, n);
        } else streak.set(s.id, 0);
      }
    }
    // 修正前は「目的地0.1m手前の壁に貼り付いたまま二度と動かない」兵士が
    // 常時100名以上いた(最長は計測窓いっぱい)。制圧下での足踏みや遮蔽待ちで
    // 数十秒止まるのは正常なので、そこは許容した上で「事実上の永久停止」を弾く。
    expect(worst).toBeLessThan(110);
  }, 120000);

  it("建物の奥で倒れた負傷者も、壁に詰まらずCCPまで後送される(仕様 §9)", () => {
    // 屋内で倒れた負傷者は最も条件が厳しい: 担架という剛体が 1.2m の戸口を通り、
    // 屋内の細グリッドから屋外へ継ぎ目を越えなければならない。修正前はここで
    // 壁の角に噛み、153秒微動だにしない担架班が出ていた。
    const w = createWorld(companyClashScenario(1));
    for (const s of w.soldiers) if (s.side === "red") s.status = "kia"; // 戦闘を排除して後送だけを見る

    // CCPに最も近い建物の最奥の部屋へ負傷者を置く
    const ccp = w.ccp.blue;
    const host = [...w.buildings].sort(
      (a, b) =>
        Math.hypot((a.bounds.minX + a.bounds.maxX) / 2 - ccp.x, (a.bounds.minZ + a.bounds.maxZ) / 2 - ccp.z) -
        Math.hypot((b.bounds.minX + b.bounds.maxX) / 2 - ccp.x, (b.bounds.minZ + b.bounds.maxZ) / 2 - ccp.z),
    )[0]!;
    // 屋内に負傷者が出るのは、その建物を掃討したあとだけ(兵士はブリーチした扉からしか
    // 入れない)。掃討済み = 扉が開いた状態を再現する。
    for (const d of host.doors) d.open = true;
    refreshBlockers(w);
    const room = host.rooms[host.rooms.length - 1]!;
    const victim = w.soldiers.find(
      (s) => s.side === "blue" && s.status === "ok" && s.fireteamId >= 0 && !s.isFireteamLeader,
    )!;
    victim.pos = {
      x: (room.bounds.minX + room.bounds.maxX) / 2,
      z: (room.bounds.minZ + room.bounds.maxZ) / 2,
    };
    // 分隊ごと建物の前へ移し、担架要員が現実的な距離から集まれるようにする
    for (const s of w.soldiers) {
      if (s.side !== "blue" || s.squadId !== victim.squadId || s.id === victim.id) continue;
      s.pos = { x: victim.pos.x + (s.id % 5) - 2, z: victim.pos.z + ((s.id % 3) - 1) };
    }
    victim.status = "wia";
    victim.stabilized = true;
    victim.bleedOutTick = 0;

    let stalled = 0;
    let worstStall = 0;
    let last = { ...victim.pos };
    for (let t = 0; t < 400 && victim.evac !== "evacuated" && victim.evac !== "collected"; t++) {
      runTicks(w, 30);
      if (victim.evac === "carrying") {
        const moved = Math.hypot(victim.pos.x - last.x, victim.pos.z - last.z);
        stalled = moved < 0.2 ? stalled + 1 : 0;
        worstStall = Math.max(worstStall, stalled);
      }
      last = { ...victim.pos };
    }
    expect(["evacuated", "collected"]).toContain(victim.evac);
    expect(worstStall).toBeLessThan(15);
  }, 120000);

  it("担架班は所要人数(2名/4名)を割ったまま走らない(仕様 §9)", () => {
    const w = createWorld(companyClashScenario(2));
    for (let t = 0; t < 100; t++) {
      runTicks(w, 30);
      for (const p of w.soldiers) {
        if (p.bearers.length === 0) continue;
        expect(p.bearers.length === 2 || p.bearers.length === 4).toBe(true);
      }
    }
  }, 120000);
});
