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
import { isCommittedToAid } from "../systems/casualties.ts";
import { isCommittedToLitter } from "../systems/litter.ts";
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

  // 突入に参加できる隊員だけを数える。応急手当や担架搬送に就いている隊員は
  // 命令系統の外側で拘束されていて(仕様 §9)、こちらから動かせない。
  // 彼らを待つと、負傷者が1名出ただけでドリルが永久に完了しなくなる(実装で確認した)。
  const available = living.filter(
    (u) => !isCommittedToAid(world, u) && !isCommittedToLitter(u),
  );
  if (available.length === 0) return;

  // 突入順はスタック順に固定する(仕様 §7.3 の積み残し課題として明記済み)。
  // 一度決めたら段階をまたいで保持する — 途中で並び替えると流入間隔が壊れる。
  if (ft.cqbEntryOrder.length === 0) {
    // `[v7.0]` 盾持ちがいれば先頭に立てる(盾を先に入れて、後続はその陰で流入する)。
    // 安定ソートなので、盾持ち以外の並びは従来どおり
    ft.cqbEntryOrder = [...available]
      .sort((a, b) => (b.role === "shield" ? 1 : 0) - (a.role === "shield" ? 1 : 0))
      .map((u) => u.id);
  }
  const ordered = ft.cqbEntryOrder
    .map((id) => available.find((u) => u.id === id))
    .filter((u): u is Soldier => u !== undefined);
  const team = ordered.length > 0 ? ordered : available;

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
      // 時間切れでも必ず次の段階へ進める。到達不能な扉に張り付いて分隊が丸ごと
      // 戦闘から消えるのが最悪の失敗なので、ここで「諦めて立て直す」分岐は作らない
      // (`[v6.2]` に一度入れて、突入が abandon→再選択 のループに落ちるのを確認した)。
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
      // FTはCQBモードを抜けて通常の命令系統へ戻る。
      //
      // **掃討完了を分隊長へ明示的に伝える**のが要点。CQBモードを抜けたこと自体を
      // 完了と見なすと、途中でFALLBACKに落ちて中断した場合まで「掃討済み」に
      // なってしまい、二度とその部屋を攻略できなくなる(実装して確認した)。
      const sq = world.squads.find((s) => s.side === ft.side && s.squadId === ft.squadId);
      if (sq) {
        if (!sq.clearedDoorIds.includes(door.id)) sq.clearedDoorIds.push(door.id);
        if (sq.assaultDoorId === door.id) sq.assaultDoorId = null;
      }
      exitCqb(ft);
      return;
    }
  }
}
