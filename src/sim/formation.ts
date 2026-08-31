/**
 * 隊形の自動選択と追従位置の計算(仕様 §6「隊形(Formation)」、§6.5「集合・追従命令」)。
 *
 * `formation-autoselect-prototype.jsx` で検証済みの方式をそのまま移植する。要点:
 *
 *   - 当初想定していた 縦隊/くさび形/横隊/梯形 の4分類のうち**梯形は廃止**された。
 *     「隊員は斜めになる必要はなく、身を守りながら隊列と視界を維持できればよい」ため
 *   - 代わりに**通路幅に応じたTier1〜4の4段階判定**を使う
 *   - **各Tierのオフセットは前後方向または左右方向いずれか片軸のみ**(斜め配置なし)
 *   - 隊員の目標位置が通路境界から安全マージン(0.45m)を割り込む場合はクランプする
 *
 * プロトタイプは通路を x 範囲ごとの半幅テーブルで持っていたが、統合シムの世界は
 * AABBの集合なので、進行方向に直交するレイを左右へ飛ばして局所的な通路幅を測る。
 * 開豁地では両側とも当たらないので幅が最大になり、自然に横隊(Tier4)が選ばれる。
 */

import { castRay, collidesWall, hasLineOfSight } from "./geometry.ts";
import { forEachCoverNear, type CoverIndex } from "./cover.ts";
import { SOLDIER_RADIUS, WALL_SAFETY_CLAMP } from "./constants.ts";
import type { AABB, Contact, Vec2 } from "./types.ts";

/** 隊形の段階。Tier1が最も密集した縦隊、Tier4が横隊。 */
export type FormationTier = 1 | 2 | 3 | 4;

/**
 * 隊形オフセット。`along` が進行方向(正=前方)、`lateral` が右方向。
 * **片方は必ず0**であること — 斜め配置を採らないという仕様 §6 の決定を型ではなく
 * データで守っている。
 */
export interface FormationOffset {
  along: number;
  lateral: number;
}

/** 通路幅のしきい値 m(仕様 §6 の表)。この幅未満なら当該Tierを採用する。 */
export const TIER_THRESHOLDS = [2.2, 4.0, 6.5] as const;

/** 各Tierの隊形オフセット(仕様 §6 の表)。先頭がリーダー。 */
export const TIER_OFFSETS: Record<FormationTier, FormationOffset[]> = {
  // Tier1: 密集縦隊(幅<2.2m)— 前後方向のみ、間隔1.0m
  1: [
    { along: 0, lateral: 0 },
    { along: -1.0, lateral: 0 },
    { along: -2.0, lateral: 0 },
    { along: -3.0, lateral: 0 },
  ],
  // Tier2: 縦隊(幅2.2〜4.0m)— 前後方向のみ、間隔1.6m
  2: [
    { along: 0, lateral: 0 },
    { along: -1.6, lateral: 0 },
    { along: -3.2, lateral: 0 },
    { along: -4.8, lateral: 0 },
  ],
  // Tier3: 分散隊形・側面確保(幅4.0〜6.5m)— 前1名 + 左右各1名
  3: [
    { along: 0, lateral: 0 },
    { along: 0, lateral: -1.3 },
    { along: -1.6, lateral: 0 },
    { along: 0, lateral: 1.3 },
  ],
  // Tier4: 横隊(幅6.5m以上)— 左右方向のみ、間隔1.8m
  4: [
    { along: 0, lateral: 0 },
    { along: 0, lateral: -1.8 },
    { along: 0, lateral: 1.8 },
    { along: 0, lateral: 3.6 },
  ],
};

/**
 * 隊形ごとの移動速度倍率。
 *
 * 仕様 §6 は序列だけを定めている:「縦隊(Tier1/2)が最速、Tier3が標準、
 * 横隊(Tier4)が最遅」。具体値は `[v6]` で置いた暫定値で、バランス調整の対象。
 */
export const TIER_SPEED_MUL: Record<FormationTier, number> = {
  1: 1.1,
  2: 1.1,
  3: 1.0,
  4: 0.9,
};

/** 通路幅を測るときのレイの最大長 m。これ以上は「開豁地」として扱う。 */
const WIDTH_PROBE_MAX = 12;

// ── 遮蔽物優先ロジックのパラメータ(仕様 §6.5 の表)──
/** 隊形位置からこの範囲内でのみ遮蔽物候補を探す m */
export const COVER_SEARCH_RADIUS = 2.5;
/** 隊形位置の被発見リスクがこれを超えた場合のみ遮蔽物探索を発動 */
export const EXPOSURE_THRESHOLD = 0.15;
/** 候補が現在地よりこのマージン以上安全な場合のみ採用(振動防止) */
export const IMPROVE_MARGIN = 0.1;

/**
 * `at` における進行方向に直交する局所的な通路幅 m。
 * 左右へレイを飛ばして両側の壁までの距離を足す。開豁地では上限に張り付く。
 */
export function corridorWidth(walls: readonly AABB[], at: Vec2, dir: Vec2): number {
  const right = { x: -dir.z, z: dir.x };
  const r = castRay(walls, at.x, at.z, right.x, right.z, WIDTH_PROBE_MAX);
  const l = castRay(walls, at.x, at.z, -right.x, -right.z, WIDTH_PROBE_MAX);
  return r + l;
}

