import { describe, it, expect } from "vitest";
import { createWorld, refreshBlockers, setBlockers } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { urbanCqbFixture } from "../src/sim/scenario.ts";
import {
  cornerAssignments,
  insideBounds,
  makeCorridorBuilding,
  makeSimpleBuilding,
  selectAssaultDoor,
  stackPositions,
} from "../src/sim/cqb.ts";
import { findPathSet } from "../src/sim/navgrid.ts";
import { hasLineOfSight } from "../src/sim/geometry.ts";
import { perceptionSystem } from "../src/sim/systems/perception.ts";
import { CQB, PEEK, SIM_HZ } from "../src/sim/constants.ts";
import type { AABB, CqbStage } from "../src/sim/types.ts";

describe("CQBの幾何(仕様 §7.3)", () => {
  const { building, walls } = makeSimpleBuilding(
    1,
    { minX: -5, maxX: 5, minZ: -4, maxZ: 4 },
    "south",
  );
  const door = building.doors[0]!;
  const room = building.rooms[0]!;

  it("扉は指定した面に開き、法線は室内を向く", () => {
    expect(door.pos.z).toBeCloseTo(-4, 3);
    expect(door.normal).toEqual({ x: 0, z: 1 }); // 室内(+z)方向
    expect(door.open).toBe(false);
  });

  it("スタック位置は扉の外側1.5m以内、壁沿いの縦列(仕様 §7.3 ①)", () => {
    const slots = stackPositions(door, 4);
    expect(slots.length).toBe(4);
    for (const s of slots) {
      // 扉の外側(法線の逆方向)にある
      const depth = (s.x - door.pos.x) * door.normal.x + (s.z - door.pos.z) * door.normal.z;
      expect(depth).toBeCloseTo(-CQB.STACK_DIST, 3);
      // 室内ではない
      expect(insideBounds(room.bounds, s)).toBe(false);
    }
    // 縦列であり、隊員が押し合わない間隔を持つ
    for (let i = 1; i < slots.length; i++) {
      const d = Math.hypot(slots[i]!.x - slots[i - 1]!.x, slots[i]!.z - slots[i - 1]!.z);
      expect(d).toBeGreaterThan(0.7);
    }
  });

  it("コーナー担当は室内の4隅で、近方から遠方の順に割り当てる(仕様 §7.3 ③)", () => {
    const corners = cornerAssignments(room, door);
    expect(corners.length).toBe(4);
    for (const c of corners) expect(insideBounds(room.bounds, c.pos)).toBe(true);

    const depth = (p: { x: number; z: number }) =>
      (p.x - door.pos.x) * door.normal.x + (p.z - door.pos.z) * door.normal.z;
    // 1番目は近方、2番目は遠方(ボタンフック/クリスクロス)
    expect(depth(corners[0]!.pos)).toBeLessThan(depth(corners[1]!.pos));
    expect(depth(corners[2]!.pos)).toBeLessThan(depth(corners[3]!.pos));
    // 4隅すべてが異なる
    const keys = new Set(corners.map((c) => `${c.pos.x.toFixed(2)},${c.pos.z.toFixed(2)}`));
    expect(keys.size).toBe(4);
  });

  it("壁は扉の開口部を空けて生成される", () => {
    // 扉の中心を通る線は壁で塞がれていない(開口部がある)
    expect(hasLineOfSight(walls, door.pos.x, door.pos.z - 1, door.pos.x, door.pos.z + 1)).toBe(
      true,
    );
    // 開口部から外れた位置は塞がれている
    expect(hasLineOfSight(walls, 3.5, door.pos.z - 1, 3.5, door.pos.z + 1)).toBe(false);
  });
});

describe("屋内視界ルール(仕様 §7.6)", () => {
  it("閉じた扉は視線を遮り、開くと室内が見える", () => {
    const w = createWorld(urbanCqbFixture(1));
    const door = w.doors[0]!;
    const outside = {
      x: door.pos.x - door.normal.x * 2,
      z: door.pos.z - door.normal.z * 2,
    };
    const inside = {
      x: door.pos.x + door.normal.x * 2,
      z: door.pos.z + door.normal.z * 2,
    };

    // 閉じている間は透視できない(Door Kicker式)
    expect(door.open).toBe(false);
    expect(hasLineOfSight(w.walls, outside.x, outside.z, inside.x, inside.z)).toBe(false);

    // 開いた瞬間から見える
    door.open = true;
    refreshBlockers(w);
    expect(hasLineOfSight(w.walls, outside.x, outside.z, inside.x, inside.z)).toBe(true);
  });
});

