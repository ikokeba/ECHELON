/**
 * 防衛計画(`[v7.2]` ロードマップ S-1)。攻防戦の防御側の中隊長が、戦闘前に陣地を置く。
 *
 * 置くのは3種類(鉄条網は経路探索の作り直しが要るので見送り。ロードマップに残す):
 *   - **機関銃陣地** — 火器分隊の1班を据える。射界(±35°)と最終阻止射撃線(FPL)を持ち、
 *     射界の外の敵は撃たない。左右の銃のFPLは拠点の前方で交わる(相互支援の火網)
 *   - **射撃壕・土嚢** — 拠点の前半分に扇状に置く。就いた者は窓と同じ補正を受ける(§8)
 *   - **予備陣地** — 拠点の後方。そこを守る小隊のFTが後退・潰走のときに下がる先
 *
 * ── 守っている原則 ──
 *   P1 **攻撃側の配置は見ない。** 立案時点で belief は空。材料は地形・拠点・自軍だけで、
 *      敵が来る方角は自軍の前進方向(=敵陣の方角)で見積もる。攻撃側はこの配置を読まない
 *   P2 **陣営で分岐しない。** 前進フレーム(前 = advanceDir、右 = その直交)で組むので、
 *      陣営ラベルを入れ替えても同じ陣地になる
 *   P3 **決定論。** 乱数は引かない。人間の置き直しは初期条件(`Scenario.defenseEdits`)に載る
 *   P4 **人間とAIが同じ規則を通る。** 置ける場所の判定は `defenseSpotBlocker` 1つで、
 *      AI の候補選びも人間の置き直しもここを通る
 */

import { DEFENSE, SIM_HZ } from "../constants.ts";
import { aiSuppressed, type ControlState } from "../control.ts";
import { insideBounds } from "../cqb.ts";
import { castRayIndexed, collidesWallIndexed, hasLineOfSightIndexed } from "../wallIndex.ts";
import { isOffField } from "../systems/litter.ts";
import { issue } from "./fireteam.ts";
import { isDefender } from "./planning.ts";
import type {
  AABB,
  CompanyState,
  DefensivePosition,
  FireteamState,
  Soldier,
  Vec2,
} from "../types.ts";
import { setWire } from "../world.ts";
import type { World } from "../world.ts";

const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);
const COS_SECTOR = Math.cos(DEFENSE.MG_SECTOR_HALF_RAD);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function unit(v: Vec2): Vec2 {
  const d = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / d, z: v.z / d };
}

function dirTo(a: Vec2, b: Vec2): Vec2 {
  return unit({ x: b.x - a.x, z: b.z - a.z });
}

