/**
 * 死傷の進行(仕様 §9): 未処置の WIA 兵士は、45秒の出血タイマーが尽きると KIA へ移行する。
 *
 * バディエイド(応急手当)はまだここに実装していない。処置時間のモデルは `[v6]` で
 * FT単位MOS 2段階(通常3秒/衛生兼任1.5秒)に確定したので実装可能になったが、
 * CASEVAC 一式はスライス11でまとめて入れる。
 */

import type { World } from "../world.ts";

export function casualtiesSystem(world: World): void {
  for (const s of world.soldiers) {
    if (s.status === "wia" && s.bleedOutTick > 0 && world.tick >= s.bleedOutTick) {
      s.status = "kia";
      s.bleedOutTick = 0;
    }
  }
}