describe("経路探索(仕様 §7 `[v6.1]`: 屋外1.0m + 屋内0.3m)", () => {
  it("街路から室内まで1回の探索で経路が出る(仕様 §7.1 シームレス)", () => {
    const w = createWorld(urbanCqbFixture(1));
    const room = w.buildings[0]!.rooms[0]!;
    const center = {
      x: (room.bounds.minX + room.bounds.maxX) / 2,
      z: (room.bounds.minZ + room.bounds.maxZ) / 2,
    };
    const start = w.soldiers.find((s) => s.side === "blue")!;
    const path = findPathSet(w.nav, start.pos.x, start.pos.z, center.x, center.z);
    expect(path).not.toBeNull();
    // 経路の終端は室内
    const last = path![path!.length - 1]!;
    expect(insideBounds(room.bounds, last)).toBe(true);
  });

  it("建物のまわりだけ細かいグリッドになっている", () => {
    const w = createWorld(urbanCqbFixture(1));
    expect(w.nav.grids.length).toBe(1 + w.buildings.length);
    expect(w.nav.grids[0]!.step).toBe(1.0);
    for (let i = 1; i < w.nav.grids.length; i++) {
      expect(w.nav.grids[i]!.step).toBe(CQB.NAV_STEP);
    }
  });
});

