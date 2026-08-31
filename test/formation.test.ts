import { describe, it, expect } from "vitest";
import { buildCoverIndex } from "../src/sim/cover.ts";
import {
  TIER_OFFSETS,
  TIER_SPEED_MUL,
  TIER_THRESHOLDS,
  clampToWalkable,
  corridorWidth,
  decideTier,
  exposureAt,
  formationSlots,
  preferCover,
  EXPOSURE_THRESHOLD,
} from "../src/sim/formation.ts";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { platoonClashScenario } from "../src/sim/scenario.ts";
import { collidesWall } from "../src/sim/geometry.ts";
import { WALL_SAFETY_CLAMP } from "../src/sim/constants.ts";
import type { AABB, Contact } from "../src/sim/types.ts";

/** 半幅 `hw` の東西方向の通路を作る(南北に壁)。 */
function corridor(halfWidth: number): AABB[] {
  return [
    { cx: 0, cz: halfWidth + 0.2, hw: 40, hd: 0.2 },
    { cx: 0, cz: -(halfWidth + 0.2), hw: 40, hd: 0.2 },
  ];
}

const EAST = { x: 1, z: 0 };

describe("隊形の自動選択(仕様 §6)", () => {
  it("通路幅を進行方向に直交する向きで測る", () => {
    // 半幅2.0m の通路 → 幅4.0m(壁の内側どうしの距離)
    const w = corridor(2.0);
    expect(corridorWidth(w, { x: 0, z: 0 }, EAST)).toBeCloseTo(4.0, 1);
    // 開豁地では上限に張り付く
    expect(corridorWidth([], { x: 0, z: 0 }, EAST)).toBeGreaterThan(TIER_THRESHOLDS[2]);
  });

  it("幅のしきい値どおりに4段階を選ぶ(仕様 §6 の表)", () => {
    expect(decideTier(2.0)).toBe(1); // <2.2 密集縦隊
    expect(decideTier(3.2)).toBe(2); // 2.2〜4.0 縦隊
    expect(decideTier(5.2)).toBe(3); // 4.0〜6.5 分散隊形
    expect(decideTier(8.4)).toBe(4); // 6.5以上 横隊
  });

  it("通路が狭まると縦隊へ、開ければ横隊へ切り替わる", () => {
    expect(decideTier(corridorWidth(corridor(1.0), { x: 0, z: 0 }, EAST))).toBe(1);
    expect(decideTier(corridorWidth(corridor(1.6), { x: 0, z: 0 }, EAST))).toBe(2);
    expect(decideTier(corridorWidth(corridor(2.6), { x: 0, z: 0 }, EAST))).toBe(3);
    expect(decideTier(corridorWidth(corridor(4.2), { x: 0, z: 0 }, EAST))).toBe(4);
  });

  it("全オフセットが前後方向または左右方向の片軸のみ(梯形は廃止、仕様 §6 [v5])", () => {
    for (const tier of [1, 2, 3, 4] as const) {
      for (const off of TIER_OFFSETS[tier]) {
        const diagonal = off.along !== 0 && off.lateral !== 0;
        expect(diagonal, `tier${tier} に斜め配置がある`).toBe(false);
      }
    }
  });

  it("移動速度は 縦隊 > 分散 > 横隊 の序列になる(仕様 §6)", () => {
    expect(TIER_SPEED_MUL[1]).toBe(TIER_SPEED_MUL[2]);
    expect(TIER_SPEED_MUL[2]).toBeGreaterThan(TIER_SPEED_MUL[3]);
    expect(TIER_SPEED_MUL[3]).toBeGreaterThan(TIER_SPEED_MUL[4]);
  });

  it("壁面安全クランプ: 隊形位置が壁に食い込むならリーダー側へ引き戻す(仕様 §6 [v5])", () => {
    const walls = corridor(1.2);
    const leader = { x: 0, z: 0 };
    // 壁の中を指す隊形位置
    const bad = { x: 0, z: 1.35 };
    expect(collidesWall(walls, bad.x, bad.z, WALL_SAFETY_CLAMP)).toBe(true);
    const fixed = clampToWalkable(walls, bad, leader);
    expect(collidesWall(walls, fixed.x, fixed.z, 0.35)).toBe(false);
  });

  it("狭い通路では、隊形位置が誰も壁にめり込まない", () => {
    const walls = corridor(1.0);
    // リーダーが通路の端寄りを歩いていても、反対側の隊員が壁を突き抜けない
    for (const lz of [-0.5, 0, 0.5]) {
      const slots = formationSlots(walls, { x: -10, z: lz }, EAST, 4);
      for (const s of slots) {
        expect(collidesWall(walls, s.pos.x, s.pos.z, 0.35)).toBe(false);
      }
    }
  });

  it("追従位置はリーダーの向きを基準に回る(固定座標ではない、仕様 §6.5)", () => {
    const east = formationSlots([], { x: 0, z: 0 }, { x: 1, z: 0 }, 4);
    const north = formationSlots([], { x: 0, z: 0 }, { x: 0, z: 1 }, 4);
    // 同じスロットでも、リーダーの向きが変われば世界座標は変わる
    expect(east[1]!.pos).not.toEqual(north[1]!.pos);
    // リーダー自身は常に基準点
    expect(east[0]!.pos).toEqual({ x: 0, z: 0 });
  });
});

