import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// ==== 地形(戦場) ====================================================
// マップ全体のスケール係数(3ファイヤーチーム編成・12v12用に2.5倍へ拡大)
// 壁レイアウトの「形」は原寸のまま維持し、座標だけ一律スケールする
const MAP_SCALE = 2.5;
// 1象限分だけ定義し、x軸・z軸に4象限ミラーして広い戦場を生成する(原寸で記述)
const BASE_WALLS_RAW = [
  { cx: 16, cz: 11, hw: 3.2, hd: 0.3 },
  { cx: 16, cz: 5.5, hw: 1.4, hd: 0.3 },
  { cx: 19.5, cz: 8.2, hw: 0.3, hd: 3.1 },
  { cx: 12.5, cz: 9.5, hw: 0.3, hd: 1.6 },
  { cx: 9, cz: 4, hw: 0.6, hd: 0.6 },
  { cx: 10.5, cz: 6.5, hw: 0.5, hd: 0.5 },
  { cx: 7, cz: 7.5, hw: 0.5, hd: 0.5 },
  { cx: 22, cz: 4, hw: 3.4, hd: 0.3 },
  { cx: 27, cz: 4, hw: 1.0, hd: 0.3 },
  { cx: 26, cz: 11, hw: 0.7, hd: 0.7 },
  { cx: 23.5, cz: 13, hw: 0.5, hd: 0.9 },
  { cx: 5.5, cz: 12, hw: 1.8, hd: 0.3 },
  { cx: 14, cz: 1.5, hw: 1.0, hd: 1.0 },
  { cx: 20, cz: 8, hw: 0.3, hd: 2.2 },
  // --- ここから追加(マップをより複雑に:遠方エリアの建物・シケイン・散在障害物) ---
  { cx: 11, cz: 14, hw: 1.4, hd: 0.3 },   // 中距離の低い壁(小屋)
  { cx: 13.6, cz: 16, hw: 0.3, hd: 1.6 }, // ↑と直交して小部屋を形成
  { cx: 17, cz: 15.5, hw: 0.5, hd: 0.5 }, // クレート
  { cx: 20.5, cz: 19, hw: 2.2, hd: 0.3 }, // 遠方の掩体
  { cx: 24.5, cz: 17, hw: 0.5, hd: 2.6 }, // 側面の長い壁
  { cx: 4, cz: 16.5, hw: 0.5, hd: 0.5 },  // クレート
  { cx: 1.5, cz: 19, hw: 0.5, hd: 0.5 },  // クレート
  { cx: 6, cz: 2, hw: 0.4, hd: 2.4 },     // スポーン付近の遮蔽(シケイン開始)
  { cx: 3.5, cz: 5, hw: 1.6, hd: 0.3 },   // シケインの折り返し
  { cx: 25, cz: 8.5, hw: 0.3, hd: 1.3 },  // 側面フランク用の掩体
  { cx: 28, cz: 15.5, hw: 0.5, hd: 0.5 }, // 遠い角のクレート
  { cx: 9.5, cz: 18.5, hw: 0.4, hd: 0.4 },// クレート
  { cx: 18, cz: 12, hw: 0.4, hd: 0.4 },   // 中央寄りの小障害物
  { cx: 2.5, cz: 10, hw: 0.4, hd: 0.4 },  // クレート
  { cx: 22, cz: 21, hw: 1.6, hd: 0.3 },   // 最遠方の低い壁
];
const BASE_WALLS = BASE_WALLS_RAW.map((w) => ({ cx: w.cx * MAP_SCALE, cz: w.cz * MAP_SCALE, hw: w.hw * MAP_SCALE, hd: w.hd * MAP_SCALE }));
function mirrorWalls(base) {
  const out = [];
  base.forEach((w) => {
    out.push({ cx: w.cx, cz: w.cz, hw: w.hw, hd: w.hd });
    out.push({ cx: -w.cx, cz: w.cz, hw: w.hw, hd: w.hd });
    out.push({ cx: w.cx, cz: -w.cz, hw: w.hw, hd: w.hd });
    out.push({ cx: -w.cx, cz: -w.cz, hw: w.hw, hd: w.hd });
  });
  return out;
}
const CENTRAL_COMPOUND_RAW = [
  { cx: 0, cz: 2.6, hw: 2.2, hd: 0.3 },
  { cx: 0, cz: -2.6, hw: 2.2, hd: 0.3 },
  { cx: 2.6, cz: 1.3, hw: 0.3, hd: 1.3 },
  { cx: -2.6, cz: -1.3, hw: 0.3, hd: 1.3 },
  // 中央施設の外側に独立したクレートを追加して複雑化(通路を塞がないよう、
  // 既存のピンホイール壁とは接続させず離して配置する)
  { cx: 6.5, cz: 6.5, hw: 0.5, hd: 0.5 },
  { cx: -6.5, cz: -6.5, hw: 0.5, hd: 0.5 },
  { cx: 6.5, cz: -6.5, hw: 0.5, hd: 0.5 },
  { cx: -6.5, cz: 6.5, hw: 0.5, hd: 0.5 },
];
const CENTRAL_COMPOUND = CENTRAL_COMPOUND_RAW.map((w) => ({ cx: w.cx * MAP_SCALE, cz: w.cz * MAP_SCALE, hw: w.hw * MAP_SCALE, hd: w.hd * MAP_SCALE }));
const WALLS = [...mirrorWalls(BASE_WALLS), ...CENTRAL_COMPOUND];

// ==== 幾何ユーティリティ ==============================================
function rayAABB(ox, oz, dx, dz, wall, maxDist) {
  const minX = wall.cx - wall.hw, maxX = wall.cx + wall.hw;
  const minZ = wall.cz - wall.hd, maxZ = wall.cz + wall.hd;
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return null; }
  else { let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return null; }
  else { let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (tmax < tmin || tmax < 0) return null;
  const hit = tmin > 0.001 ? tmin : tmax;
  if (hit < 0 || hit > maxDist) return null;
  return hit;
}
function castRay(ox, oz, dx, dz, maxDist) {
  let best = maxDist;
  for (const w of WALLS) { const t = rayAABB(ox, oz, dx, dz, w, best); if (t !== null && t < best) best = t; }
  return best;
}
function hasLineOfSight(ox, oz, ex, ez) {
  const dx0 = ex - ox, dz0 = ez - oz;
  const dist = Math.hypot(dx0, dz0);
  if (dist < 1e-6) return true;
  const dx = dx0 / dist, dz = dz0 / dist;
  const hit = castRay(ox, oz, dx, dz, dist - 0.05);
  return hit >= dist - 0.06;
}
function collidesWall(x, z, r = 0.35) {
  return WALLS.some((w) => x > w.cx - w.hw - r && x < w.cx + w.hw + r && z > w.cz - w.hd - r && z < w.cz + w.hd + r);
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }
function dirTo(u, pos) {
  const dx = pos.x - u.x, dz = pos.z - u.z;
  const d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}
function centroid(arr) {
  if (!arr.length) return { x: 0, z: 0 };
  let x = 0, z = 0;
  arr.forEach((u) => { x += u.x; z += u.z; });
  return { x: x / arr.length, z: z / arr.length };
}
function rotateDir(dir, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { x: dir.x * c + dir.z * s, z: dir.z * c - dir.x * s };
}
function angleOf(dir) { return Math.atan2(dir.x, dir.z); }
function turnToward(current, target, maxDelta) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

// ==== 戦闘パラメータ(視界・センサー系は共通) =============================
// 両陣営共通のパラメータ。UIから調整できるよう const ではなく let にしている
// (このファイル内の他の関数はすべて同じモジュールスコープの変数を直接参照するため、
// ここを書き換えるだけで次のフレームから即座にシミュレーションへ反映される)
let FOV_HALF_RAD = (50 * Math.PI) / 180; // 索敵は正面100°の扇形(共通)
let FIRE_ALIGN_RAD = (9 * Math.PI) / 180; // 実射には正面±9°への正対が必要(共通・視界中心=射線)
let DETECT_RANGE = 20;         // 共通
let MOVE_SPEED = 2.6;          // 共通
let TURN_RATE = Math.PI * 1.3; // 共通(旋回速度)
let CONFIDENCE_DECAY = 0.12;   // 共通(添付元仕様に準拠、秒あたりの確度減衰)
const CONFIDENCE_CUTOFF = 0.02;  // 共通
// マップ境界は2.5倍に拡大(3ファイヤーチーム×2チーム=24名がゆったり展開できるように)
const BOUNDS = { minX: -29 * MAP_SCALE, maxX: 29 * MAP_SCALE, minZ: -23 * MAP_SCALE, maxZ: 23 * MAP_SCALE };
// 勝利条件: マップ中心の円状エリアを、一定時間(captureDuration秒)
// 「敵の侵入を許さず占拠し続けた」陣営の勝利とする。半径・時間はUIから調整可能(共通letと同様)。
const ZONE_CENTER = { x: 0, z: 0 };
let ZONE_RADIUS = 10 * MAP_SCALE;
let ZONE_CAPTURE_DURATION = 20; // 秒

// 1チーム=分隊(12名)を構成する「ファイヤーチーム(FT)」の数と、
// 各FTの分隊内での左右スポーン間隔(前進方向に対して横並びに展開)
const SQUAD_COUNT = 3;
const SQUAD_OFFSET_X = [-18, 0, 18];

// チームごとの「性格」パラメータ(視界要件は含まない・行動方針のみ)
// ※ engageMin/engageMax・移動速度・視界などの「実弾兵器のスペック」に相当する値は
//   マップサイズが変わっても現実の距離感を保つため、意図的にスケールしていない
const TEAM_DEFS = {
  A: {
    color: 0x60a5fa, spawn: { x: 0, z: -19 * MAP_SCALE }, advanceDir: { x: 0, z: 1 }, name: "チームA",
    style: "堅実型(慎重)",
    expWeight: 0.65,        // 経路の遮蔽重視度(高いほど露出ルートを避ける)
    engageMin: 10, engageMax: 17, // 交戦時に維持する距離帯(遠め)
    boundMinAdv: 3, boundMaxAdv: 6, // バウンディング前進1回あたりの歩幅(相互支援を保てる範囲に短縮)
    fallbackDeficit: 0,     // 何人差で劣勢と判断し撤退するか(小さいほど臆病)
    underFireDuration: 3.2, // 被弾時の警戒継続時間(長いほど慎重に伏せる)
  },
  B: {
    color: 0xf87171, spawn: { x: 0, z: 19 * MAP_SCALE }, advanceDir: { x: 0, z: -1 }, name: "チームB",
    style: "積極型(攻撃的)",
    expWeight: 0.3,
    engageMin: 7, engageMax: 12,   // 距離を詰めがち
    boundMinAdv: 4, boundMaxAdv: 9, // 大胆め、ただし相互支援が維持できる範囲に制限
    fallbackDeficit: 2,     // 多少の劣勢では退かない
    underFireDuration: 1.5, // 被弾してもすぐ切り替える
  },
};
// 1ファイヤーチーム(4名=リーダー1+隊員3)内の隊形オフセット。
// さらに内部でi<2/2以上の2名ずつバディペア(alpha/bravo)に分かれ、バウンディングオーバーウォッチを行う
const MEMBER_OFFSETS = [
  { f: 0, r: 0 },
  { f: -1.6, r: -1.9 },
  { f: -1.6, r: 1.9 },
  { f: -3.2, r: 0 },
];
const MODE_LABEL = { ADVANCE: "警戒前進(バウンディング)", CONTACT: "交戦(制圧・機動)", SEARCH: "捜索(接敵ロスト後の追跡)", FALLBACK: "後退(離脱)" };
const FT_LABEL = ["FT1", "FT2", "FT3"];


