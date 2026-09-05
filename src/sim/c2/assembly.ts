/**
 * 初期展開 — 集結地の占領(`[v6.13]` 仕様 §3① / §11)。
 *
 * **開けた土地に整列して戦闘を始めるのはおかしい。** 実際の中隊は攻撃発起の前に
 * 集結地(assembly area)を占領しており、地形の遮蔽と隠掩蔽の中に分散して待つ。
 * 整列した縦隊が露天に並んでいるのは、シナリオが展開線を直値(z=±140)で持っている
 * ことの副作用であって、指揮の結果ではなかった。
 *
 * **ここは立案フェーズの一部**(米陸軍の指揮活動手順 TLP でいう「行動方針の決定」に
 * 部隊の配置が含まれるのと同じ)。したがって:
 *
 *   - **敵情は一切参照しない**(仕様 §5)。使うのは地形・拠点・自軍の位置だけで、
 *     `world.soldiers` の敵側を読まない。立案が敵を見ないという §3① の担保を、
 *     配置にもそのまま適用する
 *   - **陣営の前進フレームで評価する**(仕様 §2/§13)。候補位置を世界座標で並べると、
 *     点対称の盤面でも両軍の選ぶ場所が鏡像にならない(planning.ts と同じ理由)
 *   - **乱数を引かない**。同じ盤面・同じ編成なら毎回同じ配置になる
 *
 * `createWorld` ではなく `beginPlanning` から呼ぶので、立案フェーズを踏まないテストや
 * バランス検証ハーネスは従来どおりシナリオの配置をそのまま使う — あちらが測るのは
 * 指揮の結果ではなく機構なので、配置は固定であるほうが都合がよい。
 */

