/**
 * 機関銃(班で扱う火器)の射手の交代(`[v7.6]` プレイでの指摘「固定機銃は射手がやられたら
 * 近くの人が変わってほしい。ドクトリンに基づいてほしい」)。
 *
 * それまで機関銃は**射手(role `mg`)という個人の持ち物**だった。射手が倒れると、陣地には
 * 副射手が就くものの(c2/defense.ts)、持っているのは小銃のままで、機関銃は射手と一緒に
 * 消えていた。
 *
 * 米軍の機関銃班(ATP 3-21.8 の小隊の火器分隊、FM 3-22.68 の機関銃の運用)は3名で1丁を扱い、
 * 役割は交代できるように訓練されている:
 *
 *   - 射手(gunner)が倒れたら、**副射手(assistant gunner)が銃に就いて撃ち続ける**
 *   - 副射手も倒れていれば、**弾薬手(ammunition bearer)** が就く
 *   - 班の全員が倒れても、陣地に据えた銃は残る。**分隊長・小隊長は近くの小銃手を銃に就かせ、
 *     班で扱う火器を最後まで撃ち続けさせる**(火器は小隊の火力の骨格なので、優先して生かす)
 *
 * ここではそれを次の規則にした:
 *
 *   1. 射手が戦えなくなったら(負傷・戦死・後送)、同じ班(同じ分隊・同じFT)の戦える隊員の
 *      うち、倒れた射手に最も近い者が銃を受け継ぐ(班は副射手・弾薬手の並びなので、
 *      近い順 = 副射手が先、になる)。届く距離は `CREW_SERVED.TAKEOVER_RANGE`
 *   2. 班に受け継げる者がいなくても、**倒れた射手が機関銃陣地(S-1)にいた**なら、同じ小隊の
 *      近くの小銃手(指揮官・特技の資格者を除く)が陣地の銃に就く。その兵は機関銃班へ編入される
 *      (以後は陣地の班として動く)。届く距離は `CREW_SERVED.POST_REPLACE_RANGE`
 *   3. 受け継いだ者は、銃を構え直すあいだ `CREW_SERVED.TAKEOVER_SEC` 秒は撃たない
 *
 * 受け継ぐ者がいなければ、倒れた射手が銃を持ったまま(役職は `mg` のまま)になる。
 * 判断の材料は自分の班・小隊の隊員の状態と位置だけ(P1)。陣営で分岐しない(P2)。乱数は引かない(P3)。
 * 人間が一兵卒として座っている兵士は選ばない(自分の足で動いている人を勝手に銃に就けない)。
 */

import { CREW_SERVED, SIM_HZ } from "../constants.ts";
import { soldierSeated } from "../control.ts";
import { isOffField } from "./litter.ts";
import type { Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

const TAKEOVER_TICKS = Math.round(CREW_SERVED.TAKEOVER_SEC * SIM_HZ);

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 銃を受け継げる状態か(戦える・盤上にいる・担架や手当に手を取られていない・人間が座っていない) */
function canTakeOver(world: World, s: Soldier): boolean {
  return (
    s.status === "ok" &&
    !isOffField(s) &&
    !s.routed &&
    s.bearing === null &&
    s.treating === null &&
    s.role !== "mg" &&
    !soldierSeated(world, s)
  );
}

/** 陣地の外から銃に就ける小銃手か(指揮官・特技の資格者・本部要員は除く) */
function plainRifleman(s: Soldier): boolean {
  return (
    s.role === "rifleman" &&
    s.hqRole === null &&
    !s.isSquadLeader &&
    !s.isFireteamLeader &&
    !s.quals.designatedMarksman &&
    !s.quals.antiArmor &&
    !s.quals.droneOperator &&
    !s.quals.counterUas
  );
}

/** 近い順(同じ距離なら編成上の通し番号の順 — 鏡像の2人が同じ者を選ぶ) */
function nearest(cands: Soldier[], at: Vec2): Soldier | null {
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    const d = dist(c.pos, at);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && c.ordinal < best.ordinal)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** その射手が就いていた機関銃陣地(陣地の位置の近くで倒れたときだけ) */
function postOfGunner(world: World, g: Soldier): { pos: Vec2 } | null {
  for (const p of world.defense) {
    if (p.side !== g.side || p.kind !== "mg" || !p.crew) continue;
    if (p.crew.squadId !== g.squadId || p.crew.ftIndex !== g.fireteamId) continue;
    if (dist(p.pos, g.pos) <= CREW_SERVED.POST_RADIUS) return p;
  }
  return null;
}

/**
 * 毎ティック: 倒れた射手の機関銃を、受け継げる者へ渡す。死傷の処理のあとに呼ぶ
 * (このティックに倒れた射手の銃を、このティックのうちに受け継ぐ)
 */
export function crewServedSystem(world: World): void {
  if (world.phase !== "battle") return;
  for (const g of world.soldiers) {
    if (g.role !== "mg") continue;
    if (g.status === "ok" && !isOffField(g)) continue;

    // 1. 同じ班(副射手・弾薬手)から
    const crew = world.soldiers.filter(
      (s) =>
        s.side === g.side &&
        s.squadId === g.squadId &&
        s.fireteamId === g.fireteamId &&
        s.id !== g.id &&
        canTakeOver(world, s) &&
        dist(s.pos, g.pos) <= CREW_SERVED.TAKEOVER_RANGE,
    );
    let succ = nearest(crew, g.pos);

    // 2. 陣地の銃なら、同じ小隊の近くの小銃手から
    if (!succ) {
      const post = postOfGunner(world, g);
      if (post) {
        const near = world.soldiers.filter(
          (s) =>
            s.side === g.side &&
            s.platoonId === g.platoonId &&
            s.squadId >= 0 &&
            s.id !== g.id &&
            plainRifleman(s) &&
            canTakeOver(world, s) &&
            dist(s.pos, post.pos) <= CREW_SERVED.POST_REPLACE_RANGE,
        );
        succ = nearest(near, post.pos);
        if (succ) {
          // 機関銃班へ編入する。以後は陣地の班として defenseSystem が動かす
          succ.squadId = g.squadId;
          succ.fireteamId = g.fireteamId;
          succ.isFireteamLeader = false;
          succ.assignedTarget = null;
        }
      }
    }
    if (!succ) continue;

    succ.role = "mg";
    g.role = "rifleman";
    // 銃を構え直すあいだは自分から撃たない(受け身の処理 — 撃たれる・制圧される — は通常どおり)
    succ.weaponReadyTick = world.tick + TAKEOVER_TICKS;
  }
}