/** 通路幅から隊形Tierを決める(仕様 §6 の4段階判定)。 */
export function decideTier(width: number): FormationTier {
  if (width < TIER_THRESHOLDS[0]) return 1;
  if (width < TIER_THRESHOLDS[1]) return 2;
  if (width < TIER_THRESHOLDS[2]) return 3;
  return 4;
}

/**
 * 壁面安全クランプ(仕様 §6 `[v5]`)。
 *
 * 隊形位置が壁のマージン内に食い込む場合、リーダー側へ引き戻して通行可能な点にする。
 * プロトタイプは通路の半幅テーブルで z をクランプしていたが、任意のAABB配置では
 * 「リーダーへ向かって後退させる」ほうが一般に安全側へ倒れる。
 */
export function clampToWalkable(walls: readonly AABB[], desired: Vec2, anchor: Vec2): Vec2 {
  if (!collidesWall(walls, desired.x, desired.z, WALL_SAFETY_CLAMP)) return desired;
  const dx = anchor.x - desired.x;
  const dz = anchor.z - desired.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return { ...anchor };
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = { x: desired.x + dx * t, z: desired.z + dz * t };
    if (!collidesWall(walls, p.x, p.z, SOLDIER_RADIUS)) return p;
  }
  return { ...anchor };
}

/**
 * ある地点の被発見リスク 0..1(仕様 §6.5「既知の索敵情報に基づき、各遮蔽物候補地点の
 * 被発見リスクを評価する」)。
 *
 * **既知の接触情報だけを使う**点が重要 — 実際の敵位置を覗いてしまうと、
 * 隊形の取り方が情報階層(仕様 §5)を迂回する裏口になる。
 */
export function exposureAt(
  walls: readonly AABB[],
  contacts: Iterable<Contact>,
  p: Vec2,
): number {
  let total = 0;
  let exposed = 0;
  for (const c of contacts) {
    if (c.confidence <= 0) continue;
    total += c.confidence;
    if (hasLineOfSight(walls, c.pos.x, c.pos.z, p.x, p.z)) exposed += c.confidence;
  }
  return total > 0 ? exposed / total : 0;
}

/**
 * 遮蔽物優先ロジック(仕様 §6.5)。隊形位置の露出が高いときだけ、近傍の遮蔽点へ寄せる。
 * 改善マージンを設けているのは、わずかな差で毎ティック行き先が入れ替わるのを防ぐため。
 */
export function preferCover(
  walls: readonly AABB[],
  cover: CoverIndex,
  contacts: Iterable<Contact>,
  desired: Vec2,
  /** 露出回避度(`[v6.1]` 陣営別 coverPref。1 = 現行、>1 でより早く遮蔽へ寄る) */
  coverPref = 1,
): Vec2 {
  const cs = [...contacts];
  const base = exposureAt(walls, cs, desired);
  if (base <= EXPOSURE_THRESHOLD / coverPref) return desired;

  let best: Vec2 | null = null;
  let bestExp = base;
  // `[v6.3]` 半径 COVER_SEARCH_RADIUS の外は見ない(索引経由)。
  forEachCoverNear(cover, desired, COVER_SEARCH_RADIUS, (p) => {
    const d = Math.hypot(p.x - desired.x, p.z - desired.z);
    if (d > COVER_SEARCH_RADIUS) return;
    const e = exposureAt(walls, cs, p);
    if (e < bestExp) {
      bestExp = e;
      best = p;
    }
  });
  return best && base - bestExp >= IMPROVE_MARGIN ? best : desired;
}

export interface FormationSlot {
  pos: Vec2;
  tier: FormationTier;
  speedMul: number;
}

/**
 * リーダーの位置と向きを基準に、隊員 `count` 名分の追従位置を計算する(仕様 §6.5)。
 *
 * 仕様どおり「リーダーの現在の向きを基準に、選択中の隊形Tierのオフセットを毎フレーム
 * 再計算し、追従目標位置とする」。固定座標への一括移動ではなく継続的な相対追従。
 *
 * `contacts` と `coverPoints` を渡すと遮蔽物優先ロジック(仕様 §6.5)が働く。
 */
export function formationSlots(
  walls: readonly AABB[],
  leader: Vec2,
  dir: Vec2,
  count: number,
  opts?: {
    contacts?: Iterable<Contact>;
    coverPoints?: CoverIndex;
    /** 露出回避度(`[v6.1]` 陣営別 coverPref)。既定 1 で現行挙動 */
    coverPref?: number;
  },
): FormationSlot[] {
  const tier = decideTier(corridorWidth(walls, leader, dir));
  const offsets = TIER_OFFSETS[tier];
  const speedMul = TIER_SPEED_MUL[tier];
  const right = { x: -dir.z, z: dir.x };

  const slots: FormationSlot[] = [];
  for (let i = 0; i < count; i++) {
    // 隊員が4名を超える場合はオフセットを巡回させ、周回ごとに後方へずらす
    const off = offsets[i % offsets.length]!;
    const lap = Math.floor(i / offsets.length);
    const along = off.along - lap * 2.2;
    let p: Vec2 = {
      x: leader.x + dir.x * along + right.x * off.lateral,
      z: leader.z + dir.z * along + right.z * off.lateral,
    };
    p = clampToWalkable(walls, p, leader);
    if (opts?.contacts && opts.coverPoints) {
      const preferred = preferCover(
        walls,
        opts.coverPoints,
        opts.contacts,
        p,
        opts.coverPref ?? 1,
      );
      p = clampToWalkable(walls, preferred, leader);
    }
    slots.push({ pos: p, tier, speedMul });
  }
  return slots;
}
