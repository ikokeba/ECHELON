/**
 * 移動システム: 各兵士の現在の経路と命令の向きを消費し、位置と向きを1ティック分進める。
 * squad-12v12 / cqb-minimal の毎フレーム処理(turnToward + stepAlongPath + 壁クランプ)
 * からの移植。
 *
 * 制圧は移動を遅くしない(仕様 §8.6: ペナルティは命中率のみ)。
 * WIA/KIA の兵士は移動できない(仕様 §9)。
 */

import { advanceAlongPath } from "../pathfollow.ts";
import { angleOf, dirFromAngle, turnToward } from "../geometry.ts";
import { collidesWallIndexed, type WallIndex } from "../wallIndex.ts";
import { MG, SHIELD, SIM_DT, SIM_HZ, SOLDIER_RADIUS } from "../constants.ts";
import type { World } from "../world.ts";
import { stackPoint, turnMulOf } from "../shield.ts";
import { combatLook, standoffBlocks } from "../individual.ts";
import type { Soldier, Vec2 } from "../types.ts";

/**
 * 詰まりからの復帰(`[v6.4]`)。
 *
 * 「進もうとしているのに進めていない」が続いたら、まず現在のウェイポイントを諦め、
 * それでも駄目なら経路ごと捨てて張り直させる。ナビグリッドと身体半径の不整合
 * (constants の `CQB.NAV_MARGIN` 参照)は定数側で直したが、扉の開閉・遮蔽の
 * 出入りで一時的に通れない点が生じることは今後もありうる。**詰まったら必ず
 * 時間で抜ける**という保険をここに置く。
 */
/** これだけ動けなければ「進めていない」とみなす m/tick。歩速の約1割 */
const STUCK_EPS = 0.01;
/** ウェイポイントを1つ諦めるまでの連続ティック数(0.5秒) */
const STUCK_SKIP_TICKS = Math.round(SIM_HZ * 0.5);
/** 経路ごと捨てて張り直すまでの連続ティック数(1.5秒) */
const STUCK_REPATH_TICKS = Math.round(SIM_HZ * 1.5);

/**
 * 詰まりの計上と復帰。
 *
 * **「正味の前進」で測る版を実装して計測したが、こちらより悪かった**(停滞者
 * 13/20/24名 → 22/22/27名、掃討完了も減)。室内では1区間が1m未満しかないため、
 * 正味の移動量で測ると突入ドリルの最中まで詰まり扱いになる。単純な
 * 「このティックに動けたか」のほうが素直に効く。`[v6.4]`
 */
function accountStuck(s: Soldier, progressed: number): void {
  if (progressed > STUCK_EPS) {
    s.stuckTicks = 0;
    return;
  }
  s.stuckTicks += 1;
  if (s.stuckTicks >= STUCK_REPATH_TICKS) {
    // ウェイポイントを飛ばしても駄目だった。経路を捨てて張り直させる
    s.path = [];
    s.pathIdx = 0;
    s.stuckTicks = 0;
  } else if (s.stuckTicks % STUCK_SKIP_TICKS === 0) {
    // このウェイポイントには身体が入らない。次の点を目指す
    s.pathIdx += 1;
  }
}

function faceAngle(s: Soldier, angle: number): void {
  s.facing = dirFromAngle(angle);
}

function faceToward(s: Soldier, dir: Vec2 | null, maxTurn: number): void {
  if (!dir) return;
  faceAngle(s, turnToward(angleOf(s.facing), angleOf(dir), maxTurn));
}

/** `to` へ移動する。壁に当たる場合は壁沿いにスライドし、採用した位置を返す。 */
function moveWithWallSlide(idx: WallIndex, from: Vec2, to: Vec2): Vec2 {
  if (!collidesWallIndexed(idx, to.x, to.z, SOLDIER_RADIUS)) return to;
  const slideX = { x: to.x, z: from.z };
  if (!collidesWallIndexed(idx, slideX.x, slideX.z, SOLDIER_RADIUS)) return slideX;
  const slideZ = { x: from.x, z: to.z };
  if (!collidesWallIndexed(idx, slideZ.x, slideZ.z, SOLDIER_RADIUS)) return slideZ;
  return { ...from };
}

/**
 * 移動するかどうかは**命令の種類ではなく目的地の有無**で決まる。
 *
 * これはモックの挙動でもある: `suppress` 命令は「この射撃位置へ移動して制圧しろ」
 * という意味を持ちうるので、種類で移動を弾くと、割り当てられた射撃位置へ永久に
 * たどり着けなくなる(実際にそれで両軍が睨み合ったまま膠着する不具合を起こした)。
 * `hold` は常に目的地を持たないため、この規則だけで正しく静止する。
 */
function wantsToMove(s: Soldier): boolean {
  return s.order.target !== undefined && s.order.kind !== "follow";
}