import { COVER_SATURATE, forEachCoverNear } from "../cover.ts";
import { collidesWall } from "../geometry.ts";
import { insideBounds } from "../cqb.ts";
import type { Side, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

/**
 * 小隊が集結地を探す範囲(m)。**前方だけ**を見る。
 *
 * 展開線(z=±140)は盤面の市街地より手前にあり、後ろは盤端まで何も無い開豁地。
 * 実測すると、遮蔽の効きは z=−150 で 0.00、−130 で 0.11、−110 で 0.31 と
 * 前方へ行くほど上がる。後方を候補に入れても「より何も無い場所」しか出てこない。
 */
const AREA_FORWARD_MIN = 6;
const AREA_FORWARD_MAX = 34;
const AREA_LATERAL = 30;
/** 集結地の候補を刻む間隔 m */
const AREA_STEP = 6.5;
/** 集結地の遮蔽を測るサンプル半径 m。小隊がすっぽり入る広さで見る */
const AREA_SAMPLE_R = 18;
/** 小隊どうしがこの距離より近いと減点する m(集結地は分散させる) */
const AREA_SPACING = 46;

/** 個々の兵士が遮蔽へ寄る範囲 m。これを広げると隊形が崩れる */
const SNAP_RADIUS = 12;
/** 同じ遮蔽に2人を入れないための最小間隔 m */
const SNAP_SPACING = 1.9;

interface Frame {
  fwd: Vec2;
  right: Vec2;
}

function frameOf(dir: Vec2): Frame {
  const d = Math.hypot(dir.x, dir.z) || 1;
  const fwd = { x: dir.x / d, z: dir.z / d };
  return { fwd, right: { x: -fwd.z, z: fwd.x } };
}

function centroidOf(units: readonly Soldier[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const u of units) {
    x += u.pos.x;
    z += u.pos.z;
  }
  return { x: x / units.length, z: z / units.length };
}

/** その地点まわりの遮蔽の効き。小隊がまとまって入れる場所かを見る。 */
function areaCover(world: World, at: Vec2): number {
  let total = 0;
  let n = 0;
  forEachCoverNear(world.coverIndex, at, AREA_SAMPLE_R, (p) => {
    total += p.cover;
    n++;
  });
  // 候補点が少ない = 遮蔽そのものが無い場所。平均だけで見ると
  // 「遮蔽点が1つしかないが濃い」場所が勝ってしまう
  return n === 0 ? 0 : (total / n) * Math.min(1, n / 24);
}

/** 盤内で、壁の中でも建物の中でもないか。 */
function standable(world: World, p: Vec2): boolean {
  const b = world.bounds;
  if (p.x < b.minX + 4 || p.x > b.maxX - 4 || p.z < b.minZ + 4 || p.z > b.maxZ - 4) return false;
  if (collidesWall(world.walls, p.x, p.z, 0.45)) return false;
  // 屋内は原則避ける。突入が決まるまで屋内ナビは張られないので、建物の中に置くと
  // その部隊は一歩も動けない(`[v6.12]` の塹壕で踏んだのと同じ罠)。
  //
  // **例外は最初からナビが張られている建物** — つまり塹壕。自軍の支援壕に集結するのは
  // 塹壕戦のあるべき姿で、実際その盤面は後方が完全な開豁地なので、ここを許さないと
  // 100%が露天のままになる(実測: 許す前は72%が開豁地)。
  const host = world.buildings.find((bl) => insideBounds(bl.bounds, p));
  return host === undefined || world.navBuildings.has(host.id);
}

/**
 * 小隊1個ぶんの集結地を選ぶ。候補は**自陣営のフレーム**で刻むので、点対称の盤面では
 * 鏡像の小隊が鏡像の候補を同じ順に評価する(仕様 §2/§13)。
 */
function pickAssemblyArea(
  world: World,
  frame: Frame,
  anchor: Vec2,
  taken: readonly Vec2[],
): Vec2 {
  let best = anchor;
  let bestScore = -Infinity;
  for (let a = AREA_FORWARD_MIN; a <= AREA_FORWARD_MAX + 0.001; a += AREA_STEP) {
    for (let l = -AREA_LATERAL; l <= AREA_LATERAL + 0.001; l += AREA_STEP) {
      const p = {
        x: anchor.x + frame.fwd.x * a + frame.right.x * l,
        z: anchor.z + frame.fwd.z * a + frame.right.z * l,
      };
      if (!standable(world, p)) continue;
      // 遮蔽が主。前後・左右のずれは「担当区域から離れすぎない」ための軽い錘で、
      // これを重くすると開豁地に留まる(実測: 錘 0.22 だと遮蔽の利得と相殺して動かない)
      let score = areaCover(world, p) / COVER_SATURATE;
      score -= (a / AREA_FORWARD_MAX) * 0.10;
      score -= (Math.abs(l) / AREA_LATERAL) * 0.18;
      for (const t of taken) {
        const d = Math.hypot(p.x - t.x, p.z - t.z);
        if (d < AREA_SPACING) score -= (1 - d / AREA_SPACING) * 0.8;
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * 兵士1名を近くの遮蔽へ寄せる。取られていない候補のうち最も遮蔽が効くものを選ぶ。
 * 見つからなければ動かさない — 無理に動かすより、開けた場所に立たせるほうがまし。
 */
function snapToCover(world: World, u: Soldier, taken: Vec2[]): void {
  let best: Vec2 | null = null;
  let bestCover = -1;
  forEachCoverNear(world.coverIndex, u.pos, SNAP_RADIUS, (p) => {
    if (p.cover <= bestCover) return;
    if (taken.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < SNAP_SPACING)) return;
    if (!standable(world, p)) return;
    bestCover = p.cover;
    best = { x: p.x, z: p.z };
  });
  if (!best) return;
  const at: Vec2 = best;
  u.pos = { x: at.x, z: at.z };
  u.eye = { x: at.x, z: at.z };
  taken.push(at);
}

/**
 * 集結地を占領する。`beginPlanning` から、作戦を立てたあとに1度だけ呼ぶ。
 *
 * 2段構え:
 *   1. **小隊ごとに集結地を選び、隊をそのまま平行移動する。** 隊形は崩さない —
 *      崩すと「どこが1個小隊か」が盤面から読めなくなる
 *   2. **兵士ごとに近くの遮蔽へ寄せる。** 半径は小さく取ってあるので、隊形の形は
 *      保ったまま、一人ひとりが壁の陰に入る
 */
export function assembleForBattle(world: World): void {
  for (const co of world.companies) {
    const frame = frameOf(co.advanceDir);
    const areas: Vec2[] = [];

    // ── 1. 小隊ごとの集結地 ──
    // 小隊IDの順で処理する。両陣営で対応する小隊は同じ順番に来るので、
    // 「先に置いたほうが優先」という順序依存があっても鏡像は保たれる
    const platoons = world.platoons
      .filter((p) => p.side === co.side && p.companyId === co.companyId)
      .slice()
      .sort((a, b) => a.platoonId - b.platoonId);

    for (const pl of platoons) {
      const men = world.soldiers.filter(
        (s) => s.side === pl.side && s.platoonId === pl.platoonId && s.status === "ok",
      );
      if (men.length === 0) continue;
      const anchor = centroidOf(men);
      const area = pickAssemblyArea(world, frame, anchor, areas);
      areas.push(area);
      const dx = area.x - anchor.x;
      const dz = area.z - anchor.z;
      for (const u of men) {
        const p = { x: u.pos.x + dx, z: u.pos.z + dz };
        // 平行移動で壁の中へ入ってしまう隊員だけは元の位置に残す
        if (!standable(world, p)) continue;
        u.pos = p;
        u.eye = { x: p.x, z: p.z };
      }
    }

    // ── 2. 兵士ごとに遮蔽へ寄せる ──
    // 陣営ごとに「取った位置」を持つ。両陣営は開始時に280m離れているので
    // 干渉しないが、リストを分けておけば順序依存が陣営をまたがない
    const taken: Vec2[] = [];
    const own = world.soldiers.filter(
      (s) => s.side === co.side && s.companyId === co.companyId && s.status === "ok",
    );
    for (const u of own) snapToCover(world, u, taken);
  }
}

/** 集結地の占領を行ったかを外から確かめるための、開けた場所に立つ兵士の割合。 */
export function exposedFraction(world: World, side: Side): number {
  const men = world.soldiers.filter((s) => s.side === side && s.status === "ok");
  if (men.length === 0) return 0;
  let exposed = 0;
  for (const u of men) {
    let near = false;
    forEachCoverNear(world.coverIndex, u.pos, 3.5, (p) => {
      if (p.cover > COVER_SATURATE * 0.35) near = true;
    });
    if (!near) exposed++;
  }
  return exposed / men.length;
}
