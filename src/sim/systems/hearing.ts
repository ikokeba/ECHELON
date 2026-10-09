/**
 * 音による察知(`[v7.3]` ロードマップ A-5)。
 *
 * 銃声・爆発音は、見えていない敵について**「どこかから撃たれた」ことと、だいたいの方角**
 * だけを伝える。ここで作るのはその粗い接触で、見たものと同じ経路に乗る:
 *
 *   銃声 → 聞いたFTの記憶(memory) → 分隊長の像 → 無線で小隊長・中隊長へ(仕様 §5)
 *
 * 守っている一線(ロードマップ P1): 聞いた接触の位置は**聞いた者の位置から見た方角と、
 * 刻んだ距離の見積もり**から組み立てる。撃った者の位置をそのまま記憶に入れない。
 * 誰が撃ったかも記憶に入れない(キーは方角の区分で、兵士IDではない)。
 *
 * 強さ: 確度は最初から 0.5 未満(constants `HEARING.AGE_SEC` だけ前に見たのと同じ扱い)。
 * したがって CONTACT(0.85)にも、擲弾の照準(0.5)にも、迫撃砲の目標にもならない。
 * 効くのは、警戒の向き・移動技術(近くで銃声がすれば警戒前進に切り替わる)と、上への報告。
 * FTの掃討(SEARCH)は**見た**接触だけで起こす — 遠くの銃声のたびに持ち場を離れないように。
 *
 * 両軍で同じ(P2)、乱数を引かない(P3)。
 */

import { HEARING, SIM_HZ } from "../constants.ts";
import { decayedConfidence } from "../belief.ts";
import { hasLineOfSightIndexed } from "../wallIndex.ts";
import { isOffField } from "./litter.ts";
import type { Contact, Gunshot, Soldier } from "../types.ts";
import type { World } from "../world.ts";

const AGE_TICKS = Math.round(HEARING.AGE_SEC * SIM_HZ);
const SECTOR_RAD = (Math.PI * 2) / HEARING.BEARING_SECTORS;

/** 聞いた接触のキー。FTごと・方角の区分ごとに1件(同じ方角の銃声は1件にまとまる) */
export function heardKey(squadId: number, ftIndex: number, sector: number): string {
  return `h${squadId}.${ftIndex}.${sector}`;
}

/**
 * 足音(`[v7.3]`)。いま動いている者は、近く(`HEARING.FOOTSTEP`)なら壁越しにも気配が伝わる。
 * 扉の向こう・壁一枚隣の部屋の敵を「いる」とだけ知る(仕様 §7.6 の屋内の音)。
 * 銃声と同じ一覧に積むので、聞き方(方角と距離の丸め・弱い確度)はすべて同じになる
 */
function footsteps(world: World): Gunshot[] {
  const out: Gunshot[] = [];
  for (const s of world.soldiers) {
    if (s.status !== "ok" || isOffField(s)) continue;
    if (s.pathIdx >= s.path.length) continue;
    out.push({
      sourceId: s.id,
      side: s.side,
      pos: { x: s.pos.x, z: s.pos.z },
      range: HEARING.FOOTSTEP,
      footstep: true,
    });
  }
  return out;
}

export function hearingSystem(world: World): void {
  const sounds = [...world.gunshots, ...footsteps(world)];
  if (sounds.length === 0) return;

  for (const ft of world.fireteams) {
    const ears: Soldier[] = world.soldiers.filter(
      (s) =>
        s.side === ft.side &&
        s.squadId === ft.squadId &&
        s.fireteamId === ft.ftIndex &&
        s.status === "ok" &&
        !isOffField(s),
    );
    if (ears.length === 0) continue;

    for (const shot of sounds) {
      if (shot.side === ft.side) continue;
      // もう目で捉えている射手の銃声は、新しいことを何も教えない
      if (shot.sourceId >= 0) {
        const seen = ft.memory.get(`s${shot.sourceId}`);
        if (seen && !seen.heard && seen.confidence >= 0.5) continue;
      }

      // いちばん近くで聞こえた隊員を「聞いた者」とする。壁を挟むとくぐもって近くしか届かない
      let ear: Soldier | null = null;
      let earD = Infinity;
      for (const s of ears) {
        const d = Math.hypot(shot.pos.x - s.pos.x, shot.pos.z - s.pos.z);
        if (d > shot.range || d >= earD || d < 1e-6) continue;
        const clear = hasLineOfSightIndexed(
          world.wallIndex,
          s.pos.x,
          s.pos.z,
          shot.pos.x,
          shot.pos.z,
        );
        if (!clear && !shot.footstep && d > shot.range * HEARING.MUFFLED_MUL) continue;
        ear = s;
        earD = d;
      }
      if (!ear) continue;

      // 方角は区分の中心へ、距離は刻みへ丸める。ここが「粗さ」の実体
      const bearing = Math.atan2(shot.pos.z - ear.pos.z, shot.pos.x - ear.pos.x);
      const sector =
        ((Math.round(bearing / SECTOR_RAD) % HEARING.BEARING_SECTORS) + HEARING.BEARING_SECTORS) %
        HEARING.BEARING_SECTORS;
      const a = sector * SECTOR_RAD;
      const step = shot.footstep ? HEARING.FOOTSTEP_STEP : HEARING.RANGE_STEP;
      const est = Math.max(step, Math.round(earD / step) * step);
      const err = shot.footstep
        ? HEARING.FOOTSTEP_ERROR
        : Math.min(HEARING.ERROR_MAX, Math.max(HEARING.ERROR_MIN, est * HEARING.ERROR_PER_M));

      const key = heardKey(ft.squadId, ft.ftIndex, sector);
      const lastSeenTick = world.tick - AGE_TICKS;
      const pos = { x: ear.pos.x + Math.cos(a) * est, z: ear.pos.z + Math.sin(a) * est };
      const existing = ft.memory.get(key);
      if (existing) {
        existing.pos = pos;
        existing.lastSeenTick = lastSeenTick;
        existing.heardError = err;
        existing.posError = err;
      } else {
        const c: Contact = {
          key,
          side: shot.side,
          pos,
          posError: err,
          hopError: 0,
          heardError: err,
          lastSeenTick,
          confidence: decayedConfidence(HEARING.AGE_SEC),
          heard: true,
        };
        ft.memory.set(key, c);
      }
    }
  }
}
