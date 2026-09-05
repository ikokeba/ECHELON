/**
 * 盤面(地形のみ)。`[v6.11]` 仕様 §7/§10。
 *
 * 部隊の配置は含めない — 盤面と編成は別物、という `[v6.9]` の切り分けをそのまま守る。
 * どの盤面も **440×340m・原点まわりの点対称**で、仕様 §2/§13 の
 * 「地形由来ではない有利不利が無い」を満たす。展開線(z=±140)は共通なので、
 * `scenario.ts` の部隊配置はどの盤面でもそのまま使える。
 *
 * 盤面を足すときの決まりごと(どちらも過去に踏んだ):
 *
 *   1. **展開地から敵展開地まで一直線に抜ける街路を残さない**(`[v6.2]`)。
 *      残すと選抜射手(索敵300m)が誰も動かないうちから撃ち始め、仕様 §10 が前提に
 *      している「市街地の見通し距離が交戦距離を自然に制限する」が成り立たない。
 *      `test/fields.test.ts` が開幕の通し射線を数えている。
 *   2. **拠点は屋外に置く**。室内の一室を拠点にすると、掃討を終えた分隊がその部屋に
 *      留まる仕組みがまだ無く、確保が最良22%で止まる(`[v6.10]` F-9 の残件)。
 *      塀で囲われた敷地なら、屋外でありながら射線が切れる戦いになる。
 */

import { OBJECTIVE } from "./constants.ts";
import {
  addBuilding,
  centreOf,
  culDeSac,
  emptyStructures,
  hashRange,
  mirrorAll,
  mirrorRect,
  subdivideBlock,
  trenchBays,
  walledCompound,
  wireBelt,
} from "./mapgen.ts";
import type { AABB, Bounds, Building, Vec2 } from "./types.ts";

/** 盤面1枚。`scenario.ts` がこれに部隊を載せる。 */
export interface Field {
  bounds: Bounds;
  walls: AABB[];
  windowPlugs: AABB[];
  buildings: Building[];
  /** 拠点。中央 → 側面の順に並べる(呼称は `scenario.ts` が付ける) */
  objectives: Array<{ pos: Vec2; radius: number }>;
  /**
   * 最初から屋内ナビを張っておく建物のID(`[v6.12]`)。
   *
   * 通常の建物は突入が決まった時点で細グリッドを張れば足りる(仕様 §7.2)。
   * **塹壕だけは違う** — 誰も「突入」しないまま、守る側が最初から入って戦う場所
   * なので、張られていないと塹壕がただの障害物になり、部隊は迂回してしまう。
   */
  navFromStart?: number[];
}

const BOUNDS: Bounds = { minX: -220, maxX: 220, minZ: -170, maxZ: 170 };

/** 2つの矩形が重なるか(接触は重なりとみなさない)。 */
function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    a.minX < b.maxX - 0.01 &&
    b.minX < a.maxX - 0.01 &&
    a.minZ < b.maxZ - 0.01 &&
    b.minZ < a.maxZ - 0.01
  );
}

/**
 * 街区の行1つを、幅のばらついた街区へ割る。`jog` で行ごとに始点をずらす。
 *
 * `jog` は**盤内に収まる範囲へ畳む**。畳まずに負の値を渡すと街区が盤外へはみ出し、
 * ナビグリッドの外に壁ができて経路探索が壊れる(実測で 491→5 t/s まで落ちた)。
 *
 * 奥行きも街区ごとに揺らす(`setback`)。幅だけを揺らすと、真上から見たとき
 * **行が横縞として残る** — 参照した衛星写真にそんな帯は無い。揺らしは常に
 * **内側へ縮める向き**にしてある。外へ広げると隣の行との街路が潰れて通れなくなる。
 */