function rotate(v: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

/**
 * 陣地を置けない理由。null なら置ける(AI・人間で共通、P4)。
 *   out_of_bounds : 盤の外(縁から4m以内を含む)
 *   blocked       : 壁・建物の中
 *   too_far       : 自軍の拠点から `MAX_FROM_OBJECTIVE` より遠い
 */
export type DefenseSpotBlock = "out_of_bounds" | "blocked" | "too_far";

export const DEFENSE_SPOT_TEXT: Record<DefenseSpotBlock, string> = {
  out_of_bounds: "盤の外",
  blocked: "壁・建物の中には置けない",
  too_far: `自軍の拠点から ${DEFENSE.MAX_FROM_OBJECTIVE}m 以内に置く`,
};

export function defenseSpotBlocker(world: World, p: Vec2): DefenseSpotBlock | null {
  const b = world.bounds;
  if (p.x < b.minX + 4 || p.x > b.maxX - 4 || p.z < b.minZ + 4 || p.z > b.maxZ - 4) {
    return "out_of_bounds";
  }
  if (collidesWallIndexed(world.wallIndex, p.x, p.z, 0.8)) return "blocked";
  if (world.buildings.some((bd) => insideBounds(bd.bounds, p))) return "blocked";
  if (!world.objectives.some((o) => dist(o.pos, p) <= DEFENSE.MAX_FROM_OBJECTIVE)) return "too_far";
  return null;
}

/** 鉄条網の線分上の点(`[v7.2]` S-1b)。正面に直交して `WIRE_HALF_LEN` ずつ左右へ */
function wireSamples(center: Vec2, face: Vec2, step: number): Vec2[] {
  const r = { x: -face.z, z: face.x };
  const out: Vec2[] = [];
  const n = Math.round((DEFENSE.WIRE_HALF_LEN * 2) / step);
  for (let i = 0; i <= n; i++) {
    const t = -DEFENSE.WIRE_HALF_LEN + i * step;
    out.push({ x: center.x + r.x * t, z: center.z + r.z * t });
  }
  return out;
}

/**
 * 鉄条網の線分を、移動を止める小さな軸平行ボックスの列にする(`[v7.2]` S-1b)。
 * 壁は軸平行ボックスしか持てないので、斜めの線は重なり合う小箱で近似する
 */
export function wireBoxes(p: DefensivePosition): AABB[] {
  return wireSamples(p.pos, p.facing, DEFENSE.WIRE_BOX_STEP).map((q) => ({
    cx: q.x,
    cz: q.z,
    hw: DEFENSE.WIRE_BOX_HALF,
    hd: DEFENSE.WIRE_BOX_HALF,
  }));
}

/**
 * 鉄条網を置けない理由(`[v7.2]` S-1b)。線分の全長が置ける場所で、拠点の判定円と
 * 他の陣地を塞がないこと。AI の候補選びも人間の置き直しもここを通る(P4)
 */
export function wireSpotBlocker(
  world: World,
  center: Vec2,
  face: Vec2,
  selfId = -1,
): DefenseSpotBlock | null {
  for (const q of wireSamples(center, face, 1)) {
    const b = defenseSpotBlocker(world, q);
    if (b === "too_far") continue; // 端が遠くても中心が近ければよい(下で中心を見る)
    if (b) return b;
    if (world.objectives.some((o) => dist(o.pos, q) < o.radius + DEFENSE.WIRE_CLEARANCE))
      return "blocked";
    if (
      world.defense.some(
        (d) => d.id !== selfId && d.kind !== "wire" && dist(d.pos, q) < DEFENSE.WIRE_CLEARANCE,
      )
    ) {
      return "blocked";
    }
  }
  return defenseSpotBlocker(world, center) === "too_far" ? "too_far" : null;
}

/** 陣地の種類に応じた置き場所の規則(鉄条網だけは線分で見る) */
function spotBlockerFor(world: World, p: DefensivePosition, at: Vec2): DefenseSpotBlock | null {
  return p.kind === "wire"
    ? wireSpotBlocker(world, at, p.facing, p.id)
    : defenseSpotBlocker(world, at);
}

/** 鉄条網を張り直す(経路探索と移動の当たり判定)。立案のときだけ呼ぶ */
function applyWire(world: World): void {
  const boxes = world.defense.filter((p) => p.kind === "wire").flatMap(wireBoxes);
  if (boxes.length === 0 && world.wireWalls.length === 0) return;
  setWire(world, boxes);
}

/** 正面へ射界が抜けているか */
function hasField(world: World, p: Vec2, face: Vec2, len: number): boolean {
  return hasLineOfSightIndexed(world.wallIndex, p.x, p.z, p.x + face.x * len, p.z + face.z * len);
}

/**
 * 中隊長(AI)の陣地案。**世界は変えない**(立案と下達を分ける、planning.ts と同じ作法)。
 * 並び順は計画の任務の順 → 拠点ごとに 予備 → 射撃壕 → 機関銃。人間の置き直しは
 * この並び順(idx)で指す。
 */
export function planDefense(world: World, co: CompanyState): Omit<DefensivePosition, "id">[] {
  const out: Omit<DefensivePosition, "id">[] = [];
  if (!co.plan || !isDefender(world, co.side)) return out;
  const fwd = unit(co.advanceDir);
  const right = { x: -fwd.z, z: fwd.x };
  const ok = (p: Vec2): boolean => defenseSpotBlocker(world, p) === null;

  for (const t of co.plan.tasks) {
    if (t.objectiveId === null) continue;
    const o = world.objectives.find((x) => x.id === t.objectiveId);
    if (!o) continue;

    // ── 予備陣地: 拠点の真後ろ ──
    for (const back of DEFENSE.ALTERNATE_BACK) {
      const p = { x: o.pos.x - fwd.x * back, z: o.pos.z - fwd.z * back };
      if (!ok(p)) continue;
      out.push({
        side: co.side,
        kind: "alternate",
        pos: p,
        facing: { ...fwd },
        objectiveId: o.id,
        crew: null,
      });
      break;
    }

    // ── 射撃壕: 拠点の前半分に扇状。拠点が建物の中なら、建物の外の近いところから順に ──
    for (const ang of DEFENSE.FIGHTING_ANGLES_DEG.slice(0, DEFENSE.FIGHTING_PER_OBJECTIVE)) {
      const ray = rotate(fwd, ang);
      // 壕の正面は敵の方角へ寄せる(真横を向いた壕は扇の端を見張るだけになる)
      const face = rotate(fwd, ang / 2);
      for (let r = DEFENSE.FIGHTING_MIN_R; r <= DEFENSE.FIGHTING_MAX_R; r += 2) {
        const p = { x: o.pos.x + ray.x * r, z: o.pos.z + ray.z * r };
        if (!ok(p) || !hasField(world, p, face, DEFENSE.FIGHTING_FIELD)) continue;
        if (out.some((q) => dist(q.pos, p) < DEFENSE.MIN_SPACING)) continue;
        out.push({
          side: co.side,
          kind: "fighting",
          pos: p,
          facing: face,
          objectiveId: o.id,
          crew: null,
        });
        break;
      }
    }

    // ── 鉄条網(`[v7.2]` S-1b): 拠点の前方、射撃壕の外側に、接近路を横切る向きで ──
    // 射撃壕・機関銃の射界の中に敵を足止めするのが役目なので、壕より遠く(20〜36m)に張る
    for (const ang of DEFENSE.WIRE_ANGLES_DEG.slice(0, DEFENSE.WIRE_PER_OBJECTIVE)) {
      const ray = rotate(fwd, ang);
      for (let r = DEFENSE.WIRE_MIN_R; r <= DEFENSE.WIRE_MAX_R; r += 2) {
        const p = { x: o.pos.x + ray.x * r, z: o.pos.z + ray.z * r };
        if (wireSpotBlocker(world, p, ray) !== null) continue;
        if (out.some((q) => dist(q.pos, p) < DEFENSE.WIRE_HALF_LEN * 2)) continue;
        out.push({
          side: co.side,
          kind: "wire",
          pos: p,
          facing: ray,
          objectiveId: o.id,
          crew: null,
        });
        break;
      }
    }

    // ── 機関銃陣地: その小隊の火器分隊の2班を拠点の左右に ──
    // 市街地では「拠点の前方の1点」へ射線が通る場所がまず無い(実測: 3拠点とも0か所)。
    // なので点ではなく**射界の長さ**で選ぶ: 拠点のまわりの候補点から、敵の方角へ向けた
    // 数本の射線のうち最も遠くまで抜けるものを採る。左の銃は右寄りへ、右の銃は左寄りへ
    // 向けた射線を優先するので、射界は拠点の前で交わりやすい(相互支援の火網)。
    const weapons = world.squads.filter(
      (sq) =>
        sq.side === co.side &&
        sq.platoonId === t.platoonId &&
        world.soldiers.some(
          (s) => s.side === sq.side && s.squadId === sq.squadId && s.role === "mg",
        ),
    );
    for (const sq of weapons) {
      const teams = world.fireteams
        .filter((f) => f.side === sq.side && f.squadId === sq.squadId)
        .sort((a, b) => a.ftIndex - b.ftIndex);
      teams.forEach((ft, i) => {
        // 1班目は左、2班目は右(自陣営フレーム。鏡像でも同じ側になる)
        const sign = i % 2 === 0 ? -1 : 1;
        let best: { p: Vec2; face: Vec2; score: number } | null = null;
        for (let lat = 0; lat <= DEFENSE.MG_SEARCH_LAT; lat += 4) {
          for (let fwdOff = -DEFENSE.MG_SEARCH_BACK; fwdOff <= DEFENSE.MG_SEARCH_FWD; fwdOff += 4) {
            const p = {
              x: o.pos.x + right.x * sign * lat + fwd.x * fwdOff,
              z: o.pos.z + right.z * sign * lat + fwd.z * fwdOff,
            };
            if (!ok(p)) continue;
            if (out.some((q) => dist(q.pos, p) < DEFENSE.MIN_SPACING)) continue;
            for (const ang of DEFENSE.MG_ANGLES_DEG) {
              // 内側(拠点の前)へ振る向きを正にとる
              const face = rotate(fwd, -sign * ang);
              const field = castRayIndexed(
                world.wallIndex,
                p.x,
                p.z,
                face.x,
                face.z,
                DEFENSE.MG_FIELD_CAP,
              );
              if (field < DEFENSE.MG_MIN_FIELD) continue;
              // 射界が長いほど良く、拠点から遠いほど・外へ振るほど少し悪い
              const score = field - 0.3 * dist(p, o.pos) - (ang < 0 ? 5 : 0);
              if (!best || score > best.score + 1e-9) best = { p, face, score };
            }
          }
        }
        if (!best) return;
        out.push({
          side: co.side,
          kind: "mg",
          pos: best.p,
          facing: best.face,
          objectiveId: o.id,
          crew: { squadId: ft.squadId, ftIndex: ft.ftIndex },
        });
      });
    }
  }

  // ── `[v7.3]` 分隊の陣地(ロードマップ A-4)。**既存の陣地のあとに並べる** — 人間の置き直しは
  //    AI案での並び順(idx)で指すので、前に挟むと `[v7.2]` の初期条件コードがずれる ──
  for (const t of co.plan.tasks) {
    if (t.objectiveId === null) continue;
    const o = world.objectives.find((x) => x.id === t.objectiveId);
    if (!o) continue;
    const rifles = rifleSquadsOf(world, co.side, t.platoonId);
    const isMain = o.id === co.plan.mainObjectiveId;

    // 待ち伏せ(L字型): 主陣地の正面だけ。3個以上の小銃分隊があるときに2番目の分隊を充てる
    if (isMain && rifles.length >= 3) {
      const amb = planAmbush(world, o.pos, fwd, right, out);
      if (amb) {
        out.push({
          side: co.side,
          kind: "ambush",
          pos: amb.pos,
          facing: amb.face,
          objectiveId: o.id,
          crew: { squadId: rifles[1]!, ftIndex: -1 },
          killZone: amb.kz,
        });
        continue; // 主陣地の正面は待ち伏せが受け持つ(前進陣地を重ねると殺傷地帯に立つことになる)
      }
    }

    // 前進陣地(縦深防御の第1線): 2個以上の小銃分隊があるときに1番目の分隊を充てる
    if (rifles.length >= 2) {
      const fp = planForward(world, o.pos, fwd, right, out);
      if (fp) {
        out.push({
          side: co.side,
          kind: "forward",
          pos: fp,
          facing: { ...fwd },
          objectiveId: o.id,
          crew: { squadId: rifles[0]!, ftIndex: -1 },
        });
      }
    }
  }
  return out;
}

/**
 * その小隊の小銃分隊(機関銃を持たない分隊)の squadId。編成上の通し番号の順
 * (鏡像の2人で一致する `ordinal`、P2)
 */
function rifleSquadsOf(world: World, side: CompanyState["side"], platoonId: number): number[] {
  const first = new Map<number, number>();
  const hasMg = new Set<number>();
  for (const s of world.soldiers) {
    if (s.side !== side || s.platoonId !== platoonId || s.squadId < 0) continue;
    if (s.role === "mg") hasMg.add(s.squadId);
    const cur = first.get(s.squadId);
    if (cur === undefined || s.ordinal < cur) first.set(s.squadId, s.ordinal);
  }
  return [...first.entries()]
    .filter(([id]) => !hasMg.has(id))
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

/**
 * 前進陣地(`[v7.3]` A-4)。拠点の前方 `FORWARD_DIST`、敵の方角へ射界の抜ける地点。
 * 真正面で見つからなければ左右へ少しずつずらす(自陣営フレームの左から、P2)
 */
function planForward(
  world: World,
  obj: Vec2,
  fwd: Vec2,
  right: Vec2,
  taken: ReadonlyArray<{ pos: Vec2 }>,
): Vec2 | null {
  for (const d of DEFENSE.FORWARD_DIST) {
    for (const lat of [0, -6, 6, -12, 12]) {
      const p = { x: obj.x + fwd.x * d + right.x * lat, z: obj.z + fwd.z * d + right.z * lat };
      if (defenseSpotBlocker(world, p) !== null) continue;
      if (!hasField(world, p, fwd, DEFENSE.FORWARD_FIELD)) continue;
      if (taken.some((q) => dist(q.pos, p) < DEFENSE.MIN_SPACING * 2)) continue;
      return p;
    }
  }
  return null;
}

/**
 * 待ち伏せ(`[v7.3]` A-4、L字型)。殺傷地帯 = 拠点の前方の接近路上の1点。
 * 側面の組(長辺)は接近路から横へ離れた所に伏せ、殺傷地帯へ視線が通ること。
 * 正面の組(短辺)は殺傷地帯の手前(拠点寄り)から前を向く(`ambushSlots`)。
 */
function planAmbush(
  world: World,
  obj: Vec2,
  fwd: Vec2,
  right: Vec2,
  taken: ReadonlyArray<{ pos: Vec2 }>,
): { pos: Vec2; face: Vec2; kz: Vec2 } | null {
  for (const d of DEFENSE.AMBUSH_KZ_DIST) {
    const kz = { x: obj.x + fwd.x * d, z: obj.z + fwd.z * d };
    const b = world.bounds;
    if (kz.x < b.minX + 4 || kz.x > b.maxX - 4 || kz.z < b.minZ + 4 || kz.z > b.maxZ - 4) continue;
    for (const lat of DEFENSE.AMBUSH_LAT) {
      for (const sign of [-1, 1]) {
        const p = { x: kz.x + right.x * sign * lat, z: kz.z + right.z * sign * lat };
        if (defenseSpotBlocker(world, p) !== null) continue;
        if (!hasLineOfSightIndexed(world.wallIndex, p.x, p.z, kz.x, kz.z)) continue;
        if (taken.some((q) => dist(q.pos, p) < DEFENSE.MIN_SPACING * 2)) continue;
        // 隠れていること: 接近路の上流(敵が来る側)から伏せる位置が見通せない。見えていれば
        // 敵は殺傷地帯に入る前に伏せた分隊を撃つ — 旧市街で開戦2秒で発見されたのがそれ
        // 長辺(伏せる位置)も短辺(殺傷地帯の手前)も、どちらも隠れていること
        const short = {
          x: kz.x - fwd.x * DEFENSE.AMBUSH_SHORT_BACK + right.x * sign * 6,
          z: kz.z - fwd.z * DEFENSE.AMBUSH_SHORT_BACK + right.z * sign * 6,
        };
        const exposed = DEFENSE.AMBUSH_HIDE_FROM.some(([up, lat]) => {
          const q = { x: kz.x + fwd.x * up + right.x * lat, z: kz.z + fwd.z * up + right.z * lat };
          return [p, short].some((t) => hasLineOfSightIndexed(world.wallIndex, q.x, q.z, t.x, t.z));
        });
        if (exposed) continue;
        return { pos: p, face: dirTo(p, kz), kz };
      }
    }
  }
  return null;
}

/**
 * 陣地を動かす。待ち伏せは殺傷地帯ごと平行に動かす(伏せる位置と撃つ先の関係を保つ)
 */
function relocate(p: DefensivePosition, at: Vec2): void {
  if (p.killZone) {
    p.killZone = { x: p.killZone.x + at.x - p.pos.x, z: p.killZone.z + at.z - p.pos.z };
  }
  p.pos = { ...at };
}

/**
 * 置き直したあとの正面。機関銃は、敵の方角(±45°)のうちいちばん射界の長い向きへ
 * 据え直す。他の陣地は向きを変えない
 */
function refaceAfterMove(world: World, p: DefensivePosition, co: CompanyState | undefined): void {
  if (p.kind === "ambush" && p.killZone) {
    p.facing = dirTo(p.pos, p.killZone);
    return;
  }
  if (p.kind !== "mg" || !co) return;
  const fwd = unit(co.advanceDir);
  let best = p.facing;
  let bestField = -1;
  for (const ang of [0, -15, 15, -30, 30, -45, 45]) {
    const face = rotate(fwd, ang);
    const field = castRayIndexed(
      world.wallIndex,
      p.pos.x,
      p.pos.z,
      face.x,
      face.z,
      DEFENSE.MG_FIELD_CAP,
    );
    if (field > bestField + 1e-9) {
      bestField = field;
      best = face;
    }
  }
  p.facing = best;
}

/**
 * 立案(beginPlanning)から呼ぶ。防御側の中隊ごとに陣地を置き、人間の置き直しを重ね、
 * 予備陣地を後退先として下達する。攻撃側・遭遇戦では何もしない(陣地は空)。
 */
export function setupDefense(world: World): void {
  world.defense = [];
  let id = 1;
  for (const co of world.companies) {
    const plan = planDefense(world, co);
    plan.forEach((p, idx) => {
      const pos: DefensivePosition = { ...p, id: id++ };
      const edit = world.defenseEdits.find((e) => e.side === co.side && e.idx === idx);
      // 置き直しも同じ規則を通す。初期条件コードを手で書き換えても壁の中には置けない
      if (edit && spotBlockerFor(world, pos, edit.pos) === null) {
        relocate(pos, edit.pos);
        refaceAfterMove(world, pos, co);
      }
      world.defense.push(pos);
    });
  }
  applyAlternates(world);
  applyWire(world);
  occupyPositions(world);
}

/**
 * 拠点のまわりで、まだ誰も立っていない最寄りの地点。角度は自陣営フレームで回すので
 * 鏡像の盤面では鏡像の地点になる(P2)
 */
function nearestFreeSlot(world: World, c: Vec2, fwd: Vec2, taken: readonly Vec2[]): Vec2 {
  const fits = (q: Vec2): boolean =>
    !collidesWallIndexed(world.moveIndex, q.x, q.z, 0.5) &&
    !taken.some((t) => (t.x - q.x) ** 2 + (t.z - q.z) ** 2 < 1.4 * 1.4) &&
    q.x > world.bounds.minX + 2 &&
    q.x < world.bounds.maxX - 2 &&
    q.z > world.bounds.minZ + 2 &&
    q.z < world.bounds.maxZ - 2;
  if (fits(c)) return c;
  for (let r = 1.5; r <= 40; r += 1.5) {
    const n = Math.max(8, Math.round(r * 4));
    for (let i = 0; i < n; i++) {
      const v = rotate(fwd, (i / n) * 360);
      const q = { x: c.x + v.x * r, z: c.z + v.z * r };
      if (fits(q)) return q;
    }
  }
  return c;
}

/** 壁にかからない近くの地点(見つからなければ元の点) */
function freeSpotNear(world: World, p: Vec2): Vec2 {
  const fits = (q: Vec2): boolean => {
    const b = world.bounds;
    if (q.x < b.minX + 2 || q.x > b.maxX - 2 || q.z < b.minZ + 2 || q.z > b.maxZ - 2) return false;
    return !collidesWallIndexed(world.moveIndex, q.x, q.z, 0.5);
  };
  if (fits(p)) return p;
  for (let r = 1; r <= 12; r += 1) {
    const n = Math.max(8, r * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = { x: p.x + Math.sin(a) * r, z: p.z + Math.cos(a) * r };
      if (fits(q)) return q;
    }
  }
  return p;
}

function placeSoldier(s: Soldier, at: Vec2, face: Vec2, tick: number): void {
  s.pos = { x: at.x, z: at.z };
  s.eye = { x: at.x, z: at.z };
  s.facing = { ...face };
  s.path = [];
  s.pathIdx = 0;
  s.order = { kind: "hold", facing: { ...face }, issuedTick: tick };
}

/**
 * **陣地を占める**(`[v7.2]` S-1)。防御は準備された陣地で戦うものなので、戦闘が始まる時点で
 * 拠点を守る小隊は拠点のまわりに、機関銃の班は陣地に入っている。
 *
 * 最初は集結地から歩かせていたが、市街地の中隊戦では機関銃の班が陣地まで130mを歩く途中で
 * 攻撃側と出会い、陣地に就く前に全滅した(実測: 4戦で陣地に就いた時間 0%)。
 * 攻防戦の防御側が最初から全拠点を保有している(仕様 §12)のと同じ扱いで、
 * 陣地も最初から占めているものとする。攻撃側の配置は変えない。
 */
function occupyPositions(world: World): void {
  for (const co of world.companies) {
    if (!co.plan || !isDefender(world, co.side)) continue;
    const fwd = unit(co.advanceDir);
    const crews = new Set(
      world.defense
        .filter((p) => p.side === co.side && p.kind === "mg" && p.crew)
        .map((p) => `${p.crew!.squadId}:${p.crew!.ftIndex}`),
    );
    // `[v7.3]` 分隊の陣地(前進陣地・待ち伏せ)に就く分隊は、拠点のまわりではなく陣地へ
    const squadPosts = world.defense.filter((p) => p.side === co.side && isSquadPost(p));
    const postSquads = new Set(squadPosts.map((p) => p.crew!.squadId));
    for (const t of co.plan.tasks) {
      if (t.objectiveId === null) continue;
      const o = world.objectives.find((x) => x.id === t.objectiveId);
      if (!o) continue;
      const men = world.soldiers
        .filter(
          (s) =>
            s.side === co.side &&
            s.platoonId === t.platoonId &&
            s.status === "ok" &&
            !crews.has(`${s.squadId}:${s.fireteamId}`) &&
            !postSquads.has(s.squadId),
        )
        .sort((a, b) => a.ordinal - b.ordinal);
      // 拠点に近いところから順に詰める。拠点が建物の中なら、まず建物の中が埋まる
      // (窓に就ける)。最初は拠点の後ろに格子で並べたが、市街地では街路の開けた所に
      // 立つことになり、歩いて建物へ入っていた従来より防御側の損害が増えた
      const taken: Vec2[] = [];
      for (const s of men) {
        const at = nearestFreeSlot(world, o.pos, fwd, taken);
        taken.push(at);
        placeSoldier(s, at, fwd, world.tick);
      }
    }
    for (const p of squadPosts) {
      p.stage = "set";
      p.stageTick = world.tick;
      const men = squadMembers(world, p).filter((s) => s.status === "ok");
      const slots = squadPostSlots(world, p, men.length, fwd);
      men.forEach((s, i) => placeSoldier(s, slots[i]!.at, slots[i]!.face, world.tick));
    }
    // 機関銃の班は陣地へ
    for (const p of world.defense) {
      if (p.side !== co.side || p.kind !== "mg" || !p.crew) continue;
      const crew = world.soldiers
        .filter(
          (s) =>
            s.side === p.side &&
            s.squadId === p.crew!.squadId &&
            s.fireteamId === p.crew!.ftIndex &&
            s.status === "ok",
        )
        .sort(
          (a, b) => (a.role === "mg" ? 0 : 1) - (b.role === "mg" ? 0 : 1) || a.ordinal - b.ordinal,
        );
      crew.forEach((s, i) => {
        const at = i === 0 ? p.pos : freeSpotNear(world, crewSlots(p)[(i - 1) % 2]!);
        placeSoldier(s, at, p.facing, world.tick);
      });
    }
  }
}

/** 分隊まるごとが就く陣地か(`[v7.3]` 前進陣地・待ち伏せ) */
export function isSquadPost(p: DefensivePosition): boolean {
  return (p.kind === "forward" || p.kind === "ambush") && p.crew !== null && p.crew.ftIndex === -1;
}

/** 陣地に就く分隊の隊員(戦場に残っている者)。並びは FT → 編成上の通し番号(P2) */
function squadMembers(world: World, p: DefensivePosition): Soldier[] {
  return world.soldiers
    .filter(
      (s) =>
        s.side === p.side && s.squadId === p.crew!.squadId && s.status !== "kia" && !isOffField(s),
    )
    .sort((a, b) => a.fireteamId - b.fireteamId || a.ordinal - b.ordinal);
}

/**
 * 分隊の陣地での1人ずつの持ち場と向き(`[v7.3]`)。
 *   forward : 正面に直交して横一列(2.2m 間隔)。全員が敵の方角を向く
 *   ambush  : L字。前半の者(分隊長・第1組)は側面の組 = 接近路と平行に伏せて殺傷地帯を向く。
 *             後半の者(第2組)は正面の組 = 殺傷地帯の手前から前を向く
 */
function squadPostSlots(
  world: World,
  p: DefensivePosition,
  n: number,
  fwd: Vec2,
): Array<{ at: Vec2; face: Vec2 }> {
  const out: Array<{ at: Vec2; face: Vec2 }> = [];
  const right = { x: -fwd.z, z: fwd.x };
  if (p.kind === "forward" || !p.killZone) {
    for (let i = 0; i < n; i++) {
      const k = (i - (n - 1) / 2) * 2.2;
      out.push({
        at: freeSpotNear(world, { x: p.pos.x + right.x * k, z: p.pos.z + right.z * k }),
        face: { ...fwd },
      });
    }
    return out;
  }
  const kz = p.killZone;
  const longN = Math.ceil(n / 2);
  const toKz = dirTo(p.pos, kz);
  // 長辺: 接近路と平行に、伏せる位置から**自陣の側へ**並ぶ(敵の側へ張り出すと先に見つかる)
  for (let i = 0; i < longN; i++) {
    const k = -i * 2.5;
    out.push({
      at: freeSpotNear(world, { x: p.pos.x + fwd.x * k, z: p.pos.z + fwd.z * k }),
      face: toKz,
    });
  }
  // 短辺: 殺傷地帯の手前(拠点寄り)、側面の組と同じ側に寄せて前を向く
  const side = (p.pos.x - kz.x) * right.x + (p.pos.z - kz.z) * right.z >= 0 ? 1 : -1;
  const base = {
    x: kz.x - fwd.x * DEFENSE.AMBUSH_SHORT_BACK + right.x * side * 6,
    z: kz.z - fwd.z * DEFENSE.AMBUSH_SHORT_BACK + right.z * side * 6,
  };
  const shortN = n - longN;
  for (let i = 0; i < shortN; i++) {
    const k = (i - (shortN - 1) / 2) * 2.2;
    const at = { x: base.x + right.x * k, z: base.z + right.z * k };
    out.push({ at: freeSpotNear(world, at), face: dirTo(at, kz) });
  }
  return out;
}

/** 機関銃の班の副射手・弾薬手の位置(射手の斜め後ろ左右) */
function crewSlots(p: DefensivePosition): Vec2[] {
  const right = { x: -p.facing.z, z: p.facing.x };
  return [
    {
      x: p.pos.x - p.facing.x * 1.4 - right.x * 1.0,
      z: p.pos.z - p.facing.z * 1.4 - right.z * 1.0,
    },
    {
      x: p.pos.x - p.facing.x * 1.4 + right.x * 1.0,
      z: p.pos.z - p.facing.z * 1.4 + right.z * 1.0,
    },
  ];
}

/** 予備陣地を、その拠点を守る小隊のFTの後退先(rallyPoint)にする */
function applyAlternates(world: World): void {
  for (const co of world.companies) {
    if (!co.plan) continue;
    for (const t of co.plan.tasks) {
      if (t.objectiveId === null) continue;
      const alt = world.defense.find(
        (p) => p.side === co.side && p.kind === "alternate" && p.objectiveId === t.objectiveId,
      );
      if (!alt) continue;
      for (const sq of world.squads) {
        if (sq.side !== co.side || sq.platoonId !== t.platoonId) continue;
        sq.rallyPoint = { ...alt.pos };
        for (const ft of world.fireteams) {
          if (ft.side === sq.side && ft.squadId === sq.squadId) ft.rallyPoint = { ...alt.pos };
        }
      }
    }
  }
}

export type DefenseMoveResult =
  { ok: true } | { ok: false; reason: DefenseSpotBlock | "not_planning" | "not_your_position" };

/**
 * 立案中に陣地を置き直す(`[v7.2]`)。**防御側の中隊長の座席**だけが置き直せる(P4)。
 * 置ける場所の規則は AI の陣地選びと同じ `defenseSpotBlocker`。
 * 戻り値が ok なら、呼び出し側は `DefenseEdit` を初期条件へ記録する(P3)。
 */
export function moveDefensivePosition(
  world: World,
  id: number,
  to: Vec2,
  seat: ControlState | null = world.control,
): DefenseMoveResult {
  if (world.phase !== "planning") return { ok: false, reason: "not_planning" };
  const p = world.defense.find((x) => x.id === id);
  if (!p || !seat || seat.echelon !== "company" || seat.side !== p.side) {
    return { ok: false, reason: "not_your_position" };
  }
  const co = world.companies.find((c) => c.side === seat.side && c.companyId === seat.unitId);
  if (!co) return { ok: false, reason: "not_your_position" };
  // 初期条件コードの精度(0.01m)へ先に丸める。丸めないと、いま目の前の盤面と
  // コードから作り直した盤面が数ミリずれ、同じ戦闘にならない(P3)
  const at = { x: Math.round(to.x * 100) / 100, z: Math.round(to.z * 100) / 100 };
  const block = spotBlockerFor(world, p, at);
  if (block) return { ok: false, reason: block };
  relocate(p, at);
  refaceAfterMove(world, p, co);
  applyAlternates(world);
  if (p.kind === "wire") applyWire(world);
  // 置き直した陣地へ班を入れ直す。初期条件から立案し直したときと同じ盤面になる(P3)
  occupyPositions(world);
  return { ok: true };
}

/** その陣営の陣地の、AI案での並び順(人間の置き直しの記録に使う) */
export function defenseIndexOf(world: World, id: number): number {
  const p = world.defense.find((x) => x.id === id);
  if (!p) return -1;
  return world.defense.filter((x) => x.side === p.side).findIndex((x) => x.id === id);
}

/** 射界の内側か(`sector` を持たない兵は常に true) */
export function inSector(s: Soldier, target: Vec2): boolean {
  if (!s.sector) return true;
  const d = dirTo(s.pos, target);
  return d.x * s.sector.dir.x + d.z * s.sector.dir.z >= s.sector.cosHalf;
}

/** そのFTが就いている機関銃陣地(就いていなければ null) */
function postOf(world: World, ft: FireteamState): DefensivePosition | null {
  if (world.defense.length === 0 || world.phase !== "battle") return null;
  if (ft.mode === "ROUT" || ft.mode === "FALLBACK" || ft.mode === "CQB") return null;
  const p = world.defense.find(
    (d) =>
      d.crew !== null &&
      d.side === ft.side &&
      d.crew.squadId === ft.squadId &&
      ((d.kind === "mg" && d.crew.ftIndex === ft.ftIndex) ||
        // `[v7.3]` 分隊の陣地は役目を終えるまで(released)分隊まるごとが就く
        (isSquadPost(d) && d.stage !== "released")),
  );
  if (!p) return null;
  if (aiSuppressed(world, "squad", ft.side, ft.squadId)) return null;
  return p;
}

/**
 * そのFTはいま機関銃陣地に就いているか。`fireteamAI` はモードを決めたあとここを見て、
 * true ならそのFTの命令を出さない(陣地の側が出す)。
 */
export function mannesDefensivePost(world: World, ft: FireteamState): boolean {
  return postOf(world, ft) !== null;
}

/**
 * 毎ティック: 機関銃の班を陣地に就かせる。`fireteamAI` の**あと**に呼ぶ
 * (同じティックのFTの命令を、陣地に就いている班についてだけ上書きする)。
 *
 * 陣地を離れるのは、班が後退・潰走・突入しているとき、または人間・LLM がその分隊・
 * FTを操作しているとき。後退した班は予備陣地(rallyPoint)へ下がる。
 */
export function defenseSystem(world: World): void {
  if (world.defense.length === 0) return;
  for (const s of world.soldiers) if (s.sector) s.sector = null;
  if (world.phase !== "battle") return;
  const decide = world.tick % DECIDE_EVERY_TICKS === 0;

  // `[v7.3]` 分隊の陣地(前進陣地・待ち伏せ)は分隊単位で動かす
  for (const p of world.defense) {
    if (isSquadPost(p) && p.stage !== "released") runSquadPost(world, p, decide);
  }

  for (const ft of world.fireteams) {
    const p = postOf(world, ft);
    if (!p || isSquadPost(p)) continue;
    const crew = world.soldiers.filter(
      (s) =>
        s.side === ft.side &&
        s.squadId === ft.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.status === "ok" &&
        !isOffField(s),
    );
    if (crew.length === 0) continue;
    if (crew.some((s) => aiSuppressed(world, "fireteam", s.side, s.id))) continue;
    // 射手が倒れたら副射手が銃に就く(班の先頭 = 機関銃を持つ者を優先)
    const gunner = crew.find((s) => s.role === "mg") ?? crew[0]!;
    const slots = crewSlots(p);
    const atPost = dist(gunner.pos, p.pos) <= DEFENSE.POST_ARRIVE;
    if (atPost) gunner.sector = { dir: { ...p.facing }, cosHalf: COS_SECTOR };
    if (!decide) continue;

    if (!atPost) {
      issue(world, gunner, "move", p.pos, p.facing);
    } else {
      // 射界の中に見えている敵がいれば撃つ(制圧役)。いなければ FPL に据えて待つ
      const target = gunner.sees
        .map((id) => world.soldierById.get(id))
        .find((t) => t && t.status === "ok" && inSector(gunner, t.pos));
      if (target) issue(world, gunner, "suppress", null, dirTo(gunner.pos, target.pos));
      else issue(world, gunner, "hold", null, p.facing);
    }
    crew
      .filter((s) => s.id !== gunner.id)
      .forEach((s, i) => {
        const slot = slots[i % slots.length]!;
        if (dist(s.pos, slot) > DEFENSE.POST_ARRIVE) issue(world, s, "move", slot, p.facing);
        else issue(world, s, "hold", null, p.facing);
      });
  }
}

const AMBUSH_FIGHT_TICKS = Math.round(DEFENSE.AMBUSH_FIGHT_SEC * SIM_HZ);
const WITHDRAW_MAX_TICKS = Math.round(DEFENSE.WITHDRAW_MAX_SEC * SIM_HZ);

function setStage(
  world: World,
  p: DefensivePosition,
  stage: NonNullable<DefensivePosition["stage"]>,
): void {
  p.stage = stage;
  p.stageTick = world.tick;
}

/**
 * 分隊の陣地を1ティックぶん進める(`[v7.3]` ロードマップ A-4)。
 *
 * **判断の材料は隊員が自分の目で見ているもの(`sees`)と、撃たれた・倒れたという
 * 自分の身に起きたことだけ**(P1)。分隊長は麾下の視界を直接持つ階層なので(仕様 §5)、
 * これは分隊長の判断として正当。攻撃側の位置を世界から直接読むことはしない。
 *
 *   待ち伏せ: 殺傷地帯に敵が入る / 自衛の距離まで寄られる / 撃たれる・倒れる → 撃ち始める。
 *             撃ち始めたら `AMBUSH_FIGHT_SEC` だけ陣地で戦い、通常の指揮へ戻る
 *   前進陣地: 撃ち合いながら待つ。寄られる / 多数を見る / 倒れる → 拠点へ下がる。
 *             着いたら(または時間切れで)通常の指揮へ戻る
 */
function runSquadPost(world: World, p: DefensivePosition, decide: boolean): void {
  const all = squadMembers(world, p);
  const men = all.filter((s) => s.status === "ok");
  if (men.length === 0) {
    setStage(world, p, "released");
    return;
  }
  // 人間・LLM がこの分隊(やその中のFT・兵)に座っている間は陣地の側は何もしない
  if (aiSuppressed(world, "squad", p.side, p.crew!.squadId)) return;
  if (men.some((s) => aiSuppressed(world, "fireteam", s.side, s.id))) return;

  const o = world.objectives.find((x) => x.id === p.objectiveId) ?? null;
  const hurt = all.some((s) => s.status === "wia");
  const shotAt = men.some((s) => s.alertUntilTick > world.tick && s.alertFrom !== null);
  const seen: Soldier[] = [];
  for (const s of men) {
    for (const id of s.sees) {
      const t = world.soldierById.get(id);
      if (t && t.status === "ok" && !seen.includes(t)) seen.push(t);
    }
  }
  const nearest = (t: Soldier): number => Math.min(...men.map((s) => dist(s.pos, t.pos)));
  const stage = p.stage ?? "set";

  if (p.kind === "ambush") {
    if (stage === "set") {
      const inZone =
        p.killZone !== undefined &&
        seen.some((t) => dist(t.pos, p.killZone!) <= DEFENSE.AMBUSH_KZ_RADIUS);
      const tooClose = seen.some((t) => nearest(t) <= DEFENSE.AMBUSH_SELF_DEFENSE);
      if (inZone || tooClose || shotAt || hurt) {
        setStage(world, p, "sprung");
      } else {
        // 撃たずに待つ。射撃系(combat.ts)は holdFireUntilTick を見て引き金を引かない
        for (const s of men) s.holdFireUntilTick = Math.max(s.holdFireUntilTick, world.tick + 2);
      }
    } else if (stage === "sprung" && world.tick - (p.stageTick ?? 0) >= AMBUSH_FIGHT_TICKS) {
      setStage(world, p, "released");
      return;
    }
  } else if (stage === "set") {
    const pressed =
      seen.some((t) => nearest(t) <= DEFENSE.FORWARD_WITHDRAW_RANGE) ||
      seen.length >= DEFENSE.FORWARD_WITHDRAW_SEEN ||
      hurt;
    if (pressed) setStage(world, p, "withdraw");
  } else if (stage === "withdraw") {
    let cx = 0;
    let cz = 0;
    for (const s of men) {
      cx += s.pos.x;
      cz += s.pos.z;
    }
    const c = { x: cx / men.length, z: cz / men.length };
    const home = o?.pos ?? p.pos;
    if (
      dist(c, home) <= DEFENSE.WITHDRAW_ARRIVE ||
      world.tick - (p.stageTick ?? 0) >= WITHDRAW_MAX_TICKS
    ) {
      setStage(world, p, "released");
      return;
    }
  }
  if (!decide) return;

  const fwd = { ...p.facing };
  if (p.stage === "withdraw" && o) {
    // 拠点(第2線)へ下がる。下がりながらも見えている敵の方を向く(撃てる相手は撃つ)
    const back = { x: -fwd.x, z: -fwd.z };
    men.forEach((s, i) => {
      const k = (i - (men.length - 1) / 2) * 2;
      const right = { x: -fwd.z, z: fwd.x };
      const dest = { x: o.pos.x + right.x * k + back.x * 2, z: o.pos.z + right.z * k + back.z * 2 };
      const t = s.sees.map((id) => world.soldierById.get(id)).find((x) => x && x.status === "ok");
      issue(world, s, "retreat", dest, t ? dirTo(s.pos, t.pos) : fwd);
    });
    return;
  }
  const co = world.companies.find((c) => c.side === p.side);
  const slots = squadPostSlots(world, p, men.length, unit(co?.advanceDir ?? fwd));
  men.forEach((s, i) => {
    const slot = slots[i]!;
    if (dist(s.pos, slot.at) > DEFENSE.POST_ARRIVE * 1.5)
      issue(world, s, "move", slot.at, slot.face);
    else issue(world, s, "hold", null, slot.face);
  });
}

/** その地点が射撃壕の上か(就いていれば窓と同じ補正、§8)。陣営は問わない(物理的な遮蔽) */
export function atFightingPosition(world: World, p: Vec2, radius: number): boolean {
  for (const d of world.defense) {
    if (d.kind !== "fighting") continue;
    if ((d.pos.x - p.x) ** 2 + (d.pos.z - p.z) ** 2 <= radius * radius) return true;
  }
  return false;
}