// ==== 遮蔽点(カバーポイント)生成と評価 ==================================
const COVER_POINTS = (() => {
  const pts = [];
  const step = 1.4 * MAP_SCALE; // マップ拡大に合わせてステップも拡大し、点密度(≒計算量)を原寸と同等に保つ
  for (let x = BOUNDS.minX + 1; x <= BOUNDS.maxX - 1; x += step) {
    for (let z = BOUNDS.minZ + 1; z <= BOUNDS.maxZ - 1; z += step) {
      if (!collidesWall(x, z, 0.4)) pts.push({ x, z });
    }
  }
  return pts;
})();
function nearestWallDist(x, z) {
  let best = Infinity;
  for (const w of WALLS) {
    const cx = clamp(x, w.cx - w.hw, w.cx + w.hw);
    const cz = clamp(z, w.cz - w.hd, w.cz + w.hd);
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) best = d;
  }
  return best;
}
function coverBonus(x, z) { return clamp(2.4 - nearestWallDist(x, z), 0, 2.4); }

// オーバーウォッチ側から視認できる範囲内で、躍進先を決定する。
// 通常の歩幅で見つからない場合は段階的に探索範囲を広げていき、
// それでも支援可能な地点が無ければ「その場で待機」を返す(壁を無視した無理な前進はしない)。
function pickSupportedBoundTarget(fromX, fromZ, dirx, dirz, minAdv, maxAdv, support) {
  const ranges = [
    [minAdv, maxAdv],
    [minAdv, maxAdv * 1.6],
    [minAdv * 0.5, maxAdv * 2.4],
  ];
  for (const [mn, mx] of ranges) {
    const p = nearestCoverTowards(fromX, fromZ, dirx, dirz, mn, mx, support);
    if (p) return p;
  }
  // 地形上どうしても相互支援(オーバーウォッチ側からの視線)を満たす候補が無い場合、
  // その場に完全停止させ続けるのではなく、支援条件だけを外して前進を優先する。
  // (壁を無視した直線移動ではなく、引き続きCOVER_POINTSベースの壁考慮済みの地点を使う)
  const relaxed = nearestCoverTowards(fromX, fromZ, dirx, dirz, minAdv, maxAdv * 2.4);
  if (relaxed) return relaxed;
  return { x: fromX, z: fromZ };
}

function nearestCoverTowards(fromX, fromZ, dirx, dirz, minAdv, maxAdv, support) {
  // support(オーバーウォッチ側の位置)が渡された場合、そこから視認できない地点は候補から除外する。
  // ドクトリン上、躍進する二人組はもう一方の二人組の相互支援(視認・射撃支援)範囲を
  // 外れてはならないため。「見えないなら諦めてそこへ行く」フォールバックは行わない
  // (壁越しの到達不能・不整合な地点へ向かってしまう原因になるため、呼び出し側で
  // 探索範囲を広げる/待機するなどの代替判断をさせる)。
  let best = null, bestScore = -Infinity;
  for (const p of COVER_POINTS) {
    const dx = p.x - fromX, dz = p.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < minAdv - 1 || d > maxAdv + 3) continue;
    const dot = (dx * dirx + dz * dirz) / (d || 1);
    if (dot < 0.25) continue;
    if (support && !hasLineOfSight(support.x, support.z, p.x, p.z)) continue;
    const score = dot * 1.5 + coverBonus(p.x, p.z) * 1.2 - d * 0.08;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}