export function movementSystem(world: World): void {
  // 旋回速度・基本移動速度は実行時チューニング可(`[v6.1]`)。既定は仕様定数と一致。
  const maxTurnBase = world.tuning.turnRate * SIM_DT;
  const baseStep = world.tuning.moveSpeed * SIM_DT;

  for (const s of world.soldiers) {
    if (s.status === "kia" || s.status === "wia") continue;

    // 速度の変調(担架搬送 0.5/0.85倍、室内進入 0.7倍、隊形Tier など)。
    // 変調をかけたシステムが解除の責任を持つ(constants の speedMul を参照)。
    // 機関銃射手は重火器のぶん恒常的に鈍い(`[v6.1]` §2)。
    // `[v7.0]` 盾持ちは盾の重さで鈍い。密集隊形の隊員はこの速さに合わせて追従する
    const roleMul =
      s.role === "mg" ? MG.MOVE_SPEED_MUL : s.role === "shield" ? SHIELD.MOVE_SPEED_MUL : 1;
    const maxStep = baseStep * s.speedMul * roleMul;
    // `[v7.1]` 盾持ちは旋回も遅い
    const maxTurn = maxTurnBase * turnMulOf(s);

    // 集合・追従(仕様 §6.5)は経路探索を通さず、隊形位置へ直接近づく。
    // 目標が毎ティック動くため、経路を張り直す方式では追従が破綻する
    // (0.5秒ごとの再探索で断続的にしか進めなくなる)。距離も数メートルなので、
    // 壁沿いのスライドだけで十分に自然な追従になる。
    // `[v7.1]` 隊形の基準の兵士に結びついた持ち場なら、その兵の**今の**位置と向きから
    // 持ち場を計算し直す(盾の密集隊形)。基準の兵が倒れたら最後の持ち場のまま
    if (s.order.kind === "follow" && s.order.anchor) {
      const a = world.soldierById.get(s.order.anchor.id);
      if (a && a.status === "ok") {
        s.order.target = stackPoint(a.pos, a.facing, s.order.anchor.lat, s.order.anchor.back);
      }
    }
    if (s.order.kind === "follow" && s.order.target) {
      const t = s.order.target;
      const dx = t.x - s.pos.x;
      const dz = t.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      // `[v6.4]` 直進で詰まった追従者には、経路要求システムが迂回路を渡してくる。
      // 屋内では隊形位置が内壁の向こう側に来ることがあり、直進だけだと壁を
      // 押し続けて永久に合流できない(4回目のテストプレイ指摘)。
      const detour = s.pathIdx < s.path.length;
      if (detour) {
        const step = advanceAlongPath(s.pos, s.path, s.pathIdx, maxStep);
        // `[v7.1]` 突撃でもないのに見えている敵へ寄る歩は踏まない(その場で撃ち合う)
        if (standoffBlocks(world, s, s.pos, step.pos)) {
          s.stuckTicks = 0;
          faceToward(s, combatLook(world, s), maxTurn);
          continue;
        }
        const accepted = moveWithWallSlide(world.wallIndex, s.pos, step.pos);
        s.pos = accepted;
        s.pathIdx = step.pathIdx;
        // 隊形位置の近くまで来たら迂回を畳んで通常の追従へ戻す
        if (step.arrived || d < 2) {
          s.path = [];
          s.pathIdx = 0;
          s.stuckTicks = 0;
        }
      } else if (d > 0.08) {
        const step = Math.min(d, maxStep);
        const to = { x: s.pos.x + (dx / d) * step, z: s.pos.z + (dz / d) * step };
        if (standoffBlocks(world, s, s.pos, to)) {
          s.stuckTicks = 0;
        } else {
          const accepted = moveWithWallSlide(world.wallIndex, s.pos, to);
          const progressed = Math.hypot(accepted.x - s.pos.x, accepted.z - s.pos.z);
          s.pos = accepted;
          accountStuck(s, progressed);
        }
      } else {
        s.stuckTicks = 0;
      }
      // 向きは見えている敵 → 撃ってきた方向 → 命令の監視方向 → 進行方向(`[v7.1]`)
      const look =
        combatLook(world, s) ?? (d > 1e-6 ? { x: dx / d, z: dz / d } : s.facing);
      faceAngle(s, turnToward(angleOf(s.facing), angleOf(look), maxTurn));
      continue;
    }

    if (wantsToMove(s) && s.pathIdx < s.path.length) {
      const step = advanceAlongPath(s.pos, s.path, s.pathIdx, maxStep);
      // `[v7.1]` 突撃でもないのに見えている敵へ寄る歩は踏まない(その場で撃ち合う)
      if (standoffBlocks(world, s, s.pos, step.pos)) {
        s.stuckTicks = 0;
        faceToward(s, combatLook(world, s), maxTurn);
        continue;
      }
      const accepted = moveWithWallSlide(world.wallIndex, s.pos, step.pos);
      const progressed = Math.hypot(accepted.x - s.pos.x, accepted.z - s.pos.z);
      s.pos = accepted;
      s.pathIdx = step.pathIdx;
      // `[v7.1]` 歩く向きと見る向きを分ける(個人の戦闘動作、individual.ts)。
      // 見えている敵 → 撃ってきた方向 → 命令の警戒方向。どれも無ければ進行方向。
      // 盾持ち(`[v7.0]`)も同じ規則で、盾を向けるべき方向を向いたまま横歩き・後ずさりする
      const lookDir = combatLook(world, s) ?? step.dir;
      if (lookDir) {
        const cur = angleOf(s.facing);
        faceAngle(s, turnToward(cur, angleOf(lookDir), maxTurn));
      }
      if (step.arrived) {
        s.path = [];
        s.pathIdx = 0;
        s.stuckTicks = 0;
      } else {
        accountStuck(s, progressed);
      }
    } else if (s.sees.length > 0) {
      // 止まっていて敵が見えている: 照準は戦闘系(combat.ts)が合わせる。ここで回すと二重に回る
      s.stuckTicks = 0;
    } else if (s.order.facing || s.alertUntilTick > world.tick) {
      s.stuckTicks = 0;
      faceToward(s, combatLook(world, s) ?? s.order.facing ?? null, maxTurn);
    } else {
      s.stuckTicks = 0;
    }
  }
}
