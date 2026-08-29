/**
 * 屋内戦闘ドクトリン(仕様 §7.2 の Battle Drill 6、§7.3 の突入待機命令)。
 *
 * 担当階層の分担は仕様どおり:
 *
 * | 段階 | 担当 | ここでの実装 |
 * |---|---|---|
 * | 孤立化 | 分隊長 | 支援組を扉の射線が通る位置へ置く(c2/squad.ts) |
 * | 支援射撃 | 分隊長 | 支援FTに `assignedRole: "base"` を与える(c2/squad.ts) |
 * | 突撃・突入 | FTリーダー | 本モジュール: スタック → ブリーチ |
 * | 室内掃討 | FTリーダー〜一兵卒 | 本モジュール: コーナー確保と扇形索敵 |
 * | 再編成 | 分隊長 | 本モジュール終了後、CQBモードを抜けて通常のC2へ戻る |
 *
 * **小隊長は建物単位の指揮に介在しない**(仕様 §7.2)。小隊長は複数の建物・目標を
 * 同時に指揮する立場に専念する。
 */

import { CQB, ENTRY_SPEED_MUL, SIM_HZ } from "../constants.ts";
import { cornerAssignments, doorById, insideBounds, nudgeInside, roomOfDoor } from "../cqb.ts";
import { refreshBlockers, type World } from "../world.ts";
import { stackPositions } from "../cqb.ts";
import type { FireteamState, Soldier, Vec2 } from "../types.ts";

const ENTRY_STAGGER_TICKS = Math.round(CQB.ENTRY_STAGGER_SEC * SIM_HZ);
const STAGE_TIMEOUT_TICKS = Math.round(CQB.STAGE_TIMEOUT_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function setStage(ft: FireteamState, stage: FireteamState["cqbStage"], tick: number): void {
  ft.cqbStage = stage;
  ft.cqbStageSince = tick;
}

/** CQBを打ち切って通常のC2へ戻す(再編成、仕様 §7.2)。 */
export function exitCqb(ft: FireteamState): void {
  ft.cqbDoorId = null;
  ft.cqbStage = "stack";
  ft.cqbCorner.clear();
  ft.cqbEntryOrder = [];
}

/**
 * CQBモードの1ステップ。`issue` は c2/fireteam.ts の命令発行関数をそのまま受け取る
 * (応急手当・担架搬送による拘束の判定を共有するため)。
 */
export function runCqb(
  world: World,
  ft: FireteamState,
  living: Soldier[],
  issue: (u: Soldier, kind: Soldier["order"]["kind"], target: Vec2 | null, look: Vec2) => void,
): void {
  if (ft.cqbDoorId === null || living.length === 0) return;
  const door = doorById(world.buildings, ft.cqbDoorId);
  const room = door ? roomOfDoor(world.buildings, door) : null;
  if (!door || !room) {
    exitCqb(ft);
    return;
  }

  // 突入順はスタック順に固定する(仕様 §7.3 の積み残し課題として明記済み)。
  // 一度決めたら段階をまたいで保持する — 途中で並び替えると流入間隔が壊れる。
  if (ft.cqbEntryOrder.length === 0) {
    ft.cqbEntryOrder = living.map((u) => u.id);
  }
  const ordered = ft.cqbEntryOrder
    .map((id) => living.find((u) => u.id === id))
    .filter((u): u is Soldier => u !== undefined);
  const team = ordered.length > 0 ? ordered : living;

  // どの段階でも詰まったままにはしない。到達不能な扉に張り付いて分隊が
  // 丸ごと戦闘から消えるのが最悪の失敗なので、時間で必ず抜ける
  const stuck = world.tick - ft.cqbStageSince > STAGE_TIMEOUT_TICKS;

  switch (ft.cqbStage) {
    case "stack": {
      // ① スタック形成: 扉から1.5m以内へ、壁沿いに縦列で(仕様 §7.3)
      const slots = stackPositions(door, team.length);
      let allSet = true;
      team.forEach((u, i) => {
        const slot = slots[i]!;
        if (dist(u.pos, slot) > CQB.STACK_ARRIVE) allSet = false;
        issue(u, "move", slot, door.normal);
      });
      if (allSet || stuck) {
        // ② ブリーチ: 扉が開く。この瞬間から室内が見えるようになる(仕様 §7.6)
        if (!door.open) {
          door.open = true;
          refreshBlockers(world);
        }
        const corners = cornerAssignments(room, door);
        team.forEach((u, i) => {
          const c = corners[i % corners.length]!;
          ft.cqbCorner.set(u.id, nudgeInside(world.walls, c.pos, room));
        });
        setStage(ft, "breach", world.tick);
      }
      return;
    }

    case "breach": {
      // ② 単一ファイルでの流入。0.6秒間隔で1名ずつ動き出す(仕様 §7.3)。
      // 4名が同時に扉へ殺到する挙動はプロトタイプで確認済みの失敗パターン。
      let allInside = true;
      team.forEach((u, i) => {
        const releaseTick = ft.cqbStageSince + i * ENTRY_STAGGER_TICKS;
        const corner = ft.cqbCorner.get(u.id);
        if (!corner) return;
        if (world.tick < releaseTick) {
          allInside = false;
          issue(u, "hold", null, door.normal);
          return;
        }
        issue(u, "move", corner, door.normal);
        // 進入時は速度を落として制御を優先する(仕様 §7 — 0.7倍)
        u.speedMul = ENTRY_SPEED_MUL;
        if (!insideBounds(room.bounds, u.pos)) allInside = false;
      });
      if (allInside || stuck) setStage(ft, "clear", world.tick);
      return;
    }

    case "clear": {
      // ③ 室内クリアリング: 各自が担当コーナーで90°の扇形を見る(仕様 §7.3)
      const corners = cornerAssignments(room, door);
      let allSet = true;
      team.forEach((u, i) => {
        const corner = ft.cqbCorner.get(u.id);
        const facing = corners[i % corners.length]!.facing;
        if (!corner) return;
        if (dist(u.pos, corner) > CQB.CORNER_ARRIVE) {
          allSet = false;
          issue(u, "move", corner, facing);
          u.speedMul = ENTRY_SPEED_MUL;
        } else {
          issue(u, "hold", null, facing);
        }
      });
      // 室内に把握している敵が残っている間は掃討を続ける
      const threatInRoom = [...ft.memory.values()].some(
        (c) => c.confidence > 0.3 && insideBounds(room.bounds, c.pos),
      );
      if ((allSet && !threatInRoom) || stuck) setStage(ft, "reorg", world.tick);
      return;
    }

    case "reorg": {
      // 再編成。次の部屋/建物への行動判断は分隊長の責務(仕様 §7.2)なので、
      // FTはCQBモードを抜けて通常の命令系統へ戻る
      exitCqb(ft);
      return;
    }
  }
}
