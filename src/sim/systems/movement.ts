/**
 * 移動システム: 各兵士の現在の経路と命令の向きを消費し、位置と向きを1ティック分進める。
 * squad-12v12 / cqb-minimal の毎フレーム処理(turnToward + stepAlongPath + 壁クランプ)
 * からの移植。
 *
 * 制圧は移動を遅くしない(仕様 §8.6: ペナルティは命中率のみ)。
 * WIA/KIA の兵士は移動できない(仕様 §9)。
 */

import { advanceAlongPath } from "../pathfollow.ts";
import { collidesWall } from "../geometry.ts";
import { MOVE_SPEED, SIM_DT, SOLDIER_RADIUS, TURN_RATE } from "../constants.ts";
import type { World } from "../world.ts";
import type { Soldier, Vec2 } from "../types.ts";

function angleOf(v: Vec2): number {
  return Math.atan2(v.x, v.z);
}

function turnToward(current: number, target: number, maxDelta: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

function faceAngle(s: Soldier, angle: number): void {
  s.facing = { x: Math.sin(angle), z: Math.cos(angle) };
}

/** `to` へ移動する。壁に当たる場合は壁沿いにスライドし、採用した位置を返す。 */
function moveWithWallSlide(walls: World["walls"], from: Vec2, to: Vec2): Vec2 {
  if (!collidesWall(walls, to.x, to.z, SOLDIER_RADIUS)) return to;
  const slideX = { x: to.x, z: from.z };
  if (!collidesWall(walls, slideX.x, slideX.z, SOLDIER_RADIUS)) return slideX;
  const slideZ = { x: from.x, z: to.z };
  if (!collidesWall(walls, slideZ.x, slideZ.z, SOLDIER_RADIUS)) return slideZ;
  return { ...from };
}

const MOVING_ORDERS = new Set(["move", "maneuver", "retreat", "evade"]);

export function movementSystem(world: World): void {
  const maxTurn = TURN_RATE * SIM_DT;
  const maxStep = MOVE_SPEED * SIM_DT;

  for (const s of world.soldiers) {
    if (s.status === "kia" || s.status === "wia") continue;

    if (MOVING_ORDERS.has(s.order.kind) && s.pathIdx < s.path.length) {
      const step = advanceAlongPath(s.pos, s.path, s.pathIdx, maxStep);
      const accepted = moveWithWallSlide(world.walls, s.pos, step.pos);
      s.pos = accepted;
      s.pathIdx = step.pathIdx;
      if (step.dir) {
        const cur = angleOf(s.facing);
        faceAngle(s, turnToward(cur, angleOf(step.dir), maxTurn));
      }
      if (step.arrived) {
        s.path = [];
        s.pathIdx = 0;
      }
    } else if (s.order.facing) {
      const cur = angleOf(s.facing);
      faceAngle(s, turnToward(cur, angleOf(s.order.facing), maxTurn));
    }
  }
}