function blockRow(
  z0: number,
  z1: number,
  salt: number,
  opts: {
    jog: number;
    minW: number;
    maxW: number;
    minGap: number;
    maxGap: number;
    /** 奥行きを内側へ縮める最大量 m。0 で行が揃う */
    setback?: number;
  },
): Bounds[] {
  const out: Bounds[] = [];
  const jog = ((opts.jog % 34) + 34) % 34;
  const setback = opts.setback ?? 0;
  let x = BOUNDS.minX + 6 + jog;
  let k = 0;
  while (x < BOUNDS.maxX - 6) {
    const w = hashRange(x, z0, salt + k, opts.minW, opts.maxW);
    const to = Math.min(BOUNDS.maxX - 6, x + w);
    if (to - x >= opts.minW * 0.6) {
      // 手前・奥それぞれ独立に下げる。両方下がった街区は小さな平屋に見える
      const front = setback > 0 ? hashRange(x, z0, salt + 300 + k, 0, setback) : 0;
      const back = setback > 0 ? hashRange(to, z1, salt + 400 + k, 0, setback) : 0;
      const zz0 = z0 + front;
      const zz1 = z1 - back;
      if (zz1 - zz0 >= 8) out.push({ minX: x, maxX: to, minZ: zz0, maxZ: zz1 });
    }
    x = to + hashRange(x, z1, salt + 100 + k, opts.minGap, opts.maxGap);
    k++;
  }
  return out;
}

/**
 * 自動生成した街区に、手で置く建物・広場・敷地のための**空地を掘る**。
 *
 * 手置きの建物を後から足すと必ず街区とぶつかる(実際にぶつけた)。重なった建物は
 * 互いの部屋の中に壁を作るので、経路探索が目的地へ到達できず、そのたびにグリッド
 * 全体を探索し直す — 中隊マップで **491 → 5 t/s**。先に穴を空けてから置くこと。
 *
 * 予約領域は点対称の双子も自動で掘る(盤面が点対称であるため)。
 */