function bestCoverPoint(fromX, fromZ, enemyPos, rangeMin, rangeMax) {
  let best = null, bestScore = -Infinity;
  for (const p of COVER_POINTS) {
    const distFrom = Math.hypot(p.x - fromX, p.z - fromZ);
    if (distFrom > 18) continue;
    const dE = Math.hypot(p.x - enemyPos.x, p.z - enemyPos.z);
    const los = hasLineOfSight(p.x, p.z, enemyPos.x, enemyPos.z);
    const rangeDev = Math.max(0, rangeMin - dE, dE - rangeMax);
    const score = (los ? 4 : 0) - rangeDev * 0.7 - distFrom * 0.14 + coverBonus(p.x, p.z) * 1.3;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}
function bestFlankPoint(fromX, fromZ, enemyPos, baseCentroid, rangeMin, rangeMax) {
  const baseAngle = Math.atan2(enemyPos.x - baseCentroid.x, enemyPos.z - baseCentroid.z);
  let best = null, bestScore = -Infinity;
  for (const p of COVER_POINTS) {
    const distFrom = Math.hypot(p.x - fromX, p.z - fromZ);
    if (distFrom > 20) continue;
    const dE = Math.hypot(p.x - enemyPos.x, p.z - enemyPos.z);
    if (!hasLineOfSight(p.x, p.z, enemyPos.x, enemyPos.z)) continue;
    const angle = Math.atan2(enemyPos.x - p.x, enemyPos.z - p.z);
    let diff = Math.abs(angle - baseAngle); if (diff > Math.PI) diff = 2 * Math.PI - diff;
    const rangeDev = Math.max(0, rangeMin - dE, dE - rangeMax);
    const score = diff * 1.6 - rangeDev * 0.7 - distFrom * 0.12 + coverBonus(p.x, p.z) * 1.1;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}
function nearestBreakContactPoint(fromX, fromZ, threatPos, towardX, towardZ) {
  let best = null, bestScore = -Infinity;
  const hasToward = towardX !== undefined;
  const towardDx = hasToward ? towardX - fromX : 0;
  const towardDz = hasToward ? towardZ - fromZ : 0;
  const towardLen = Math.hypot(towardDx, towardDz) || 1;
  for (const p of COVER_POINTS) {
    const distFrom = Math.hypot(p.x - fromX, p.z - fromZ);
    if (distFrom > 9) continue;
    const blocked = !hasLineOfSight(p.x, p.z, threatPos.x, threatPos.z);
    let score = (blocked ? 5 : 0) + coverBonus(p.x, p.z) * 1.2 - distFrom * 0.22;
    if (hasToward) {
      // 安全確保を優先しつつ、本来向かうべき方向(命令の目的地)に近い候補を軽く優遇する。
      // これが無いと、持続的に撃たれ続けた際に近場の遮蔽を行ったり来たりするだけで
      // 本来の後退先へ一向に進まなくなることがあるため。
      const dot = ((p.x - fromX) * towardDx + (p.z - fromZ) * towardDz) / ((distFrom || 1) * towardLen);
      score += dot * 2.2;
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}
function offsetPerp(i, total, spread, forwardDir) {
  if (total <= 1) return { x: 0, z: 0 };
  const arr = total === 2 ? [-spread / 2, spread / 2] : [-spread, 0, spread];
  const v = arr[i] || 0;
  // forwardDirが渡された場合、その進行方向に対して垂直な向きへオフセットする。
  // (渡されない場合は従来通りワールドX軸オフセットとして扱う=下位互換)
  if (forwardDir) {
    const perp = rotateDir(forwardDir, Math.PI / 2);
    return { x: perp.x * v, z: perp.z * v };
  }
  return { x: v, z: 0 };
}

// ==== 索敵レポート(視認+推定確度減衰)・被発見リスク評価 ===================
// 添付元仕様に準拠: 視認時は確度1、非視認時は0.12/秒で減衰し0.02以下で破棄
function weightedExposure(px, pz, reports) {
  let total = 0, exposed = 0;
  reports.forEach((r) => {
    if (r.confidence <= CONFIDENCE_CUTOFF) return;
    total += r.confidence;
    if (hasLineOfSight(px, pz, r.x, r.z)) exposed += r.confidence;
  });
  return total > 0 ? exposed / total : 0;
}
function squadReports(sq) {
  return Object.values(sq.memory).filter((m) => m.confidence > CONFIDENCE_CUTOFF);
}
function registerReport(sq, id, x, z, now) {
  sq.memory[id] = { x, z, confidence: 1, lastSeenAt: now };
}
function updateSquadMemory(squadId, st, dt) {
  const sq = st.squads[squadId];
  const members = st.units.filter((u) => u.squadId === squadId && u.alive);
  const enemies = st.units.filter((u) => u.team !== sq.team && u.alive);
  enemies.forEach((e) => {
    const seen = members.some((u) => canSee(u, e.x, e.z, DETECT_RANGE));
    if (seen) {
      sq.memory[e.id] = { x: e.x, z: e.z, confidence: 1, lastSeenAt: st.simTime };
    } else if (sq.memory[e.id]) {
      sq.memory[e.id].confidence = Math.max(0, sq.memory[e.id].confidence - dt * CONFIDENCE_DECAY);
    }
  });
}

// ==== 扇形視界判定 ====================================================
function canSee(u, ex, ez, range) {
  const dx = ex - u.x, dz = ez - u.z;
  const d = Math.hypot(dx, dz);
  if (d > range || d < 1e-6) return false;
  const targetAngle = Math.atan2(dx, dz);
  let diff = Math.abs(targetAngle - u.angle);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  if (diff > FOV_HALF_RAD) return false;
  return hasLineOfSight(u.x, u.z, ex, ez);
}

// ==== 経路探索(グリッド+ダイクストラ法、露出加重つき) ====================
const NAV_STEP = 1.0 * MAP_SCALE; // マップ拡大に合わせてステップも拡大(基準値は原寸1.0m相当)
// ノード同士を結ぶ辺が壁を「跨いで」しまわないかを検証する。
// (壁の厚みよりノード間隔が広いと、ノード中心同士は壁の外でも直線経路が壁を貫通してしまうため)
// ユニットの当たり半径(0.35)相当の余裕を持たせ、壁の角にぴったり沿うような
// 詰まりやすい経路も除外する。
function edgeIsClear(ax, az, bx, bz) {
  if (!hasLineOfSight(ax, az, bx, bz)) return false;
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz) || 1;
  const px = -dz / d, pz = dx / d;
  const margin = 0.45;
  if (!hasLineOfSight(ax + px * margin, az + pz * margin, bx + px * margin, bz + pz * margin)) return false;
  if (!hasLineOfSight(ax - px * margin, az - pz * margin, bx - px * margin, bz - pz * margin)) return false;
  return true;
}
const NAV_GRID = (() => {
  const cols = Math.round((BOUNDS.maxX - BOUNDS.minX) / NAV_STEP) + 1;
  const rows = Math.round((BOUNDS.maxZ - BOUNDS.minZ) / NAV_STEP) + 1;
  const idxMap = new Int32Array(cols * rows).fill(-1);
  const nodes = [];
  for (let gz = 0; gz < rows; gz++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = BOUNDS.minX + gx * NAV_STEP, z = BOUNDS.minZ + gz * NAV_STEP;
      if (collidesWall(x, z, 0.45)) continue;
      idxMap[gz * cols + gx] = nodes.length;
      nodes.push({ x, z, gx, gz });
    }
  }
  const adj = nodes.map(() => []);
  const dirs8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  nodes.forEach((n, i) => dirs8.forEach(([dx, dz]) => {
    const ngx = n.gx + dx, ngz = n.gz + dz;
    if (ngx < 0 || ngx >= cols || ngz < 0 || ngz >= rows) return;
    const j = idxMap[ngz * cols + ngx];
    if (j === -1) return;
    const m = nodes[j];
    if (!edgeIsClear(n.x, n.z, m.x, m.z)) return; // 辺が壁を貫通する場合は接続しない
    adj[i].push([j, Math.hypot(dx, dz) * NAV_STEP]);
  }));
  return { nodes, adj };
})();
function nearestNavNode(x, z) {
  let best = -1, bestD = Infinity;
  const { nodes } = NAV_GRID;
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i].x - x, nodes[i].z - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function findPath(startIdx, endIdx, reports, expWeight) {
  const { nodes, adj } = NAV_GRID;
  const n = nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[startIdx] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1 || u === endIdx) break;
    visited[u] = 1;
    for (const [v, edgeDist] of adj[u]) {
      if (visited[v]) continue;
      const a = nodes[u], b = nodes[v];
      const midx = (a.x + b.x) / 2, midz = (a.z + b.z) / 2;
      const expMid = reports.length ? weightedExposure(midx, midz, reports) : 0;
      const cost = edgeDist * (1 + expWeight * 4 * expMid);
      const nd = dist[u] + cost;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  if (dist[endIdx] === Infinity) return null;
  const path = [];
  let cur = endIdx;
  while (cur !== -1) { path.push(cur); cur = prev[cur]; }
  path.reverse();
  return path;
}

// ==== ユニット生成 ====================================================
// 1チーム(分隊、12名)= 3個ファイヤーチーム(FT、各4名)。
// FTごとに独立した索敵記憶・意思決定(バウンディングオーバーウォッチ等)を持つ。
function makeSquad(teamId, squadIdx) {
  const def = TEAM_DEFS[teamId];
  const squadId = `${teamId}${squadIdx}`;
  const fwd = def.advanceDir;
  const perp = rotateDir(fwd, Math.PI / 2); // 前進方向に対して左右方向(自由配置に対応するためベクトルで一般化)
  const centerX = def.spawn.x + perp.x * SQUAD_OFFSET_X[squadIdx];
  const centerZ = def.spawn.z + perp.z * SQUAD_OFFSET_X[squadIdx];
  return MEMBER_OFFSETS.map((o, i) => {
    const u = {
      id: `${squadId}_${i}`,
      team: teamId,
      squadId,
      squadIdx,
      role: i === 0 ? "leader" : "member",
      fireteam: i < 2 ? "alpha" : "bravo",
      x: centerX - fwd.x * o.f + perp.x * o.r,
      z: centerZ - fwd.z * o.f + perp.z * o.r,
      angle: angleOf(fwd),
      alive: true,
      targetId: null,
      fireCooldown: rand(0.2, 0.8),
      order: null,
      underFireUntil: 0,
      lastShotFrom: null,
      path: null,
      pathIndex: 0,
      pathDestKey: null,
    };
    pushOutOfWalls(u);
    return u;
  });
}
function makeSquadState(squadId, teamId, squadIdx) {
  return {
    id: squadId, team: teamId, squadIdx,
    mode: "ADVANCE", modeSince: 0, role: "ATTACK", boundingLeg: "alpha", baseElement: "alpha", boundTarget: null, unitDest: {}, unitDestSince: {}, memory: {}, decisionTimer: rand(0, 0.5),
    searchPoint: null, searchSweep: 0, searchStuckTicks: 0, searchLastMc: null, leaderId: `${squadId}_0`,
  };
}
function buildInitialUnits() {
  const units = [];
  ["A", "B"].forEach((team) => { for (let i = 0; i < SQUAD_COUNT; i++) units.push(...makeSquad(team, i)); });
  return units;
}
function buildInitialSquadStates() {
  const squads = {};
  ["A", "B"].forEach((team) => { for (let i = 0; i < SQUAD_COUNT; i++) { const sid = `${team}${i}`; squads[sid] = makeSquadState(sid, team, i); } });
  return squads;
}
const SQUAD_IDS = { A: [0, 1, 2].map((i) => `A${i}`), B: [0, 1, 2].map((i) => `B${i}`) };
const ALL_SQUAD_IDS = [...SQUAD_IDS.A, ...SQUAD_IDS.B];

// FTリーダーが戦闘不能になったら、そのFT内で生存する最若番の隊員が指揮を引き継ぐ
function ensureLeadership(squadId, st) {
  const sq = st.squads[squadId];
  const current = st.units.find((u) => u.id === sq.leaderId);
  if (current && current.alive) return;
  const successor = st.units
    .filter((u) => u.squadId === squadId && u.alive)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  st.units.forEach((u) => { if (u.squadId === squadId) u.role = "member"; });
  if (successor) { sq.leaderId = successor.id; successor.role = "leader"; }
}
// 分隊長(チーム全体の指揮官、FTリーダーの1人が兼任)が戦闘不能になったら、
// 他の生存FTリーダーの中で最若番のFTが指揮を引き継ぐ(二階層の指揮系統)
function ensureTeamLeadership(team, st) {
  const current = st.units.find((u) => u.id === st.teamLeader[team]);
  if (current && current.alive) return;
  const candidate = SQUAD_IDS[team]
    .map((sid) => st.units.find((u) => u.id === st.squads[sid].leaderId && u.alive))
    .filter(Boolean)[0];
  if (candidate) st.teamLeader[team] = candidate.id;
}

// ==== 壁への埋め込みを検知して押し出す(安全弁) ===========================
function pushOutOfWalls(u, r = 0.35) {
  for (const w of WALLS) {
    const minX = w.cx - w.hw - r, maxX = w.cx + w.hw + r;
    const minZ = w.cz - w.hd - r, maxZ = w.cz + w.hd + r;
    if (u.x <= minX || u.x >= maxX || u.z <= minZ || u.z >= maxZ) continue;
    const dxLeft = u.x - minX, dxRight = maxX - u.x, dzTop = u.z - minZ, dzBottom = maxZ - u.z;
    const minPen = Math.min(dxLeft, dxRight, dzTop, dzBottom);
    if (minPen === dxLeft) u.x = minX;
    else if (minPen === dxRight) u.x = maxX;
    else if (minPen === dzTop) u.z = minZ;
    else u.z = maxZ;
  }
}

// ==== 移動(壁スライド + 分離 + 壁押し出し) ==============================
function moveUnitSafe(u, dirx, dirz, speed, dt, allUnits) {
  let dx = dirx, dz = dirz;
  allUnits.forEach((o) => {
    if (o === u || !o.alive) return;
    const ddx = u.x - o.x, ddz = u.z - o.z;
    const d = Math.hypot(ddx, ddz);
    if (d > 0 && d < 1.1) { dx += (ddx / d) * 0.6; dz += (ddz / d) * 0.6; }
  });
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) { pushOutOfWalls(u); return; }
  dx /= len; dz /= len;
  const step = speed * dt;
  const nx = clamp(u.x + dx * step, BOUNDS.minX, BOUNDS.maxX);
  const nz = clamp(u.z + dz * step, BOUNDS.minZ, BOUNDS.maxZ);
  if (!collidesWall(nx, nz, 0.35)) { u.x = nx; u.z = nz; }
  else if (!collidesWall(nx, u.z, 0.35)) { u.x = nx; }
  else if (!collidesWall(u.x, nz, 0.35)) { u.z = nz; }
  pushOutOfWalls(u);
}

// ==== FTリーダーの意思決定(FT=4名単位の命令) =============================
// ==== 分隊長による役割分担(占領エリアの防衛 vs 敵の掃討) ==================
// チーム全体を統括する分隊長が、生存中のFTを「占領エリアに残って防衛する」役と
// 「敵を探して倒しに行く(攻撃)」役に振り分ける。基本方針:
//   - まだ誰も占領エリアに到達していなければ全FTが攻撃(=占領エリアへの前進を継続)。
//   - 到達したFTが出てきたら、その中から(占領エリア付近に敵の気配があるかに応じて)
//     1〜2個を防衛役として残し、残りは攻撃役として敵の掃討を継続させる。
function updateTeamStrategy(team, st) {
  const squadIds = SQUAD_IDS[team];
  const aliveSquadIds = squadIds.filter((sid) => st.units.some((u) => u.squadId === sid && u.alive));
  if (aliveSquadIds.length === 0) return;

  const inZone = (sid) => {
    const members = st.units.filter((u) => u.squadId === sid && u.alive);
    if (!members.length) return false;
    const c = centroid(members);
    return dist2(c.x, c.z, ZONE_CENTER.x, ZONE_CENTER.z) <= ZONE_RADIUS + 4;
  };
  const arrived = aliveSquadIds.filter(inZone);

  // 自チームの全FTの索敵記憶を統合し、占領エリア付近に敵の気配があるかを判断する
  // (脅威が近ければ防衛を厚くする)
  const enemyNearZone = aliveSquadIds.some((sid) => {
    const sq = st.squads[sid];
    return Object.values(sq.memory).some((m) => m.confidence > CONFIDENCE_CUTOFF && dist2(m.x, m.z, ZONE_CENTER.x, ZONE_CENTER.z) <= ZONE_RADIUS + 10);
  });

  const desiredDefenders = arrived.length === 0 ? 0 : Math.min(arrived.length, enemyNearZone ? 2 : 1);
  const sortedArrived = [...arrived].sort((a, b) => st.squads[a].squadIdx - st.squads[b].squadIdx);
  const defenders = new Set(sortedArrived.slice(0, desiredDefenders));
  aliveSquadIds.forEach((sid) => { st.squads[sid].role = defenders.has(sid) ? "DEFEND" : "ATTACK"; });
}

// 防衛役のFTを占領エリア内に展開させる(外周に散開し、外向きに警戒しつつ静止する)。
// CONTACT(交戦)になれば通常の交戦ロジックに切り替わるため、これはあくまで
// 「敵が来るまでの待機隊形」。
function assignDefensivePositions(members, sq) {
  const n = members.length;
  members.forEach((u, i) => {
    // FTごとに開始角度をずらし、複数FTが防衛に回っても円周上で重ならないようにする
    const angle = (i / n) * Math.PI * 2 + sq.squadIdx * 0.9;
    const r = ZONE_RADIUS * 0.55;
    const px = ZONE_CENTER.x + Math.cos(angle) * r;
    const pz = ZONE_CENTER.z + Math.sin(angle) * r;
    const outward = { x: Math.cos(angle), z: Math.sin(angle) }; // 拠点の外側を向いて警戒
    u.order = { type: "hold", dest: { x: px, z: pz }, lookDir: outward };
  });
}


function updateSquadOrders(squadId, st) {
  const sq = st.squads[squadId];
  const team = sq.team;
  const def = TEAM_DEFS[team];
  const members = st.units.filter((u) => u.squadId === squadId && u.alive);
  if (members.length === 0) return;

  const reports = squadReports(sq);
  const hasContact = reports.length > 0;
  const everContact = Object.keys(sq.memory).length > 0;
  let lastKnown = null;
  Object.values(sq.memory).forEach((m) => { if (!lastKnown || m.lastSeenAt > lastKnown.lastSeenAt) lastKnown = m; });

  const prevMode = sq.mode;
  // 劣勢判定は「自FTが把握している(索敵報告済みの)脅威数」基準。
  // 敵チーム全体(他FTの索敵分含む)ではなく、自FTが実際に認識している状況で判断する。
  const knownEnemyCount = reports.length;
  let nextMode;
  if (members.length < knownEnemyCount - def.fallbackDeficit) nextMode = "FALLBACK";
  else if (hasContact) nextMode = "CONTACT";
  else if (everContact) nextMode = "SEARCH"; // 殲滅するまで、見失っても最終目撃位置を起点に索敵を継続する
  else nextMode = "ADVANCE";

  // モード判定にヒステリシス(最小滞留時間)を設ける。境界付近の値がわずかに揺れるだけで
  // FALLBACK⇔CONTACTなどを意思決定サイクルごとに往復してしまうと、目的地キャッシュが
  // そのたびに破棄されて足踏み・反復移動の原因になるため、直前のモード開始から
  // 一定時間(1.2秒)は原則として維持する。ただしFALLBACKへの移行(危険回避)だけは
  // 安全のため即座に許可する。
  if (nextMode !== sq.mode) {
    const dwell = st.simTime - (sq.modeSince || 0);
    if (nextMode === "FALLBACK" || dwell >= 1.2) {
      sq.mode = nextMode;
      sq.modeSince = st.simTime;
    }
  }

  // バウンディングオーバーウォッチ・交戦時の各種目的地は「決めたら到達するまで変えない」方針のため、
  // モードが切り替わった際は古い状況に基づくキャッシュを破棄し、現在地から改めて算出させる。
  if (prevMode !== sq.mode) {
    sq.boundTarget = null;
    sq.unitDest = {};
    sq.unitDestSince = {};
  }

  if (sq.mode === "SEARCH" && prevMode !== "SEARCH") {
    sq.searchPoint = lastKnown ? { x: lastKnown.x, z: lastKnown.z } : (() => {
      const perp = rotateDir(def.advanceDir, Math.PI / 2);
      return { x: def.spawn.x + perp.x * SQUAD_OFFSET_X[sq.squadIdx], z: def.spawn.z + perp.z * SQUAD_OFFSET_X[sq.squadIdx] };
    })();
    sq.searchSweep = 0;
    sq.searchStuckTicks = 0;
    sq.searchLastMc = null;
  }

  const alpha = members.filter((u) => u.fireteam === "alpha");
  const bravo = members.filter((u) => u.fireteam === "bravo");

  // バウンディングオーバーウォッチ(前進/索敵で共用): 片方の班が遮蔽物沿いに移動、
  // もう片方は静止して前方以外(側面・後方)を分担監視し、隊全体で死角をカバーする
  const runBoundingOverwatch = (forwardDir) => {
    // 片方のファイアチームが全滅している場合、2班運用は成立しないため
    // 生存者全員で一つの集団として前進させる(空配列の"到達済み"誤判定によるフリーズも回避)
    if (alpha.length === 0 || bravo.length === 0) {
      // ここも他の分岐と同様、到達するまで目的地を変えない(毎サイクル再計算すると、
      // 壁際の候補地点を行ったり来たりし続ける不安定な動きになるため)
      const mc = centroid(members);
      if (!sq.boundTarget || dist2(mc.x, mc.z, sq.boundTarget.x, sq.boundTarget.z) < 1.8) {
        sq.boundTarget = nearestCoverTowards(mc.x, mc.z, forwardDir.x, forwardDir.z, def.boundMinAdv, def.boundMaxAdv);
      }
      const dest = sq.boundTarget;
      members.forEach((u, i) => {
        const off = offsetPerp(i, members.length, 1.3, forwardDir);
        const spreadDeg = members.length >= 2 ? (i % 2 === 0 ? -30 : 30) : 0;
        const lookDir = rotateDir(forwardDir, (spreadDeg * Math.PI) / 180);
        if (dest) u.order = { type: "move", dest: { x: dest.x + off.x, z: dest.z + off.z }, lookDir };
        else u.order = { type: "hold", dest: { x: u.x, z: u.z }, lookDir }; // 前進先が無ければ無理に動かず待機
      });
      return;
    }
    const movingArr = sq.boundingLeg === "alpha" ? alpha : bravo;
    const overwatchArr = sq.boundingLeg === "alpha" ? bravo : alpha;

    // 躍進先はバウンド(このレグ)の開始時に一度だけ決定し、到達するまで変更しない。
    // 毎意思決定サイクルごとに再計算すると、境目付近で壁の向こう側/手前側の候補を
    // 行ったり来たり選んでしまい、無限に往復するような不安定な動きになるため。
    if (!sq.boundTarget) {
      const mc = centroid(movingArr);
      const supportPos = centroid(overwatchArr);
      sq.boundTarget = pickSupportedBoundTarget(mc.x, mc.z, forwardDir.x, forwardDir.z, def.boundMinAdv, def.boundMaxAdv, supportPos);
    }
    const dest = sq.boundTarget;
    movingArr.forEach((u, i) => {
      const off = offsetPerp(i, movingArr.length, 1.6, forwardDir);
      // 移動班も全員が同じ方向ではなく、前方を左右に分担して見る(隊全体での死角低減)
      const spreadDeg = movingArr.length === 2 ? (i === 0 ? -25 : 25) : 0;
      const lookDir = rotateDir(forwardDir, (spreadDeg * Math.PI) / 180);
      u.order = { type: "move", dest: { x: dest.x + off.x, z: dest.z + off.z }, lookDir };
    });
    const allArrived = movingArr.every((u) => dist2(u.x, u.z, u.order.dest.x, u.order.dest.z) < 1.8);
    if (allArrived) {
      sq.boundingLeg = sq.boundingLeg === "alpha" ? "bravo" : "alpha";
      sq.boundTarget = null; // 次のバウンドのために再計算させる
    }
    // オーバーウォッチ側の注視方向: ドクトリン通り、最低一人は移動側が向かう方向(=支援すべき方向)を
    // 注視する。2名いる場合はもう一人が側背面を分担する。
    if (overwatchArr.length === 2) {
      overwatchArr[0].order = { type: "hold", dest: { x: overwatchArr[0].x, z: overwatchArr[0].z }, lookDir: forwardDir };
      overwatchArr[1].order = { type: "hold", dest: { x: overwatchArr[1].x, z: overwatchArr[1].z }, lookDir: rotateDir(forwardDir, (140 * Math.PI) / 180) };
    } else if (overwatchArr.length === 1) {
      overwatchArr[0].order = { type: "hold", dest: { x: overwatchArr[0].x, z: overwatchArr[0].z }, lookDir: forwardDir };
    }
  };

  // 防衛役に割り当てられ、かつ既に占領エリアへ到達しているFTは、通常のADVANCE(前進)や
  // SEARCH(見失った敵を追う)を行わず、占領エリア内に留まって防衛陣形をとる。
  // 敵と交戦(CONTACT)になった場合は通常の交戦ロジックへ切り替わる(この分岐を素通りする)ので、
  // 「敵が来るまでの待機」から「実際の交戦」へは自動的に移行する。
  if ((sq.mode === "ADVANCE" || sq.mode === "SEARCH") && sq.role === "DEFEND") {
    const mc = centroid(members);
    if (dist2(mc.x, mc.z, ZONE_CENTER.x, ZONE_CENTER.z) <= ZONE_RADIUS + 4) {
      assignDefensivePositions(members, sq);
      return;
    }
    // まだ占領エリアに到達していない防衛役は、通常通りエリアへ向けて前進を続ける
  }

  if (sq.mode === "ADVANCE") {
    // 各陣営の目的地は占領エリアの中心。固定方向ではなく現在地から都度算出することで、
    // 障害物を迂回した後も改めて中心へ向き直せるようにする。
    const mc = centroid(members);
    const toZone = dirTo(mc, ZONE_CENTER);
    runBoundingOverwatch(toZone);
  } else if (sq.mode === "SEARCH") {
    const mc = centroid(members);
    // 進捗検知: 直前の意思決定サイクルからほとんど動けていない場合(壁に阻まれた等)は
    // 詰まっていると判断し、漸進的なスイープではなくマップ内のランダムな地点へ大きくジャンプする。
    // これにより「見失った敵を探しに行ったまま動けなくなる」状態を防ぎ、捜索を継続させる。
    if (sq.searchLastMc) {
      const moved = dist2(mc.x, mc.z, sq.searchLastMc.x, sq.searchLastMc.z);
      sq.searchStuckTicks = moved < 1.5 ? (sq.searchStuckTicks || 0) + 1 : 0;
    }
    sq.searchLastMc = { x: mc.x, z: mc.z };
    const stuck = (sq.searchStuckTicks || 0) >= 3;

    if (stuck || dist2(mc.x, mc.z, sq.searchPoint.x, sq.searchPoint.z) < 3.5) {
      sq.searchSweep += 1;
      if (stuck) {
        sq.searchPoint = {
          x: clamp(rand(BOUNDS.minX + 4, BOUNDS.maxX - 4), BOUNDS.minX + 2, BOUNDS.maxX - 2),
          z: clamp(rand(BOUNDS.minZ + 4, BOUNDS.maxZ - 4), BOUNDS.minZ + 2, BOUNDS.maxZ - 2),
        };
        sq.searchStuckTicks = 0;
      } else {
        const perp = rotateDir(def.advanceDir, Math.PI / 2);
        const side = sq.searchSweep % 2 === 0 ? 1 : -1;
        // マップが2.5倍に拡大された分、スイープの振れ幅・前進量もスケールしないと
        // 「最終目撃地点のごく近くをちょこちょこ動くだけ」に見えてしまうため合わせて拡大
        const spread = (6 + sq.searchSweep * 2) * MAP_SCALE;
        const anchor = lastKnown || sq.searchPoint;
        sq.searchPoint = {
          x: clamp(anchor.x + perp.x * side * spread + def.advanceDir.x * sq.searchSweep * 3 * MAP_SCALE, BOUNDS.minX + 2, BOUNDS.maxX - 2),
          z: clamp(anchor.z + perp.z * side * spread + def.advanceDir.z * sq.searchSweep * 3 * MAP_SCALE, BOUNDS.minZ + 2, BOUNDS.maxZ - 2),
        };
      }
    }
    const forwardDir = dirTo(mc, sq.searchPoint);
    runBoundingOverwatch(forwardDir);
  } else if (sq.mode === "CONTACT") {
    // ヒステリシス(最小滞留時間)により、直近の索敵報告が無くなった直後でも
    // 数フレームはモードがCONTACTのまま残ることがある。その場合にreports[0]が
    // undefinedとなりクラッシュしないよう、安全に「捜索継続」相当の動きにフォールバックする。
    if (reports.length === 0) {
      const mc = centroid(members);
      runBoundingOverwatch(lastKnown ? dirTo(mc, lastKnown) : def.advanceDir);
      return;
    }
    const mcNow = centroid(members);
    let primary = reports[0];
    reports.forEach((r) => {
      if (r.confidence > primary.confidence + 0.001) primary = r;
      else if (Math.abs(r.confidence - primary.confidence) <= 0.001 && dist2(mcNow.x, mcNow.z, r.x, r.z) < dist2(mcNow.x, mcNow.z, primary.x, primary.z)) primary = r;
    });
    const enemyPos = primary;
    const alphaLOS = alpha.some((u) => hasLineOfSight(u.x, u.z, enemyPos.x, enemyPos.z));
    const bravoLOS = bravo.some((u) => hasLineOfSight(u.x, u.z, enemyPos.x, enemyPos.z));
    let base, maneuver;
    if (alphaLOS && !bravoLOS) { base = alpha; maneuver = bravo; }
    else if (bravoLOS && !alphaLOS) { base = bravo; maneuver = alpha; }
    else { base = sq.baseElement === "bravo" ? bravo : alpha; maneuver = base === alpha ? bravo : alpha; }
    sq.baseElement = base === alpha ? "alpha" : "bravo";

    base.forEach((u) => {
      const d = dist2(u.x, u.z, enemyPos.x, enemyPos.z);
      const ok = hasLineOfSight(u.x, u.z, enemyPos.x, enemyPos.z) && d >= def.engageMin - 2 && d <= def.engageMax + 2;
      if (ok) {
        delete sq.unitDest[u.id];
        u.order = { type: "suppress", dest: { x: u.x, z: u.z }, lookDir: dirTo(u, enemyPos) };
      } else {
        // 目的地は「未決定」または「既に到達済み、かつ前回の選択から一定時間(1.5秒)経過」の
        // ときだけ再計算する。到達した瞬間に毎回再計算すると、僅かな位置差で別の掩体候補に
        // 切り替わり続け、壁を挟んで行ったり来たりする不安定な動きになってしまうため。
        const cur = sq.unitDest[u.id];
        const sinceLast = st.simTime - (sq.unitDestSince[u.id] || 0);
        if (!cur || (dist2(u.x, u.z, cur.x, cur.z) < 1.5 && sinceLast >= 1.5)) {
          const p = bestCoverPoint(u.x, u.z, enemyPos, def.engageMin, def.engageMax);
          sq.unitDest[u.id] = p || { x: u.x, z: u.z };
          sq.unitDestSince[u.id] = st.simTime;
        }
        u.order = { type: "suppress", dest: sq.unitDest[u.id], lookDir: dirTo(u, enemyPos) };
      }
    });
    const baseCentroid = centroid(base);
    maneuver.forEach((u) => {
      const cur = sq.unitDest[u.id];
      const sinceLast = st.simTime - (sq.unitDestSince[u.id] || 0);
      if (!cur || (dist2(u.x, u.z, cur.x, cur.z) < 1.5 && sinceLast >= 1.5)) {
        const p = bestFlankPoint(u.x, u.z, enemyPos, baseCentroid, def.engageMin, def.engageMax);
        sq.unitDest[u.id] = p || { x: u.x + (enemyPos.x - u.x) * 0.1, z: u.z + (enemyPos.z - u.z) * 0.1 };
        sq.unitDestSince[u.id] = st.simTime;
      }
      u.order = { type: "maneuver", dest: sq.unitDest[u.id], lookDir: dirTo(u, enemyPos) };
    });
  } else {
    members.forEach((u) => {
      // 後退先も、決めたら到達するまで変えない(毎サイクル new rand() していると
      // 目的地が細かく揺れ続けて足踏みのように見えてしまうため)
      if (!sq.unitDest[u.id]) {
        const perp = rotateDir(def.advanceDir, Math.PI / 2);
        const jitter = rand(-2, 2);
        sq.unitDest[u.id] = { x: def.spawn.x + perp.x * SQUAD_OFFSET_X[sq.squadIdx] + perp.x * jitter, z: def.spawn.z + perp.z * SQUAD_OFFSET_X[sq.squadIdx] + perp.z * jitter };
      }
      u.order = { type: "retreat", dest: sq.unitDest[u.id], lookDir: lastKnown ? dirTo(u, lastKnown) : def.advanceDir };
    });
  }
}

const ORDER_COLOR = { move: 0xa78bfa, hold: 0x9ca3af, suppress: 0xf59e0b, maneuver: 0xa78bfa, retreat: 0xef4444, evade: 0x22d3ee };
const UNIT_LABEL = { A: "チームA", B: "チームB" };

export default function Squad4v4AutoBattleMock() {
  const mountRef = useRef(null);
  const stateRef = useRef({
    units: buildInitialUnits(),
    kills: { A: 0, B: 0 },
    speed: 1,
    expWeightByTeam: { A: TEAM_DEFS.A.expWeight, B: TEAM_DEFS.B.expWeight },
    clock: new THREE.Clock(),
    simTime: 0,
    winner: null,
    squads: buildInitialSquadStates(),
    teamLeader: { A: "A0_0", B: "B0_0" }, // 各チームの分隊長(最初はFT1のリーダーが兼任)
    zoneControl: { team: null, since: null },
    teamStrategyTimer: { A: 0, B: 0.3 }, // 分隊長による役割分担(防衛/攻撃)の再評価タイマー
  });
  const [hud, setHud] = useState({
    aliveA: 12, aliveB: 12, killsA: 0, killsB: 0, winner: null,
    modeA: ["ADVANCE", "ADVANCE", "ADVANCE"], modeB: ["ADVANCE", "ADVANCE", "ADVANCE"],
    roleA: ["ATTACK", "ATTACK", "ATTACK"], roleB: ["ATTACK", "ATTACK", "ATTACK"],
    zoneTeam: null, zoneElapsed: 0,
  });
  const [speed, setSpeed] = useState(1);
  const [paramsA, setParamsA] = useState({
    expWeight: TEAM_DEFS.A.expWeight, engageMin: TEAM_DEFS.A.engageMin, engageMax: TEAM_DEFS.A.engageMax,
    boundMinAdv: TEAM_DEFS.A.boundMinAdv, boundMaxAdv: TEAM_DEFS.A.boundMaxAdv,
    fallbackDeficit: TEAM_DEFS.A.fallbackDeficit, underFireDuration: TEAM_DEFS.A.underFireDuration,
  });
  const [paramsB, setParamsB] = useState({
    expWeight: TEAM_DEFS.B.expWeight, engageMin: TEAM_DEFS.B.engageMin, engageMax: TEAM_DEFS.B.engageMax,
    boundMinAdv: TEAM_DEFS.B.boundMinAdv, boundMaxAdv: TEAM_DEFS.B.boundMaxAdv,
    fallbackDeficit: TEAM_DEFS.B.fallbackDeficit, underFireDuration: TEAM_DEFS.B.underFireDuration,
  });
  const [running, setRunning] = useState(true);
  const [showVision, setShowVision] = useState(false);
  const [showLines, setShowLines] = useState(true);
  const [showOrders, setShowOrders] = useState(true);
  const [showPath, setShowPath] = useState(false);
  const [showAff, setShowAff] = useState(true);
  const [placementMode, setPlacementMode] = useState(null); // null | "A" | "B" | "ZONE"
  const [commonParams, setCommonParams] = useState({
    detectRange: DETECT_RANGE, fovDeg: (FOV_HALF_RAD * 2 * 180) / Math.PI, fireAlignDeg: (FIRE_ALIGN_RAD * 180) / Math.PI,
    moveSpeed: MOVE_SPEED, turnRateDeg: (TURN_RATE * 180) / Math.PI, confidenceDecay: CONFIDENCE_DECAY,
    zoneRadius: ZONE_RADIUS, captureDuration: ZONE_CAPTURE_DURATION,
  });
  const speedRef = useRef(1);
  const runningRef = useRef(true);
  const showVisionRef = useRef(false);
  const showLinesRef = useRef(true);
  const showOrdersRef = useRef(true);
  const showPathRef = useRef(false);
  const showAffRef = useRef(true);
  const placementModeRef = useRef(null);
  const rendererElRef = useRef(null);
  const controlRef = useRef({});

  // 両陣営共通パラメータの更新。TEAM_DEFSと同様、モジュール直下のlet変数を直接書き換えて
  // 次フレームから即座に反映する。角度系はUI上は度数で扱い、内部はラジアンに変換する。
  const updateCommonParam = (key, value) => {
    if (key === "detectRange") { DETECT_RANGE = value; controlRef.current.rebuildVisionCones && controlRef.current.rebuildVisionCones(); }
    else if (key === "fovDeg") { FOV_HALF_RAD = (value * Math.PI) / 360; controlRef.current.rebuildVisionCones && controlRef.current.rebuildVisionCones(); } // 全体角度→半角ラジアン
    else if (key === "fireAlignDeg") FIRE_ALIGN_RAD = (value * Math.PI) / 180;
    else if (key === "moveSpeed") MOVE_SPEED = value;
    else if (key === "turnRateDeg") TURN_RATE = (value * Math.PI) / 180;
    else if (key === "confidenceDecay") CONFIDENCE_DECAY = value;
    else if (key === "zoneRadius") { ZONE_RADIUS = value; controlRef.current.rebuildZoneMesh && controlRef.current.rebuildZoneMesh(); }
    else if (key === "captureDuration") ZONE_CAPTURE_DURATION = value;
    setCommonParams((p) => ({ ...p, [key]: value }));
  };

  // パラメータはTEAM_DEFS(モジュール直下の共有オブジェクト)を直接書き換えることで
  // シミュレーション側に即時反映する(意思決定は毎ティックTEAM_DEFSを読み直すため)。
  const updateParam = (team, key, value) => {
    TEAM_DEFS[team][key] = value;
    if (key === "expWeight") stateRef.current.expWeightByTeam[team] = value;
    const setter = team === "A" ? setParamsA : setParamsB;
    setter((p) => ({ ...p, [key]: value }));
  };

  useEffect(() => { speedRef.current = speed; stateRef.current.speed = speed; }, [speed]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { showVisionRef.current = showVision; }, [showVision]);
  useEffect(() => { showLinesRef.current = showLines; }, [showLines]);
  useEffect(() => { showOrdersRef.current = showOrders; }, [showOrders]);
  useEffect(() => { showPathRef.current = showPath; }, [showPath]);
  useEffect(() => { showAffRef.current = showAff; }, [showAff]);
  useEffect(() => { placementModeRef.current = placementMode; if (rendererElRef.current) rendererElRef.current.style.cursor = placementMode ? "crosshair" : "default"; }, [placementMode]);

  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth, height = mount.clientHeight;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111827);
    const CAM_DIV = 20 / MAP_SCALE; // マップが2.5倍に広がった分、ズームアウトして全体が入るように
    const camera = new THREE.OrthographicCamera(-width / CAM_DIV, width / CAM_DIV, height / CAM_DIV, -height / CAM_DIV, 0.1, 400);
    camera.position.set(0, 60, 42);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    rendererElRef.current = renderer.domElement;
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    const GROUND_W = 150 * MAP_SCALE, GROUND_D = 130 * MAP_SCALE;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_W, GROUND_D), new THREE.MeshBasicMaterial({ color: 0x1f2937 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const gridHelper = new THREE.GridHelper(GROUND_W, Math.round(75 * MAP_SCALE), 0x374151, 0x263041);
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    // 勝利条件となる占領エリア(マップ中心の円)を可視化する。
    // 半径はUIから変更できるため、ジオメトリを作り直せる関数として用意する。
    const zoneGroup = new THREE.Group();
    scene.add(zoneGroup);
    const rebuildZoneMesh = () => {
      zoneGroup.clear();
      zoneGroup.position.set(ZONE_CENTER.x, 0, ZONE_CENTER.z);
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(ZONE_RADIUS, 48),
        new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.08, depthWrite: false })
      );
      fill.rotation.x = -Math.PI / 2; fill.position.y = 0.02;
      zoneGroup.add(fill);
      const ringGeo = new THREE.RingGeometry(ZONE_RADIUS - 0.4, ZONE_RADIUS, 64);
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
      zoneGroup.add(ring);
    };
    rebuildZoneMesh();
    controlRef.current.rebuildZoneMesh = rebuildZoneMesh;
    WALLS.forEach((w) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.hw * 2, 1.4, w.hd * 2), new THREE.MeshBasicMaterial({ color: 0x6b7280 }));
      mesh.position.set(w.cx, 0.7, w.cz);
      scene.add(mesh);
    });

    const makeTriangle = (color) => {
      const shape = new THREE.Shape();
      shape.moveTo(0, -0.5); shape.lineTo(-0.38, 0.42); shape.lineTo(0.38, 0.42); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
      mesh.position.y = 0.06; mesh.renderOrder = 5;
      scene.add(mesh);
      return mesh;
    };
    const makeLeaderRing = (color) => {
      const geo = new THREE.RingGeometry(0.5, 0.6, 24);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.03; mesh.renderOrder = 4;
      scene.add(mesh);
      return mesh;
    };
    const buildVisionConeGeometry = () => {
      const shape = new THREE.Shape();
      const segs = 28;
      const start = -Math.PI / 2 - FOV_HALF_RAD;
      const end = -Math.PI / 2 + FOV_HALF_RAD;
      shape.moveTo(0, 0);
      for (let i = 0; i <= segs; i++) {
        const a = start + (end - start) * (i / segs);
        shape.lineTo(DETECT_RANGE * Math.cos(a), DETECT_RANGE * Math.sin(a));
      }
      shape.lineTo(0, 0);
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      return geo;
    };
    const makeVisionCone = (color) => {
      const geo = buildVisionConeGeometry();
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.015; mesh.renderOrder = 0; mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    const makeDashedLine = (color, dash, gap) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity: 0.8, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 6; line.visible = false;
      scene.add(line);
      return line;
    };
    const makeOrderMarker = () => {
      const geo = new THREE.RingGeometry(0.22, 0.3, 16);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.03; mesh.renderOrder = 4; mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    // 分隊長(チーム全体の指揮官)であることを示す、FTリーダーの外側にもう一段大きな金色リング
    const makeCmdRing = () => {
      const geo = new THREE.RingGeometry(0.78, 0.88, 24);
      const mat = new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.035; mesh.renderOrder = 4; mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    // 所属ライン(隊員→自FTリーダー)。実線・チームカラー
    const makeAffLine = (color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 3; line.visible = false;
      scene.add(line);
      return line;
    };

    const meshes = {};
    stateRef.current.units.forEach((u) => {
      const def = TEAM_DEFS[u.team];
      meshes[u.id] = {
        tri: makeTriangle(def.color),
        leaderRing: makeLeaderRing(def.color),
        cmdRing: makeCmdRing(),
        vision: makeVisionCone(def.color),
        targetLine: makeDashedLine(def.color, 0.3, 0.18),
        orderLine: makeDashedLine(0xffffff, 0.16, 0.12),
        orderMarker: makeOrderMarker(),
        pathLine: makeDashedLine(def.color, 0.25, 0.15),
        affLine: makeAffLine(def.color),
        cmdLine: makeDashedLine(def.color, 0.4, 0.2),
      };
    });

    // 索敵距離・索敵角度はUIから変更できるが、視界コーンの見た目(ジオメトリ)は
    // 生成時に一度だけ焼き込まれているため、パラメータ変更時にこの関数で全ユニット分を
    // 作り直す(判定ロジック自体はDETECT_RANGE/FOV_HALF_RADを毎フレーム直接参照するので
    // 見た目の再構築をしなくても正しく動作はするが、表示が古いままだと分かりづらいため)。
    const rebuildVisionCones = () => {
      const newGeo = buildVisionConeGeometry();
      Object.values(meshes).forEach((m) => {
        m.vision.geometry.dispose();
        m.vision.geometry = newGeo;
      });
    };
    controlRef.current.rebuildVisionCones = rebuildVisionCones;

    let tracerLines = [];
    const spawnTracer = (x1, z1, x2, z2, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, 0.5, z1), new THREE.Vector3(x2, 0.5, z2),
      ]);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 10;
      scene.add(line);
      tracerLines.push({ line, life: 0.12 });
    };

    const resetAll = () => {
      stateRef.current.units = buildInitialUnits();
      stateRef.current.kills = { A: 0, B: 0 };
      stateRef.current.winner = null;
      stateRef.current.simTime = 0;
      stateRef.current.squads = buildInitialSquadStates();
      stateRef.current.teamLeader = { A: "A0_0", B: "B0_0" };
      stateRef.current.zoneControl = { team: null, since: null };
      stateRef.current.teamStrategyTimer = { A: 0, B: 0.3 };
      setRunning(true);
      setHud({
        aliveA: 12, aliveB: 12, killsA: 0, killsB: 0, winner: null,
        modeA: ["ADVANCE", "ADVANCE", "ADVANCE"], modeB: ["ADVANCE", "ADVANCE", "ADVANCE"],
        roleA: ["ATTACK", "ATTACK", "ATTACK"], roleB: ["ATTACK", "ATTACK", "ATTACK"],
        zoneTeam: null, zoneElapsed: 0,
      });
    };
    controlRef.current.reset = resetAll;

    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const rawDt = Math.min(stateRef.current.clock.getDelta(), 0.05);
      const dt = rawDt * speedRef.current;
      const st = stateRef.current;

      if (runningRef.current && !st.winner) {
        st.simTime += dt;

        // --- 索敵レポートの確度更新(視認=1、非視認=0.12/秒で減衰、FT単位) ---
        ALL_SQUAD_IDS.forEach((sid) => updateSquadMemory(sid, st, dt));

        // --- FTリーダー不在なら即座に引き継ぎ、その後で分隊長(チーム全体)の不在も引き継ぐ ---
        ALL_SQUAD_IDS.forEach((sid) => ensureLeadership(sid, st));
        ["A", "B"].forEach((team) => ensureTeamLeadership(team, st));

        // --- 分隊長による役割分担(占領エリアの防衛/敵の攻撃)。FTの意思決定より
        //     やや長い間隔(2〜2.5秒)で見直す。FTごとの意思決定の直前に反映されるよう、
        //     ここで先に更新しておく。 ---
        ["A", "B"].forEach((team) => {
          st.teamStrategyTimer[team] -= dt;
          if (st.teamStrategyTimer[team] <= 0) {
            st.teamStrategyTimer[team] = rand(2.0, 2.5);
            updateTeamStrategy(team, st);
          }
        });

        // --- FTリーダーの意思決定(FT単位、一定間隔) ---
        ALL_SQUAD_IDS.forEach((sid) => {
          const sq = st.squads[sid];
          sq.decisionTimer -= dt;
          if (sq.decisionTimer <= 0) {
            sq.decisionTimer = rand(0.7, 0.95);
            updateSquadOrders(sid, st);
          }
        });

        const aliveUnits = st.units.filter((u) => u.alive);

        // --- 各隊員の実行 ---
        aliveUnits.forEach((u) => {
          const enemies = st.units.filter((o) => o.team !== u.team && o.alive);
          let target = null, bestDist = Infinity;
          enemies.forEach((e) => {
            if (canSee(u, e.x, e.z, DETECT_RANGE)) {
              const d = dist2(u.x, u.z, e.x, e.z);
              if (d < bestDist) { bestDist = d; target = e; }
            }
          });
          u.targetId = target ? target.id : null;

          let desiredAngle;
          if (target) desiredAngle = Math.atan2(target.x - u.x, target.z - u.z);
          else if (u.order) desiredAngle = angleOf(u.order.lookDir);
          else desiredAngle = u.angle;
          u.angle = turnToward(u.angle, desiredAngle, TURN_RATE * dt);

          const underFire = u.underFireUntil > st.simTime;
          // 被弾直後の離脱(evade)は、着弾の合間にunderFireが一瞬falseへ戻っただけで
          // 即座にsuppress等へ切り替わってしまうと、evade⇔suppressを高頻度で往復し
          // 不安定な動きになる。そのため、一度evadeへ入ったら最低でも一定時間は継続する。
          const inEvadeCommit = u.evadeUntil && st.simTime < u.evadeUntil;
          let destX, destZ, speedMul, orderType;
          // 移動先の選択(evadeか命令通りか)は「敵が見えているか」に依存させない。
          // 敵を一瞬視認しただけで移動先がevade地点⇔命令地点の間を高頻度で切り替わって
          // しまっていたため。射撃自体はこの判定と独立して行われるので、
          // 「撃たれながら遮蔽へ移動しつつ、狙えれば撃ち返す」という動きになる。
          if (underFire || inEvadeCommit) {
            if (!u.evadeDest || dist2(u.x, u.z, u.evadeDest.x, u.evadeDest.z) < 1.2) {
              const threat = u.lastShotFrom || { x: u.x + TEAM_DEFS[u.team].advanceDir.x, z: u.z + TEAM_DEFS[u.team].advanceDir.z };
              const toward = u.order ? u.order.dest : null;
              u.evadeDest = (toward ? nearestBreakContactPoint(u.x, u.z, threat, toward.x, toward.z) : nearestBreakContactPoint(u.x, u.z, threat))
                || (u.order ? u.order.dest : { x: u.x, z: u.z });
            }
            if (!inEvadeCommit) u.evadeUntil = st.simTime + 1.2;
            // 持続的に撃たれ続けて長時間(8秒以上)evadeから抜けられない場合の安全弁。
            // 近場の遮蔽を行ったり来たりするだけで本来の命令(後退など)へ一向に進めない
            // 状態を断ち切り、いったん命令の目的地への移動を優先させる。
            if (!u.evadeLockSince) u.evadeLockSince = st.simTime;
            if (st.simTime - u.evadeLockSince > 8 && u.order) {
              destX = u.order.dest.x; destZ = u.order.dest.z; orderType = u.order.type;
              speedMul = orderType === "retreat" ? 1.15 : (orderType === "hold" || orderType === "suppress") ? 0.7 : 1.0;
            } else {
              destX = u.evadeDest.x; destZ = u.evadeDest.z; speedMul = 1.2; orderType = "evade";
            }
          } else if (u.order) {
            u.evadeDest = null; u.evadeUntil = 0; u.evadeLockSince = 0;
            destX = u.order.dest.x; destZ = u.order.dest.z; orderType = u.order.type;
            speedMul = orderType === "retreat" ? 1.15 : (orderType === "hold" || orderType === "suppress") ? 0.7 : 1.0;
          } else { u.evadeDest = null; u.evadeUntil = 0; u.evadeLockSince = 0; destX = u.x; destZ = u.z; speedMul = 0; orderType = "hold"; }
          // 命令の目的地がマップ境界の外(=物理的に到達不可能)を指すことがあるため、
          // 境界内にクランプしておく。クランプしないと「あと少し」の距離が永遠に縮まらず
          // 見た目上フリーズしたようになる。
          destX = clamp(destX, BOUNDS.minX + 0.5, BOUNDS.maxX - 0.5);
          destZ = clamp(destZ, BOUNDS.minZ + 0.5, BOUNDS.maxZ - 0.5);

          const dd = dist2(u.x, u.z, destX, destZ);
          if (dd > 0.35) {
            // 経路探索(ダイクストラ)でウェイポイントを辿る。目的地が変わったときのみ再計算する。
            const destKey = `${Math.round(destX / 0.6)}_${Math.round(destZ / 0.6)}`;
            if (u.pathDestKey !== destKey) {
              const startIdx = nearestNavNode(u.x, u.z);
              const endIdx = nearestNavNode(destX, destZ);
              const reportsForPath = squadReports(st.squads[u.squadId]);
              const path = (startIdx >= 0 && endIdx >= 0) ? findPath(startIdx, endIdx, reportsForPath, st.expWeightByTeam[u.team]) : null;
              u.path = path ? path.map((i) => ({ x: NAV_GRID.nodes[i].x, z: NAV_GRID.nodes[i].z })) : null;
              u.pathIndex = 0;
              u.pathDestKey = destKey;
              // 経路が見つからない場合(壁際の到達不能ポケット等)、生の目的地に向かって
              // 直進させると壁にぶつかったまま動けなくなることがある。その場合は
              // 少なくとも壁の外にある最寄りのナビゲーションノードへ向かわせ、
              // 完全に静止してしまう事態を避ける。
              if (!u.path) {
                const fallbackIdx = endIdx >= 0 ? endIdx : startIdx;
                if (fallbackIdx >= 0) {
                  const n = NAV_GRID.nodes[fallbackIdx];
                  u.fallbackDest = { x: n.x, z: n.z };
                } else {
                  u.fallbackDest = null;
                }
              } else {
                u.fallbackDest = null;
              }
            }
            let mtx = destX, mtz = destZ;
            if (u.path && u.path.length) {
              while (u.pathIndex < u.path.length - 1 && dist2(u.x, u.z, u.path[u.pathIndex].x, u.path[u.pathIndex].z) < 1.0) u.pathIndex++;
              const wp = u.path[u.pathIndex];
              mtx = wp.x; mtz = wp.z;
              if (u.pathIndex === u.path.length - 1 && dist2(u.x, u.z, wp.x, wp.z) < 1.0) { mtx = destX; mtz = destZ; }
            } else if (u.fallbackDest) {
              mtx = u.fallbackDest.x; mtz = u.fallbackDest.z;
            }
            const stepDist = dist2(u.x, u.z, mtx, mtz);
            if (stepDist > 0.08) moveUnitSafe(u, (mtx - u.x) / stepDist, (mtz - u.z) / stepDist, MOVE_SPEED * speedMul, dt, aliveUnits);
          } else {
            pushOutOfWalls(u);
            u.path = null; u.pathDestKey = null; u.fallbackDest = null;
          }

          if (target) {
            u.fireCooldown -= dt;
            // 視界の中心(=照準)がほぼ正対していないと撃てない(FPS的な視界=射線)
            const angleToTarget = Math.atan2(target.x - u.x, target.z - u.z);
            let aimDiff = Math.abs(angleToTarget - u.angle);
            if (aimDiff > Math.PI) aimDiff = 2 * Math.PI - aimDiff;
            const aimed = aimDiff <= FIRE_ALIGN_RAD;
            if (aimed && u.fireCooldown <= 0 && canSee(u, target.x, target.z, DETECT_RANGE)) {
              const moving = (orderType === "move" || orderType === "maneuver" || orderType === "retreat" || orderType === "evade") && dd > 0.35;
              u.fireCooldown = rand(0.4, 0.75) * (moving ? 1.25 : 1);
              let hitChance = clamp(0.46 - bestDist * 0.018, 0.04, 0.46);
              if (moving) hitChance *= 0.5;
              const hit = Math.random() < hitChance;
              const def = TEAM_DEFS[u.team];
              const endX = hit ? target.x : target.x + rand(-1.4, 1.4);
              const endZ = hit ? target.z : target.z + rand(-1.4, 1.4);
              spawnTracer(u.x, u.z, endX, endZ, def.color);
              target.underFireUntil = st.simTime + TEAM_DEFS[target.team].underFireDuration;
              target.lastShotFrom = { x: u.x, z: u.z };
              registerReport(st.squads[target.squadId], u.id, u.x, u.z, st.simTime);
              if (hit) {
                target.alive = false;
                st.kills[u.team] += 1;
                // 死亡した敵の記憶(確度)は両陣営・全FTの記憶から即座に消す。
                // 生きている敵しか毎フレーム減衰処理されないため、消さないと確度が凍結して
                // 「もういない敵をずっと索敵し続ける」フリーズ状態になる。
                ALL_SQUAD_IDS.forEach((sid) => { delete st.squads[sid].memory[target.id]; });
              }
            }
          }
        });

        const aA = st.units.filter((u) => u.team === "A" && u.alive).length;
        const aB = st.units.filter((u) => u.team === "B" && u.alive).length;
        if ((aA === 0 || aB === 0) && !st.winner) {
          st.winner = aA === 0 && aB === 0 ? "draw" : aA === 0 ? "B" : "A";
        }

        // --- 占領エリアによる勝利判定 ---
        // マップ中心の円状エリアに「片方の陣営の生存者のみ」が滞在し続けた時間を計測する。
        // 敵味方どちらも侵入していない/両陣営とも侵入している(=係争中)場合は、
        // 連続占拠が途切れたとみなしてタイマーをリセットする。
        if (!st.winner) {
          const inZone = (u) => u.alive && dist2(u.x, u.z, ZONE_CENTER.x, ZONE_CENTER.z) <= ZONE_RADIUS;
          const aInZone = st.units.some((u) => u.team === "A" && inZone(u));
          const bInZone = st.units.some((u) => u.team === "B" && inZone(u));
          const controller = aInZone && !bInZone ? "A" : bInZone && !aInZone ? "B" : null;
          if (controller !== st.zoneControl.team) {
            st.zoneControl.team = controller;
            st.zoneControl.since = controller ? st.simTime : null;
          }
          if (controller && st.simTime - st.zoneControl.since >= ZONE_CAPTURE_DURATION) {
            st.winner = controller;
          }
        }
        setHud({
          aliveA: aA, aliveB: aB, killsA: st.kills.A, killsB: st.kills.B, winner: st.winner,
          modeA: SQUAD_IDS.A.map((sid) => st.squads[sid].mode),
          modeB: SQUAD_IDS.B.map((sid) => st.squads[sid].mode),
          roleA: SQUAD_IDS.A.map((sid) => st.squads[sid].role),
          roleB: SQUAD_IDS.B.map((sid) => st.squads[sid].role),
          zoneTeam: st.zoneControl.team,
          zoneElapsed: st.zoneControl.team ? st.simTime - st.zoneControl.since : 0,
        });
      }

      // --- 描画反映 ---
      st.units.forEach((u) => {
        const m = meshes[u.id];
        const isLeader = u.role === "leader";
        const isTeamLeader = st.teamLeader[u.team] === u.id;
        m.tri.visible = u.alive;
        m.vision.visible = u.alive && showVisionRef.current;
        m.leaderRing.visible = u.alive && isLeader;
        m.cmdRing.visible = u.alive && isTeamLeader;
        if (u.alive) {
          m.tri.position.set(u.x, 0.06, u.z);
          m.tri.rotation.y = u.angle;
          m.tri.scale.setScalar(isLeader ? 1.35 : 1);
          m.vision.position.set(u.x, 0.015, u.z);
          m.vision.rotation.y = u.angle;
          m.leaderRing.position.set(u.x, 0.03, u.z);
          m.cmdRing.position.set(u.x, 0.035, u.z);

          // 所属/指揮ライン: 隊員→自FTリーダー(実線)、FTリーダー→分隊長(点線)
          if (showAffRef.current) {
            if (!isLeader) {
              const ldr = st.units.find((o) => o.id === st.squads[u.squadId].leaderId);
              if (ldr && ldr.alive) {
                m.affLine.geometry.setFromPoints([new THREE.Vector3(u.x, 0.25, u.z), new THREE.Vector3(ldr.x, 0.25, ldr.z)]);
                m.affLine.visible = true;
              } else m.affLine.visible = false;
              m.cmdLine.visible = false;
            } else if (!isTeamLeader) {
              const tl = st.units.find((o) => o.id === st.teamLeader[u.team]);
              if (tl && tl.alive) {
                m.cmdLine.geometry.setFromPoints([new THREE.Vector3(u.x, 0.3, u.z), new THREE.Vector3(tl.x, 0.3, tl.z)]);
                m.cmdLine.computeLineDistances();
                m.cmdLine.visible = true;
              } else m.cmdLine.visible = false;
              m.affLine.visible = false;
            } else {
              m.affLine.visible = false; m.cmdLine.visible = false;
            }
          } else {
            m.affLine.visible = false; m.cmdLine.visible = false;
          }

          const target = u.targetId ? st.units.find((o) => o.id === u.targetId) : null;
          if (showLinesRef.current && target && target.alive) {
            m.targetLine.geometry.setFromPoints([new THREE.Vector3(u.x, 0.4, u.z), new THREE.Vector3(target.x, 0.4, target.z)]);
            m.targetLine.computeLineDistances();
            m.targetLine.visible = true;
          } else {
            m.targetLine.visible = false;
          }

          if (showOrdersRef.current && u.order && u.order.type !== "hold") {
            const ddo = dist2(u.x, u.z, u.order.dest.x, u.order.dest.z);
            if (ddo > 0.4) {
              m.orderLine.geometry.setFromPoints([new THREE.Vector3(u.x, 0.35, u.z), new THREE.Vector3(u.order.dest.x, 0.35, u.order.dest.z)]);
              m.orderLine.computeLineDistances();
              m.orderLine.material.color.setHex(ORDER_COLOR[u.order.type] || 0xffffff);
              m.orderLine.visible = true;
              m.orderMarker.position.set(u.order.dest.x, 0.03, u.order.dest.z);
              m.orderMarker.material.color.setHex(ORDER_COLOR[u.order.type] || 0xffffff);
              m.orderMarker.visible = true;
            } else { m.orderLine.visible = false; m.orderMarker.visible = false; }
          } else {
            m.orderLine.visible = false; m.orderMarker.visible = false;
          }

          if (showPathRef.current && u.path && u.path.length) {
            const pts = [new THREE.Vector3(u.x, 0.3, u.z)];
            for (let i = u.pathIndex; i < u.path.length; i++) pts.push(new THREE.Vector3(u.path[i].x, 0.3, u.path[i].z));
            m.pathLine.geometry.setFromPoints(pts);
            m.pathLine.computeLineDistances();
            m.pathLine.visible = true;
          } else {
            m.pathLine.visible = false;
          }
        } else {
          m.targetLine.visible = false; m.orderLine.visible = false; m.orderMarker.visible = false; m.pathLine.visible = false;
          m.affLine.visible = false; m.cmdLine.visible = false;
        }
      });

      tracerLines = tracerLines.filter((t) => {
        t.life -= rawDt;
        t.line.material.opacity = clamp(t.life / 0.12, 0, 1) * 0.9;
        if (t.life <= 0) { scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); return false; }
        return true;
      });

      renderer.render(scene, camera);
    };
    animate();

    // --- クリックで初期配置(スポーン地点)を選択する ---
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();
    const onPointerDown = (ev) => {
      const mode = placementModeRef.current;
      if (!mode) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointerNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      const hit = raycaster.intersectObject(ground, false)[0];
      if (!hit) return;
      if (mode === "ZONE") {
        ZONE_CENTER.x = clamp(hit.point.x, BOUNDS.minX + 4, BOUNDS.maxX - 4);
        ZONE_CENTER.z = clamp(hit.point.z, BOUNDS.minZ + 4, BOUNDS.maxZ - 4);
        controlRef.current.rebuildZoneMesh && controlRef.current.rebuildZoneMesh();
      } else {
        const x = clamp(hit.point.x, BOUNDS.minX + 6, BOUNDS.maxX - 6);
        const z = clamp(hit.point.z, BOUNDS.minZ + 6, BOUNDS.maxZ - 6);
        TEAM_DEFS[mode].spawn = { x, z };
      }
      // 各陣営の前進方向は「自陣スポーン→占領エリア中心」として組み直す。
      // 陣営・占領エリアのどちらを動かしても、常に占領エリアが目的地になるようにするため。
      ["A", "B"].forEach((team) => {
        const dx = ZONE_CENTER.x - TEAM_DEFS[team].spawn.x;
        const dz = ZONE_CENTER.z - TEAM_DEFS[team].spawn.z;
        const d = Math.hypot(dx, dz) || 1;
        TEAM_DEFS[team].advanceDir = { x: dx / d, z: dz / d };
      });
      setPlacementMode(null);
      controlRef.current.reset && controlRef.current.reset();
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const onResize = () => {
      const w2 = mount.clientWidth, h2 = mount.clientHeight;
      camera.left = -w2 / CAM_DIV; camera.right = w2 / CAM_DIV; camera.top = h2 / CAM_DIV; camera.bottom = -h2 / CAM_DIV;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="w-full h-full min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-800">
        <h1 className="text-base font-semibold">12人チーム(3ファイヤーチーム編成)同士 自動交戦サンプル(米軍ドクトリン風・視界=射線/チーム別性格パラメータ)</h1>
        <p className="text-xs text-gray-400 mt-1">各チームはFT1〜FT3(各4名、内部でさらに2名ずつのバディペアに分かれる)で構成。FTリーダーの1人が分隊長(チーム全体の指揮官)を兼任し、金色リング+線で指揮系統を表示。視界は正面100°の扇形、実射には正面±9°への正対が必要。</p>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div ref={mountRef} className="flex-1 relative">
          <div className="absolute top-3 left-3 flex gap-2 z-10">
            <button
              onClick={() => setPlacementMode(placementMode === "A" ? null : "A")}
              className={`px-2.5 py-1.5 rounded text-xs font-semibold border ${placementMode === "A" ? "bg-blue-500 border-blue-300 text-white" : "bg-gray-900/80 border-blue-400 text-blue-300"}`}
            >{placementMode === "A" ? "マップをクリックしてA配置..." : "Aの初期配置を選ぶ"}</button>
            <button
              onClick={() => setPlacementMode(placementMode === "B" ? null : "B")}
              className={`px-2.5 py-1.5 rounded text-xs font-semibold border ${placementMode === "B" ? "bg-red-500 border-red-300 text-white" : "bg-gray-900/80 border-red-400 text-red-300"}`}
            >{placementMode === "B" ? "マップをクリックしてB配置..." : "Bの初期配置を選ぶ"}</button>
            <button
              onClick={() => setPlacementMode(placementMode === "ZONE" ? null : "ZONE")}
              className={`px-2.5 py-1.5 rounded text-xs font-semibold border ${placementMode === "ZONE" ? "bg-yellow-500 border-yellow-300 text-gray-900" : "bg-gray-900/80 border-yellow-400 text-yellow-300"}`}
            >{placementMode === "ZONE" ? "マップをクリックして占領エリア配置..." : "占領エリアの位置を選ぶ"}</button>
          </div>
          {hud.winner && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <div className="bg-gray-900 border border-gray-700 rounded-lg px-6 py-4 text-center">
                <div className="text-lg font-semibold mb-1">
                  {hud.winner === "draw" ? "引き分け(相討ち)" : `${UNIT_LABEL[hud.winner]} の勝利`}
                </div>
                <div className="text-xs text-gray-400">生存 A:{hud.aliveA} / B:{hud.aliveB}</div>
              </div>
            </div>
          )}
        </div>

        <div className="w-80 border-l border-gray-800 bg-gray-900 overflow-y-auto p-3 space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-x-3">
            <div className="space-y-1">
              <div className="font-semibold text-blue-400">チームA <span className="text-gray-500 font-normal">({TEAM_DEFS.A.style})</span></div>
              <div>生存: <span className="font-semibold">{hud.aliveA}</span>/12 撃破: <span className="font-semibold">{hud.killsA}</span></div>
              {hud.modeA.map((mode, i) => (
                <div key={i} className="text-gray-400">
                  {FT_LABEL[i]}: {MODE_LABEL[mode]}
                  <span className={hud.roleA[i] === "DEFEND" ? "text-yellow-400 ml-1" : "text-gray-500 ml-1"}>[{hud.roleA[i] === "DEFEND" ? "防衛" : "攻撃"}]</span>
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <div className="font-semibold text-red-400">チームB <span className="text-gray-500 font-normal">({TEAM_DEFS.B.style})</span></div>
              <div>生存: <span className="font-semibold">{hud.aliveB}</span>/12 撃破: <span className="font-semibold">{hud.killsB}</span></div>
              {hud.modeB.map((mode, i) => (
                <div key={i} className="text-gray-400">
                  {FT_LABEL[i]}: {MODE_LABEL[mode]}
                  <span className={hud.roleB[i] === "DEFEND" ? "text-yellow-400 ml-1" : "text-gray-500 ml-1"}>[{hud.roleB[i] === "DEFEND" ? "防衛" : "攻撃"}]</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t border-gray-800">
            <div className="font-semibold mb-1">占領エリア(勝利条件)</div>
            {hud.zoneTeam ? (
              <div className={hud.zoneTeam === "A" ? "text-blue-300" : "text-red-300"}>
                {UNIT_LABEL[hud.zoneTeam]}が単独占拠中: {hud.zoneElapsed.toFixed(1)}s / {commonParams.captureDuration}s
              </div>
            ) : (
              <div className="text-gray-500">現在、単独占拠している陣営はありません</div>
            )}
          </div>

          <div className="pt-2 border-t border-gray-800 space-y-2.5">
            <div className="font-semibold">両陣営共通パラメータ</div>

            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>索敵距離(m)</span><span>{commonParams.detectRange}</span></div>
              <input type="range" min={5} max={40} step={1} value={commonParams.detectRange}
                onChange={(e) => updateCommonParam("detectRange", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>索敵範囲の角度(度、正面中心)</span><span>{commonParams.fovDeg}</span></div>
              <input type="range" min={30} max={200} step={5} value={commonParams.fovDeg}
                onChange={(e) => updateCommonParam("fovDeg", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>実射に必要な正対角度(度)</span><span>±{commonParams.fireAlignDeg}</span></div>
              <input type="range" min={2} max={45} step={1} value={commonParams.fireAlignDeg}
                onChange={(e) => updateCommonParam("fireAlignDeg", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>移動速度(m/s)</span><span>{commonParams.moveSpeed.toFixed(1)}</span></div>
              <input type="range" min={0.5} max={6} step={0.1} value={commonParams.moveSpeed}
                onChange={(e) => updateCommonParam("moveSpeed", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>旋回速度(度/秒)</span><span>{Math.round(commonParams.turnRateDeg)}</span></div>
              <input type="range" min={60} max={720} step={10} value={commonParams.turnRateDeg}
                onChange={(e) => updateCommonParam("turnRateDeg", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>索敵記憶の減衰速度(/秒、高いほど早く忘れる)</span><span>{commonParams.confidenceDecay.toFixed(2)}</span></div>
              <input type="range" min={0.02} max={0.5} step={0.01} value={commonParams.confidenceDecay}
                onChange={(e) => updateCommonParam("confidenceDecay", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>占領エリア半径(m)</span><span>{Math.round(commonParams.zoneRadius)}</span></div>
              <input type="range" min={5} max={60} step={1} value={commonParams.zoneRadius}
                onChange={(e) => updateCommonParam("zoneRadius", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
            <div>
              <div className="flex justify-between text-gray-300 mb-1"><span>占領に必要な連続確保時間(秒)</span><span>{commonParams.captureDuration}</span></div>
              <input type="range" min={3} max={60} step={1} value={commonParams.captureDuration}
                onChange={(e) => updateCommonParam("captureDuration", Number(e.target.value))} className="w-full accent-yellow-400" />
            </div>
          </div>

          <div className="pt-2 border-t border-gray-800 space-y-2.5">
            <div className="font-semibold">チーム別 性格パラメータ</div>

            <div>
              <div className="text-gray-400 mb-1">経路の遮蔽重視度(高いほど露出を避けたルートを選ぶ)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.expWeight.toFixed(1)}</span></div>
                  <input type="range" min={0} max={1} step={0.1} value={paramsA.expWeight}
                    onChange={(e) => updateParam("A", "expWeight", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.expWeight.toFixed(1)}</span></div>
                  <input type="range" min={0} max={1} step={0.1} value={paramsB.expWeight}
                    onChange={(e) => updateParam("B", "expWeight", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>

            <div>
              <div className="text-gray-400 mb-1">最小交戦距離(m)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.engageMin}</span></div>
                  <input type="range" min={3} max={16} step={1} value={paramsA.engageMin}
                    onChange={(e) => updateParam("A", "engageMin", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.engageMin}</span></div>
                  <input type="range" min={3} max={16} step={1} value={paramsB.engageMin}
                    onChange={(e) => updateParam("B", "engageMin", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>

            <div>
              <div className="text-gray-400 mb-1">最大交戦距離(m)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.engageMax}</span></div>
                  <input type="range" min={6} max={24} step={1} value={paramsA.engageMax}
                    onChange={(e) => updateParam("A", "engageMax", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.engageMax}</span></div>
                  <input type="range" min={6} max={24} step={1} value={paramsB.engageMax}
                    onChange={(e) => updateParam("B", "engageMax", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>

            <div>
              <div className="text-gray-400 mb-1">前進歩幅・最小(m)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.boundMinAdv}</span></div>
                  <input type="range" min={2} max={10} step={1} value={paramsA.boundMinAdv}
                    onChange={(e) => updateParam("A", "boundMinAdv", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.boundMinAdv}</span></div>
                  <input type="range" min={2} max={10} step={1} value={paramsB.boundMinAdv}
                    onChange={(e) => updateParam("B", "boundMinAdv", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>

            <div>
              <div className="text-gray-400 mb-1">前進歩幅・最大(m、大きいほど大胆)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.boundMaxAdv}</span></div>
                  <input type="range" min={4} max={18} step={1} value={paramsA.boundMaxAdv}
                    onChange={(e) => updateParam("A", "boundMaxAdv", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.boundMaxAdv}</span></div>
                  <input type="range" min={4} max={18} step={1} value={paramsB.boundMaxAdv}
                    onChange={(e) => updateParam("B", "boundMaxAdv", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>

            <div>
              <div className="text-gray-400 mb-1">劣勢許容(何人差まで戦い続けるか)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.fallbackDeficit}</span></div>
                  <input type="range" min={0} max={3} step={1} value={paramsA.fallbackDeficit}
                    onChange={(e) => updateParam("A", "fallbackDeficit", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.fallbackDeficit}</span></div>
                  <input type="range" min={0} max={3} step={1} value={paramsB.fallbackDeficit}
                    onChange={(e) => updateParam("B", "fallbackDeficit", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>

            <div>
              <div className="text-gray-400 mb-1">被弾時の警戒継続(秒、長いほど慎重)</div>
              <div className="grid grid-cols-2 gap-x-3">
                <div>
                  <div className="flex justify-between text-blue-300"><span>A</span><span>{paramsA.underFireDuration.toFixed(1)}</span></div>
                  <input type="range" min={0.5} max={5} step={0.1} value={paramsA.underFireDuration}
                    onChange={(e) => updateParam("A", "underFireDuration", Number(e.target.value))} className="w-full accent-blue-400" />
                </div>
                <div>
                  <div className="flex justify-between text-red-300"><span>B</span><span>{paramsB.underFireDuration.toFixed(1)}</span></div>
                  <input type="range" min={0.5} max={5} step={0.1} value={paramsB.underFireDuration}
                    onChange={(e) => updateParam("B", "underFireDuration", Number(e.target.value))} className="w-full accent-red-400" />
                </div>
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-gray-800 space-y-1.5">
            <div className="font-semibold">デバッグ表示</div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showVision} onChange={(e) => setShowVision(e.target.checked)} />
              <span>視界(扇形FOV)の可視化</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
              <span>射撃目標ラインの可視化</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showOrders} onChange={(e) => setShowOrders(e.target.checked)} />
              <span>リーダー命令(移動先)の可視化</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} />
              <span>経路(ダイクストラ探索)の可視化</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showAff} onChange={(e) => setShowAff(e.target.checked)} />
              <span>所属/指揮系統ライン(隊員→FTリーダー→分隊長)の可視化</span>
            </label>
          </div>

          <div className="pt-2 border-t border-gray-800 space-y-2">
            <div>
              <div className="flex justify-between mb-1"><span>速度</span><span className="text-gray-400">x{speed}</span></div>
              <input type="range" min={0.25} max={3} step={0.25} value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-amber-400" />
            </div>
            <button onClick={() => setRunning((r) => !r)} className="w-full bg-gray-800 hover:bg-gray-700 rounded px-2 py-1.5">
              {running ? "一時停止" : "再開"}
            </button>
            <button onClick={() => controlRef.current.reset?.()} className="w-full bg-gray-800 hover:bg-gray-700 rounded px-2 py-1.5">
              リセット(再戦)
            </button>
          </div>

          <div className="pt-2 border-t border-gray-800 space-y-1.5">
            <div className="font-semibold mb-1">凡例</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-blue-400 inline-block" style={{ clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)" }} />チームA(大きい三角+色リング=FTリーダー)</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-red-400 inline-block" style={{ clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)" }} />チームB(大きい三角+色リング=FTリーダー)</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-yellow-400 inline-block" />金色リング=分隊長(チーム全体の指揮官、FTリーダー1名が兼任)</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 bg-gray-300 inline-block" />所属ライン(実線): 隊員 → 自FTリーダー</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 border-t-2 border-dashed border-gray-300 inline-block" />指揮ライン(点線): FTリーダー → 分隊長</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-gray-400 inline-block" />視界(扇形FOV・正面100°/20m)</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 bg-gray-400 inline-block" />射撃目標ライン</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 bg-purple-400 inline-block" />命令ライン: 前進/機動</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 bg-amber-400 inline-block" />命令ライン: 制圧(遮蔽移動)</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 bg-cyan-400 inline-block" />命令ライン: 被弾直後の離脱 / 探索経路</div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5 bg-red-500 inline-block" />命令ライン: 後退</div>
          </div>
        </div>
      </div>
    </div>
  );
}