describe("遮蔽物優先ロジック(仕様 §6.5)", () => {
  const mkContact = (x: number, z: number, confidence = 1): Contact => ({
    key: `c${x}_${z}`,
    side: "red",
    pos: { x, z },
    posError: 0,
    hopError: 0,
    lastSeenTick: 0,
    confidence,
  });

  it("既知の接触から見通せる地点ほど露出が高い", () => {
    const walls: AABB[] = [{ cx: 0, cz: 0, hw: 3, hd: 0.4 }];
    const enemy = [mkContact(0, -10)];
    // 壁の向こう側 = 遮蔽されている
    expect(exposureAt(walls, enemy, { x: 0, z: 5 })).toBe(0);
    // 同じ側 = 丸見え
    expect(exposureAt(walls, enemy, { x: 0, z: -5 })).toBe(1);
  });

  it("接触情報がなければ露出は0(未知の敵を恐れて隠れたりしない)", () => {
    expect(exposureAt([], [], { x: 0, z: 0 })).toBe(0);
  });

  it("露出がしきい値を超えたときだけ遮蔽へ寄せる", () => {
    const walls: AABB[] = [{ cx: 0, cz: 0, hw: 3, hd: 0.4 }];
    const enemy = [mkContact(0, -10)];
    // `[v6.3]` 遮蔽候補点は空間索引経由で渡す(全点走査をやめたため)
    const coverPoints = buildCoverIndex(
      [
        { x: 0, z: 1.2, cover: 2.0 }, // 壁の陰
        { x: 0, z: -2.0, cover: 0 }, // 露出したまま
      ],
      { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
    );

    // 露出した地点 → 近くの遮蔽へ移る
    const exposed = { x: 0, z: -1.0 };
    expect(exposureAt(walls, enemy, exposed)).toBeGreaterThan(EXPOSURE_THRESHOLD);
    expect(preferCover(walls, coverPoints, enemy, exposed)).toMatchObject({ x: 0, z: 1.2 });

    // すでに安全な地点 → 動かさない(振動防止)
    const safe = { x: 0, z: 2.0 };
    expect(preferCover(walls, coverPoints, enemy, safe)).toMatchObject(safe);
  });
});

describe("実戦での隊形(仕様 §6/§6.5)", () => {
  it("前進中の隊員は集合・追従で動き、経路探索を持たない", () => {
    const w = createWorld(platoonClashScenario(1));
    let sawFollow = false;
    for (let i = 0; i < 300; i++) {
      runTicks(w, 1);
      for (const s of w.soldiers) {
        if (s.order.kind !== "follow") continue;
        sawFollow = true;
        // 追従は経路探索を通さない(仕様 §6.5: 継続的な相対追従)
        expect(s.path.length).toBe(0);
      }
      if (sawFollow) break;
    }
    expect(sawFollow).toBe(true);
  });

  it("追従中の隊員がリーダーから離れすぎない", () => {
    const w = createWorld(platoonClashScenario(1));
    runTicks(w, 600);
    for (const ft of w.fireteams) {
      const members = w.soldiers.filter(
        (s) =>
          s.side === ft.side &&
          s.squadId === ft.squadId &&
          s.fireteamId === ft.ftIndex &&
          s.status === "ok" &&
          s.order.kind === "follow",
      );
      for (const m of members) {
        const t = m.order.target!;
        // 追従目標は隊形位置なので、隊の直近にあるはず
        expect(Math.hypot(m.pos.x - t.x, m.pos.z - t.z)).toBeLessThan(15);
      }
    }
  });
});