function carve(blocks: readonly Bounds[], reserved: readonly Bounds[]): Bounds[] {
  const all = reserved.flatMap((r) => [r, mirrorRect(r)]);
  return blocks.filter((b) => !all.some((r) => overlaps(b, r)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧市街 — 不定形の街区が詰まった密集地。路地と袋小路が多く、見通しが極端に短い
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旧市街。参照した衛星写真(バグダード旧市街)の特徴をそのまま狙う:
 * 街区の大きさが不揃い、十字路がほとんど無く食い違いのT字路ばかり、
 * 街区の内側へ袋小路が刺さっている、廟が塀で囲われた敷地を持つ。
 *
 * 戦い方としては**最も近距離**の盤面。長い射線がほぼ無く、選抜射手の出番が減り、
 * 擲弾と室内戦の比重が上がる。
 */
export function oldQuarterField(): Field {
  const out = emptyStructures();
  const id = { v: 1 };
  const walls: AABB[] = [];

  // 行ごとに深さも始点もずらす。**同じ深さの行を隣り合わせない**のが要点で、
  // これだけで通りが一直線に抜けなくなる(十字路が食い違いのT字路になる)
  const rows: Array<{ z0: number; z1: number; jog: number; salt: number }> = [
    { z0: -34, z1: -18, jog: 0, salt: 11 },
    { z0: -58, z1: -40, jog: 17, salt: 23 },
    { z0: -78, z1: -64, jog: -9, salt: 37 },
    { z0: -104, z1: -84, jog: 21, salt: 51 },
    { z0: -126, z1: -110, jog: 5, salt: 67 },
  ];
  // 先に空地を予約してから街区を敷く。順序が逆だと手置きの建物と必ずぶつかる
  const shrine: Bounds = { minX: -84, maxX: -52, minZ: -46, maxZ: -22 };
  const plaza: Bounds = { minX: -22, maxX: 22, minZ: -18, maxZ: 18 };
  // 廟そのものは中庭の**外**へ置く。中庭に建てると拠点の判定円と重なり、
  // 「屋外の拠点」でなくなってしまう(それが確保の成立する理由なので)
  const tomb: Bounds = { minX: -94, maxX: -86, minZ: -42, maxZ: -26 };
  const reserved = [shrine, plaza, tomb];

  for (const r of rows) {
    const blocks = carve(
      blockRow(r.z0, r.z1, r.salt, {
        jog: r.jog,
        minW: 22,
        maxW: 42,
        minGap: 7,
        maxGap: 12,
        // 旧市街は最も不揃い。行の帯を完全に崩す
        setback: 4,
      }),
      reserved,
    );
    for (const b of blocks) {
      // 大きい街区は不揃いな棟へ割り、あいだに路地を残す
      for (const piece of subdivideBlock(b, r.salt, { alley: 3.5, maxRun: 28, minRun: 14 })) {
        addBuilding(out, id.v++, piece);
        addBuilding(out, id.v++, mirrorRect(piece));
      }
    }
  }

  // 廟の敷地(塀で囲った空地)。ここが側面の拠点になる
  walls.push(...walledCompound(shrine, "north"));
  // 廟の建物。中庭の西隣に立ち、敷地の門とは反対側から見下ろす
  addBuilding(out, id.v++, tomb, "east");
  addBuilding(out, id.v++, mirrorRect(tomb), "west");

  // 中央の広場を囲う塀。原点の拠点が完全な射殺場にならないよう、視線を切る
  walls.push(
    { cx: -13, cz: -11, hw: 7, hd: 0.5 },
    { cx: 14, cz: -9, hw: 0.5, hd: 6 },
    { cx: 8, cz: -17, hw: 5, hd: 0.5 },
  );

  // 袋小路 — 街区の縁から内側へ刺さる短い路地。抜けられないので、
  // 追い込まれると詰む場所が生まれる(参照した写真にいくつも写っている)
  walls.push(...culDeSac({ x: -150, z: -18 }, { x: 0, z: -1 }, 14, 2.6));
  walls.push(...culDeSac({ x: 62, z: -40 }, { x: 0, z: -1 }, 12, 2.4));
  walls.push(...culDeSac({ x: -30, z: -64 }, { x: 0, z: -1 }, 13, 2.5));
  walls.push(...culDeSac({ x: 128, z: -84 }, { x: 0, z: -1 }, 15, 2.6));
  walls.push(...culDeSac({ x: 96, z: -110 }, { x: 0, z: -1 }, 12, 2.4));

  // 通りの縁を作る低い塀。通り抜けを絞って路地にする
  walls.push(
    { cx: -108, cz: -12, hw: 0.5, hd: 5 },
    { cx: 40, cz: -26, hw: 6, hd: 0.5 },
    { cx: 172, cz: -34, hw: 0.5, hd: 7 },
    { cx: -60, cz: -70, hw: 5, hd: 0.5 },
    { cx: 20, cz: -92, hw: 0.5, hd: 6 },
    { cx: -170, cz: -96, hw: 6, hd: 0.5 },
    { cx: 110, cz: -130, hw: 7, hd: 0.5 },
    { cx: -40, cz: -134, hw: 6, hd: 0.5 },
  );

  return {
    bounds: BOUNDS,
    walls: [...out.walls, ...mirrorAll(walls)],
    windowPlugs: out.windowPlugs,
    buildings: out.buildings,
    objectives: [
      { pos: { x: 0, z: 0 }, radius: OBJECTIVE.RADIUS.small },
      { pos: centreOf(shrine), radius: OBJECTIVE.RADIUS.large },
      { pos: centreOf(mirrorRect(shrine)), radius: OBJECTIVE.RADIUS.large },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 新市街 — 計画的に引かれた長い街区。行ごとに段違いで、斜行する街路に見える
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 新市街。参照した衛星写真(整然と区画された住宅区)の狙い:
 * 長い街区が平行に並び、通りが斜めに走り、モスクが広い空地を持つ。
 *
 * 壁は軸並行の矩形しか持てないので、斜行は**行ごとの段違い**で近似する。
 * 旧市街と逆で、街路に沿った**中距離の射線**が通る。選抜射手と機関銃が効く盤面。
 */
export function plannedDistrictField(): Field {
  const out = emptyStructures();
  const id = { v: 1 };
  const walls: AABB[] = [];

  // 段違いの行。1行進むごとに始点を +STEP ずらして斜行を作る
  const STEP = 15;
  const rows: Array<{ z0: number; z1: number; salt: number }> = [
    { z0: -40, z1: -20, salt: 101 },
    { z0: -66, z1: -46, salt: 113 },
    { z0: -92, z1: -72, salt: 127 },
    { z0: -118, z1: -98, salt: 139 },
  ];
  const mosque: Bounds = { minX: -140, maxX: -96, minZ: -44, maxZ: -14 };
  const roundabout: Bounds = { minX: -26, maxX: 26, minZ: -20, maxZ: 20 };
  // 礼拝堂は中庭の**外**。中庭は空地のまま残す(屋外の拠点として使うため)
  const prayerHall: Bounds = { minX: -158, maxX: -144, minZ: -42, maxZ: -18 };
  const reserved = [mosque, roundabout, prayerHall];

  rows.forEach((r, ri) => {
    const blocks = carve(
      blockRow(r.z0, r.z1, r.salt, {
        jog: ri * STEP,
        minW: 52,
        maxW: 84,
        minGap: 10,
        maxGap: 14,
        // 計画された住宅区なので揺らしは控えめ。区画の整然さが盤面の性格
        setback: 3,
      }),
      reserved,
    );
    for (const b of blocks) {
      // 長い街区を横並びの棟へ割る。計画された住宅区らしく、路地は細い
      for (const piece of subdivideBlock(b, r.salt, { alley: 2.6, maxRun: 22, minRun: 15 })) {
        addBuilding(out, id.v++, piece);
        addBuilding(out, id.v++, mirrorRect(piece));
      }
    }
  });

  // モスクの敷地。広い空地を持ち、そこが側面の拠点になる
  walls.push(...walledCompound(mosque, "east", { gateWidth: 6 }));
  addBuilding(out, id.v++, prayerHall, "east");
  addBuilding(out, id.v++, mirrorRect(prayerHall), "west");

  // 中央の環状交差点まわり。原点の拠点を囲う植樹帯
  walls.push(
    { cx: 0, cz: -14, hw: 10, hd: 0.5 },
    { cx: -16, cz: -4, hw: 0.5, hd: 8 },
    { cx: 22, cz: -9, hw: 0.5, hd: 5 },
  );

  // 段違いの継ぎ目に立つ袖壁。斜行した通りの見通しを切る
  walls.push(
    { cx: -60, cz: -33, hw: 0.5, hd: 8 },
    { cx: 78, cz: -33, hw: 0.5, hd: 8 },
    { cx: -30, cz: -59, hw: 0.5, hd: 8 },
    { cx: 104, cz: -59, hw: 0.5, hd: 8 },
    { cx: -96, cz: -85, hw: 0.5, hd: 8 },
    { cx: 36, cz: -85, hw: 0.5, hd: 8 },
    { cx: -140, cz: -111, hw: 0.5, hd: 8 },
    { cx: 62, cz: -111, hw: 0.5, hd: 8 },
    // 展開地の正面。街区の切れ目から射線が抜けるのを止める
    { cx: 150, cz: -128, hw: 12, hd: 0.5 },
    { cx: -18, cz: -132, hw: 12, hd: 0.5 },
  );

  walls.push(...culDeSac({ x: -78, z: -20 }, { x: 0, z: -1 }, 14, 2.6));
  walls.push(...culDeSac({ x: 128, z: -72 }, { x: 0, z: -1 }, 14, 2.6));

  return {
    bounds: BOUNDS,
    walls: [...out.walls, ...mirrorAll(walls)],
    windowPlugs: out.windowPlugs,
    buildings: out.buildings,
    objectives: [
      { pos: { x: 0, z: 0 }, radius: OBJECTIVE.RADIUS.small },
      { pos: centreOf(mosque), radius: OBJECTIVE.RADIUS.large },
      { pos: centreOf(mirrorRect(mosque)), radius: OBJECTIVE.RADIUS.large },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 大通りと市場 — 盤面を東西に横切る広い大通り。渡ることそのものが問題になる
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 大通りと市場。他の2枚と違い、**中央に開豁地がある**。
 *
 * 東西の大通り(幅40m)が盤面を横切り、両軍はこれを渡らないと拠点を取れない。
 * 大通りは前進方向と直交しているので、展開地から敵展開地への射線にはならない
 * (`[v6.2]` の要件は満たしたまま、危険な横断を1つ作る)。
 * 南北の市場街区は小さな店が密集した造りで、旧市街に近い近距離戦になる。
 */
export function boulevardField(): Field {
  const out = emptyStructures();
  const id = { v: 1 };
  const walls: AABB[] = [];

  // 大通り: z ∈ [-20, 20] を空ける。市場の街区はその南北に
  const rows: Array<{ z0: number; z1: number; jog: number; salt: number; small: boolean }> = [
    { z0: -46, z1: -24, jog: 11, salt: 211, small: true },
    { z0: -72, z1: -52, jog: -7, salt: 223, small: true },
    { z0: -98, z1: -78, jog: 19, salt: 233, small: false },
    { z0: -126, z1: -106, jog: 3, salt: 241, small: false },
  ];
  const hall: Bounds = { minX: -34, maxX: 10, minZ: -46, maxZ: -26 };
  const khan: Bounds = { minX: -186, maxX: -150, minZ: -48, maxZ: -24 };
  const reserved = [hall, khan];

  for (const r of rows) {
    const blocks = carve(
      blockRow(r.z0, r.z1, r.salt, {
        jog: r.jog,
        minW: r.small ? 14 : 30,
        maxW: r.small ? 30 : 60,
        minGap: r.small ? 6 : 9,
        maxGap: r.small ? 10 : 13,
        // 市場側(手前2行)は不揃い、奥の街区はやや整う
        setback: r.small ? 5 : 3,
      }),
      reserved,
    );
    for (const b of blocks) {
      for (const piece of subdivideBlock(b, r.salt, {
        alley: r.small ? 3 : 3.5,
        maxRun: r.small ? 16 : 26,
        minRun: r.small ? 9 : 14,
      })) {
        addBuilding(out, id.v++, piece);
        addBuilding(out, id.v++, mirrorRect(piece));
      }
    }
  }

  // 大通りの中央分離帯と、点在する遮蔽。渡り切るまでに息をつく場所がある
  walls.push(
    { cx: -150, cz: -2, hw: 22, hd: 0.5 },
    { cx: -70, cz: 2, hw: 18, hd: 0.5 },
    { cx: 30, cz: -2, hw: 20, hd: 0.5 },
    { cx: 120, cz: 2, hw: 16, hd: 0.5 },
    // 横断を絞る車列
    { cx: -104, cz: -12, hw: 4, hd: 0.5 },
    { cx: 6, cz: 10, hw: 4, hd: 0.5 },
    { cx: 86, cz: -13, hw: 4, hd: 0.5 },
    { cx: -34, cz: 12, hw: 4, hd: 0.5 },
  );

  // 大通りに面した大きな商館(予約した空地の内側に収める)
  addBuilding(out, id.v++, { minX: -32, maxX: 8, minZ: -44, maxZ: -28 }, "north");
  addBuilding(out, id.v++, mirrorRect({ minX: -32, maxX: 8, minZ: -44, maxZ: -28 }), "south");

  // 側面の拠点は塀で囲った隊商宿の中庭。屋外だが射線は切れる
  walls.push(...walledCompound(khan, "east", { gateWidth: 5 }));

  walls.push(...culDeSac({ x: 148, z: -24 }, { x: 0, z: -1 }, 12, 2.4));
  walls.push(...culDeSac({ x: -58, z: -52 }, { x: 0, z: -1 }, 13, 2.5));
  walls.push(...culDeSac({ x: 66, z: -78 }, { x: 0, z: -1 }, 14, 2.6));

  // 展開地の正面を塞ぐ張り出し
  walls.push(
    { cx: -120, cz: -132, hw: 14, hd: 0.5 },
    { cx: 40, cz: -134, hw: 14, hd: 0.5 },
    { cx: 176, cz: -130, hw: 12, hd: 0.5 },
  );

  return {
    bounds: BOUNDS,
    walls: [...out.walls, ...mirrorAll(walls)],
    windowPlugs: out.windowPlugs,
    buildings: out.buildings,
    objectives: [
      { pos: { x: 0, z: 0 }, radius: OBJECTIVE.RADIUS.large },
      { pos: centreOf(khan), radius: OBJECTIVE.RADIUS.large },
      { pos: centreOf(mirrorRect(khan)), radius: OBJECTIVE.RADIUS.large },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 塹壕戦 — 対峙する2本の塹壕線と、そのあいだの無人地帯
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 塹壕戦(`[v6.12]` 仕様 §7/§12)。市街地の3枚とは戦い方が根本的に違う唯一の盤面。
 *
 * **新しい機構をほとんど足していない。** 塹壕は「細長い建物」として作ってあり、
 * それだけで必要なものが揃う(`mapgen.ts` の `trenchBays` を参照):
 * 胸壁が視線と移動を止め、銃眼は `[v6.10]` の窓、掃討は突入ドリル。
 *
 * 盤面の構成:
 *
 * ```
 *   z=-140  展開線(青)
 *   z=-112  支援壕 ────────────────────
 *   z= -62  前線壕 ─┐ ┌─┐ ┌─┐ ┌─  ← 横墻で前後にずれる(縦射を通さない)
 *   z= -46  鉄条網 ▨  ▨  ▨   ▨
 *   z=   0  無人地帯 … 中央にクレーター陣地(拠点)
 *   z= +46  鉄条網(点対称)
 *   ...
 * ```
 *
 * 拠点は3つとも**屋外**(囲われた陣地の中庭)。両軍は自陣側の1つを最初から抱え、
 * 勝つには中央か敵側のもう1つが要る — 無人地帯を渡らなければ決着しない。
 * 迫撃砲(`[v6.10]`)がこの盤面で最も意味を持つ。
 */
export function trenchField(): Field {
  const out = emptyStructures();
  const id = { v: 1 };
  const walls: AABB[] = [];
  const navFromStart: number[] = [];

  /** 前線壕の中心線。ここを起点に無人地帯の幅が決まる */
  const FRONT = -38;
  /** 拠点にする堡塁の位置(前線壕の一部を太らせたもの) */
  const strong: Bounds = { minX: -110, maxX: -82, minZ: FRONT - 8, maxZ: FRONT + 7 };

  /** 塹壕1本を敷く。作った建物のIDを「最初からナビを張る」側へ積む */
  const layTrench = (
    x0: number,
    x1: number,
    z: number,
    opts?: Parameters<typeof trenchBays>[3],
  ): void => {
    for (const bay of trenchBays(x0, x1, z, opts)) {
      const rear: "north" | "south" = z < 0 ? "south" : "north";
      navFromStart.push(id.v);
      addBuilding(out, id.v++, bay, rear);
      navFromStart.push(id.v);
      addBuilding(out, id.v++, mirrorRect(bay), rear === "south" ? "north" : "south");
    }
  };

  // 前線壕。堡塁の位置だけ空けて、その両側へ伸ばす
  layTrench(-198, strong.minX - 4, FRONT);
  layTrench(strong.maxX + 4, -24, FRONT);
  layTrench(24, 198, FRONT);
  // 支援壕。区画が長く、疎
  layTrench(-186, -60, -88, { bay: 22, gap: 5 });
  layTrench(60, 186, -88, { bay: 22, gap: 5 });

  // 堡塁 — 前線壕を太らせた掩蔽陣地。**ここが拠点**なので、守る側は自然に
  // 塹壕の中で守り(窓=銃眼に就き)、攻める側は塹壕へ入って掃討することになる
  navFromStart.push(id.v);
  addBuilding(out, id.v++, strong, "south");
  navFromStart.push(id.v);
  addBuilding(out, id.v++, mirrorRect(strong), "north");

  // 交通壕(前線と支援を結ぶ南北の壕)
  for (const cx of [-150, -60, 60, 150]) {
    for (const seg of trenchBays(-80, -48, cx, { bay: 14, gap: 4, width: 4.4, traverse: 0 })) {
      const rect: Bounds = { minX: cx - 2.2, maxX: cx + 2.2, minZ: seg.minX, maxZ: seg.maxX };
      navFromStart.push(id.v);
      addBuilding(out, id.v++, rect, "east");
      navFromStart.push(id.v);
      addBuilding(out, id.v++, mirrorRect(rect), "west");
    }
  }

  // 鉄条網。前線壕の前に2列、隙間を千鳥にして通路を絞る
  walls.push(...wireBelt(-200, -20, -28, 71));
  walls.push(...wireBelt(20, 200, -28, 83));

  // 無人地帯の砲撃痕。渡るあいだに息をつける遮蔽を点在させる。
  // **これが薄いと誰も渡れない** — 実測で、遮蔽の無い124mの無人地帯は600秒かけても
  // 2名しか渡れず、拠点が一度も争われなかった。
  for (const [cx, cz] of [
    [-176, -18], [-148, -6], [-120, -14], [-96, -20], [-72, -8],
    [-48, -16], [-26, -6], [-6, -18], [30, -12], [54, -20],
    [78, -6], [104, -16], [130, -8], [156, -18], [184, -12],
    [-160, 10], [-108, 6], [-60, 12], [-16, 8], [44, 10], [92, 6], [140, 12], [178, 8],
  ] as const) {
    walls.push({ cx, cz, hw: 3.6, hd: 0.5 });
    walls.push({ cx: cx + 4.8, cz: cz - 3.8, hw: 0.5, hd: 2.8 });
  }

  // 中央のクレーター陣地。無人地帯で唯一まとまった遮蔽になる。
  //
  // **塀は一重にする。** 二重の環にして門を南北へ振り分けたら、入るのに環を
  // 回り込む必要が生まれ、無人地帯の真ん中で遠回りを強いられて誰も入れなかった
  // (600秒かけて中央拠点が0%のまま)。遮蔽としては一重で足りる。
  const crater: Bounds = { minX: -19, maxX: 19, minZ: -14, maxZ: 14 };
  walls.push(...walledCompound(crater, "north", { gateWidth: 9 }));
  // 南側にも口を開ける(点対称なので両軍が同じ条件で入れる)
  walls.push({ cx: -13.5, cz: -14, hw: 5.5, hd: 0.5 });
  walls.push({ cx: 13.5, cz: -14, hw: 5.5, hd: 0.5 });
  // 環の内側の遮蔽。入った側が完全な的にならないように
  walls.push({ cx: -7, cz: 4, hw: 4, hd: 0.5 });
  walls.push({ cx: 9, cz: -3, hw: 0.5, hd: 4 });

  // 後方の掩蔽壕(支援壕の後ろ)。立て直しの遮蔽
  const dugout: Bounds = { minX: -128, maxX: -110, minZ: -112, maxZ: -100 };
  addBuilding(out, id.v++, dugout, "north");
  addBuilding(out, id.v++, mirrorRect(dugout), "south");

  return {
    bounds: BOUNDS,
    walls: [...out.walls, ...mirrorAll(walls)],
    windowPlugs: out.windowPlugs,
    buildings: out.buildings,
    navFromStart,
    // **拠点は2つ、両軍の堡塁そのもの。** 中央のクレーターは遮蔽として残すが拠点に
    // しない — 露出した拠点を火線下で保持することが現状のC2にはできず
    // (`[v6.10]` F-9 の残件)、600秒かけて0%のままだった。3つのうち2つが必要な
    // 規則のもとで中央が永久に中立だと、**決着が構造的に起こらない**。
    //
    // 2つにすると過半数=2、つまり「自分の堡塁を保ちつつ敵の堡塁を奪う」が勝利条件に
    // なる。塹壕戦の勝ち方そのもので、しかも到達できることは実測済み
    // (青の前縁は敵前線壕の +36m まで届いている)。
    objectives: [
      { pos: centreOf(strong), radius: OBJECTIVE.RADIUS.small },
      { pos: centreOf(mirrorRect(strong)), radius: OBJECTIVE.RADIUS.small },
    ],
  };
}

