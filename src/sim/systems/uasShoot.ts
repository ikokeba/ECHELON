/**
 * ドローンの撃墜(`[v7.5]` ロードマップ A-10、設計メモ §6.3)。
 *
 * それまでドローンは無敵で、落ちるのは操縦手が倒れたときだけだった。ここで、ドローンを
 * **目で捉えている**兵士(S-6 の `seesUas`)が撃ち落とせるようにする。米陸軍 ATP 3-01.81 の
 * 能動的な対策にあたる。
 *
 *   - 小銃: `UAS_SHOOT.RIFLE_RANGE` m 以内で、毎秒 `RIFLE_RATE` の低い確率
 *   - 対ドローン装備(散弾銃など、編成の特技トグル): `KIT_RANGE` m 以内で、毎秒 `KIT_RATE`
 *   - **撃てば銃声で位置が知られる**(音による察知 A-5 にそのまま乗る)。隠れるか撃つかの判断になる
 *
 * 誰が撃つか(AIの判断。人間が座っている兵士も、交戦と同じく自動で撃つ):
 *   - 隠蔽行動(S-7)を取っている分隊の者は撃たない — 撃てば隠れた意味が無くなる
 *   - 対ドローン装備の持ち主は撃つ
 *   - それ以外は、陣地(射撃壕・窓・機関銃陣地・前進陣地・待ち伏せ)に就いている防御側だけが撃つ。
 *     敵兵が見えている間は敵兵を撃つほうが先
 *   - 制圧されている者・潰走している者は撃たない
 *
 * 落ちたドローンは `lost`(`shotDown` が立つ)。乱数は撃つ側の陣営の乱数列から引く(P3)。
 * 陣営で分岐しない(P2)。
 */

import { FPV, HEARING, SIM_DT, TRACER_EVERY_TICKS, UAS_SHOOT } from "../constants.ts";
import { chance, ratePerTick } from "../rng.ts";
import { onPost } from "../c2/uasReact.ts";
import { airborne } from "./uasDetect.ts";
import { isOffField } from "./litter.ts";
import type { Drone, Soldier } from "../types.ts";
import type { World } from "../world.ts";

/** その兵士がそのドローンを撃つなら毎秒の撃墜確率、撃たないなら 0 */
export function shootRate(world: World, s: Soldier, d: Drone): number {
  if (s.status !== "ok" || s.routed || isOffField(s)) return 0;
  if (s.suppressedUntilTick > world.tick) return 0;
  if (!s.seesUas?.includes(d.id)) return 0;
  const sq = world.squads.find((q) => q.side === s.side && q.squadId === s.squadId);
  if (sq?.uasReact) return 0;
  // 斜めの距離(ドローンは高さ `ALTITUDE` を飛んでいる)
  const r = Math.hypot(d.pos.x - s.pos.x, d.pos.z - s.pos.z, UAS_SHOOT.ALTITUDE);
  const kit = s.quals.counterUas === true;
  // `[v7.7]` 自爆ドローン(B-2)は速くて小さいので当たりにくい
  const mul = d.kind === "fpv" ? FPV.SHOOT_MUL : 1;
  if (kit && r <= UAS_SHOOT.KIT_RANGE) return UAS_SHOOT.KIT_RATE * mul;
  if (r > UAS_SHOOT.RIFLE_RANGE) return 0;
  if (kit) return UAS_SHOOT.RIFLE_RATE * mul;
  // 装備の無い者は、陣地に就いている防御側だけ。敵兵が見えていればそちらが先。
  // `[v7.7]` ただし自分の分隊へ向かってくる自爆ドローンは誰でも撃つ(撃たなければ当たる)
  if (s.sees.length > 0 && d.kind !== "fpv") return 0;
  const posted = s.atWindow || (sq !== undefined && onPost(world, sq));
  return posted || d.kind === "fpv" ? UAS_SHOOT.RIFLE_RATE * mul : 0;
}

/** 毎ティック: ドローンを捉えている兵士が撃つ。戦闘の判定のあと、音の前に呼ぶ(銃声が聞こえる) */
export function uasShootSystem(world: World): void {
  const flying = world.drones.filter(airborne);
  if (flying.length === 0) return;
  for (const s of world.soldiers) {
    if (!s.seesUas || s.seesUas.length === 0) continue;
    for (const d of flying) {
      if (d.side === s.side || !airborne(d)) continue;
      const rate = shootRate(world, s, d);
      if (rate <= 0) continue;
      const hit = chance(world.rngBySide[s.side], ratePerTick(rate, SIM_DT));
      // 撃った音は、撃った者の位置から鳴る(A-5)
      world.gunshots.push({
        sourceId: s.id,
        side: s.side,
        pos: { x: s.pos.x, z: s.pos.z },
        range: HEARING.RANGE.rifle,
      });
      if (hit || (world.tick + s.ordinal) % TRACER_EVERY_TICKS.rifle === 0) {
        world.fx.push({
          kind: "shot",
          from: { x: s.pos.x, z: s.pos.z },
          to: { x: d.pos.x, z: d.pos.z },
          side: s.side,
          hit,
          shooterId: s.id,
          targetId: -1,
          // `[v7.6]` 対ドローン装備で撃った弾は色を分ける(描画専用)。装備の距離の外は小銃
          weapon: s.quals.counterUas && Math.hypot(d.pos.x - s.pos.x, d.pos.z - s.pos.z, UAS_SHOOT.ALTITUDE) <= UAS_SHOOT.KIT_RANGE ? "cuas" : "rifle",
        });
      }
      if (hit) {
        d.state = "lost";
        d.stateTick = world.tick;
        d.target = null;
        d.shotDown = true;
      }
      break; // 1ティックに撃つのは1機だけ
    }
  }
}