describe("突入待機命令の3段階(仕様 §7.2/§7.3)", () => {
  it("スタック → (フラッシュバン)→ ブリーチ → 室内掃討 → 再編成 を順に通る", () => {
    const w = createWorld(urbanCqbFixture(1));
    const seen = new Map<string, CqbStage[]>();
    let doorOpenedTick = -1;
    let anyoneInsideTick = -1;

    for (let t = 0; t < 90 * SIM_HZ; t++) {
      runTicks(w, 1);
      for (const ft of w.fireteams) {
        if (ft.mode !== "CQB") continue;
        const key = `${ft.side}:${ft.squadId}:${ft.ftIndex}`;
        const list = seen.get(key) ?? [];
        if (list[list.length - 1] !== ft.cqbStage) list.push(ft.cqbStage);
        seen.set(key, list);
      }
      if (doorOpenedTick < 0 && w.doors.some((d) => d.open)) doorOpenedTick = w.tick;
      if (anyoneInsideTick < 0) {
        for (const b of w.buildings) {
          for (const r of b.rooms) {
            if (w.soldiers.some((s) => s.status === "ok" && insideBounds(r.bounds, s.pos))) {
              anyoneInsideTick = w.tick;
            }
          }
        }
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    // 少なくとも1個FTが全段階を順に通っている。
    // 掃討後に別の扉へ回ることがあるので、先頭一致で見る(再編成後の次の建物)。
    // `[v7.2]` フラッシュバンを持っていればブリーチの前に bang が入る(仕様 §8.4)
    const complete = [...seen.values()].find((stages) =>
      /^stack>(bang>)?breach>clear>reorg/.test(stages.join(">")),
    );
    expect(complete, `観測した段階遷移: ${JSON.stringify([...seen])}`).toBeDefined();

    // 扉は突入前に開き、隊員はそのあとで室内に入る
    expect(doorOpenedTick).toBeGreaterThan(0);
    expect(anyoneInsideTick).toBeGreaterThan(doorOpenedTick);
  });

  it("突入は単一ファイル — 全員が同時に扉へ殺到しない(仕様 §7.3)", () => {
    const w = createWorld(urbanCqbFixture(1));
    // ブリーチ中、「まだ順番待ちの隊員」と「もう動き出した隊員」が同時に存在する
    // 瞬間があること。4名が一斉に扉へ殺到する挙動はプロトタイプで確認済みの失敗。
    let sawStagger = false;
    for (let t = 0; t < 90 * SIM_HZ && !sawStagger; t++) {
      runTicks(w, 1);
      for (const ft of w.fireteams) {
        if (ft.mode !== "CQB" || ft.cqbStage !== "breach") continue;
        const men = w.soldiers.filter(
          (s) =>
            s.side === ft.side &&
            s.squadId === ft.squadId &&
            s.fireteamId === ft.ftIndex &&
            s.status === "ok",
        );
        if (men.length < 2) continue;
        const waiting = men.filter((s) => s.order.kind === "hold").length;
        const moving = men.length - waiting;
        if (waiting > 0 && moving > 0) sawStagger = true;
      }
    }
    expect(sawStagger).toBe(true);
  });

  it("室内進入時は速度が落ちる(仕様 §7 — 0.7倍)", () => {
    const w = createWorld(urbanCqbFixture(1));
    let sawSlowed = false;
    for (let t = 0; t < 90 * SIM_HZ && !sawSlowed; t++) {
      runTicks(w, 1);
      for (const ft of w.fireteams) {
        if (ft.mode !== "CQB") continue;
        if (ft.cqbStage !== "breach" && ft.cqbStage !== "clear") continue;
        const men = w.soldiers.filter(
          (s) =>
            s.side === ft.side &&
            s.squadId === ft.squadId &&
            s.fireteamId === ft.ftIndex &&
            s.status === "ok",
        );
        if (men.some((s) => s.speedMul < 1)) sawSlowed = true;
      }
    }
    expect(sawSlowed).toBe(true);
  });

  it("分隊長は突入FTと支援FTに分ける(仕様 §7.2 の支援射撃)", () => {
    const w = createWorld(urbanCqbFixture(1));
    let sawSplit = false;
    for (let t = 0; t < 90 * SIM_HZ && !sawSplit; t++) {
      runTicks(w, 1);
      for (const sq of w.squads) {
        if (sq.assaultDoorId === null) continue;
        const fts = w.fireteams.filter((f) => f.side === sq.side && f.squadId === sq.squadId);
        const assault = fts.filter((f) => f.cqbDoorId !== null).length;
        const support = fts.filter((f) => f.cqbDoorId === null && f.assignedRole === "base").length;
        if (assault === 1 && support >= 1) sawSplit = true;
      }
    }
    expect(sawSplit).toBe(true);
  });
});

/**
 * ビハインドカメラ(コーナー視認、仕様 §7.5)。
 *
 * 実戦の中で覗きが起きる瞬間を捕まえるのは不安定なので、索敵システムだけを
 * 直接動かして確かめる。仕様が要求しているのは3点:
 *   - プレイヤー/AI平等(同一ロジック)
 *   - 覗いている間は相互に発見リスクが発生する(一方的な有利を与えない)
 *   - 「覗く(索敵)」と「出て撃つ(交戦)」の分離
 */
describe("ビハインドカメラ(仕様 §7.5)", () => {
  /** 兵士2名だけの最小世界を作る。壁は差し替える。 */
  function twoManWorld(walls: AABB[]) {
    const w = createWorld(urbanCqbFixture(1));
    // `[v6.2]` 壁の差し替えは setBlockers 経由で。空間索引も一緒に張り直す必要がある
    setBlockers(w, walls);
    const blue = w.soldiers.find((s) => s.side === "blue")!;
    const red = w.soldiers.find((s) => s.side === "red")!;
    for (const s of w.soldiers) {
      if (s.id !== blue.id && s.id !== red.id) s.status = "kia";
      s.path = [];
      s.pathIdx = 0;
    }
    return { w, blue, red };
  }

  it("開豁地では覗かない — 視線原点は体の位置のまま", () => {
    const { w, blue } = twoManWorld([]);
    blue.pos = { x: 0, z: 0 };
    blue.facing = { x: 0, z: 1 };
    perceptionSystem(w);
    expect(blue.peeking).toBe(false);
    expect(blue.eye).toEqual({ x: 0, z: 0 });
  });

  it("正面が壁で塞がれていると横へ視線を出す(スライス・ザ・パイ)", () => {
    // 兵士の正面(+z)を塞ぐ壁。右側(-x側)は開いている
    const walls: AABB[] = [{ cx: 3, cz: 1, hw: 3, hd: 0.3 }];
    const { w, blue } = twoManWorld(walls);
    blue.pos = { x: 0.2, z: 0 };
    blue.facing = { x: 0, z: 1 };
    perceptionSystem(w);
    expect(blue.peeking).toBe(true);
    const off = Math.hypot(blue.eye.x - blue.pos.x, blue.eye.z - blue.pos.z);
    expect(off).toBeCloseTo(PEEK.OFFSET, 5);
  });

  it("移動中は覗かない(索敵と交戦の分離)", () => {
    const walls: AABB[] = [{ cx: 3, cz: 1, hw: 3, hd: 0.3 }];
    const { w, blue } = twoManWorld(walls);
    blue.pos = { x: 0.2, z: 0 };
    blue.facing = { x: 0, z: 1 };
    // 経路追従中にする
    blue.path = [
      { x: 0.2, z: -1 },
      { x: 0.2, z: -2 },
    ];
    blue.pathIdx = 0;
    perceptionSystem(w);
    expect(blue.peeking).toBe(false);
  });

  it("覗けば見えるが、同時に覗かれる — 相互リスク(一方的な有利を与えない)", () => {
    // 壁の陰から覗く配置。体どうしの射線は壁で切れているが、
    // 壁の端から視線をずらせば互いに通る
    const walls: AABB[] = [{ cx: 0, cz: 2, hw: 1.2, hd: 0.3 }];
    const { w, blue, red } = twoManWorld(walls);
    blue.pos = { x: 0.9, z: 1.0 }; // 壁の端のすぐ手前
    blue.facing = { x: 0, z: 1 };
    red.pos = { x: 1.45, z: 5 }; // 壁の端の延長線上
    red.facing = { x: 0, z: -1 };

    // 体どうしは壁で遮られている
    expect(hasLineOfSight(walls, blue.pos.x, blue.pos.z, red.pos.x, red.pos.z)).toBe(false);

    perceptionSystem(w);
    expect(blue.peeking).toBe(true);
    // 覗いた結果として見えるなら、**必ず相手からも見えている**。
    // canSee が両端に eye を使っているので、片側だけ見える状態は原理的に作れない
    const blueSeesRed = blue.sees.includes(red.id);
    const redSeesBlue = red.sees.includes(blue.id);
    expect(blueSeesRed).toBe(redSeesBlue);
  });

  it("覗きの判定に操作の有無は一切影響しない(プレイヤー/AI平等)", () => {
    const walls: AABB[] = [{ cx: 3, cz: 1, hw: 3, hd: 0.3 }];
    const a = twoManWorld(walls);
    a.blue.pos = { x: 0.2, z: 0 };
    a.blue.facing = { x: 0, z: 1 };
    perceptionSystem(a.w);
    const aiEye = { ...a.blue.eye };

    const b = twoManWorld(walls);
    b.blue.pos = { x: 0.2, z: 0 };
    b.blue.facing = { x: 0, z: 1 };
    // 人間が操作しているノードにする(仕様 §4)
    b.w.control = { echelon: "soldier", side: "blue", unitId: b.blue.id };
    perceptionSystem(b.w);

    expect(b.blue.eye).toEqual(aiEye);
    expect(b.blue.peeking).toBe(a.blue.peeking);
  });
});

/**
 * 突入する扉の選定(`[v6.4]` 4回目のテストプレイ指摘③「全部屋探索せず終わっています」)。
 *
 * 「屋内にいるか」を分隊の重心ひとつで判定していたため、突入FTが室内にいても
 * 支援FTが扉の外にいれば重心は建物の外に落ち、内扉が候補から消えていた。
 * 外扉は掃討済みなので候補ゼロ = 廊下だけ取って立ち去る、という挙動になる。
 */
describe("突入する扉の選定(仕様 §7.2)", () => {
  const { building } = makeCorridorBuilding(1, { minX: -12, maxX: 12, minZ: -8, maxZ: 8 }, "south");
  const inner = building.doors.filter((d) => !d.exterior);
  const outer = building.doors.find((d) => d.exterior)!;
  const aim = { x: 0, z: 4 }; // 建物の奥(部屋の中)
  const outsideFrom = { x: 0, z: -12 };

  it("外から見えるのは外扉だけ", () => {
    expect(inner.length).toBeGreaterThan(0);
    const d = selectAssaultDoor([building], outsideFrom, aim, []);
    expect(d!.exterior).toBe(true);
  });

  it("重心が建物の外でも、隊員が1名でも中にいれば内扉を選べる", () => {
    // 外扉は掃討済み。重心は外(支援FTが扉の外で射撃位置についている状態)
    const excl = [outer.id];
    expect(selectAssaultDoor([building], outsideFrom, aim, excl)).toBeNull();

    // 突入FTが廊下にいる = 建物内に隊員がいる
    const occupants = [{ x: 0, z: -6 }];
    const d = selectAssaultDoor([building], outsideFrom, aim, excl, occupants);
    expect(d).not.toBeNull();
    expect(d!.exterior).toBe(false);
  });
});
