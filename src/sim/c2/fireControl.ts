/**
 * 火力の統制と配分(fire control / fire distribution、米軍 ATP 3-21.8)。`[v6.3]`
 *
 * 3回目のテストプレイ指摘「実際の戦闘では、分隊長またはリーダーが各メンバーが狙う
 * ターゲットを指定するのでは?」への実装。従来は各兵士が独立に**最寄りの敵**を撃って
 * いたため、全員が同じ敵に集中する一方で他の敵は誰にも撃たれない、という状態が同時に
 * 起きていた。
 *
 * ドクトリンが求めるのは2つ:
 *   - **配分(distribution)**: 敵の隊形**全体**を覆う。一点集中させない
 *   - **優先目標**: 重火器(機関銃・自動火器)と指揮官・無線手を先に潰す
 *
 * 情報源はFT隊員が**実際に見ている**敵だけ(仕様 §5: 生の視界は分隊長まで)。
 * belief 経由の古い接触に射撃を割り当てることはしない — 見えない敵は撃てない。
 *
 * 陣営を見る分岐は無い(仕様 §2/§13)。
 */

import type { Soldier } from "../types.ts";
import type { World } from "../world.ts";

/**
 * 目標としての優先度。大きいほど先に潰す。
 *
 * 重火器 > 選抜射手 > 指揮官 > その他。仕様 §14 が戦闘効果を与えているのは SAW と
 * 機関銃で、指揮官は §12 の指揮系統崩壊に効く。どちらも「先に消すと相手の戦闘力が
 * 大きく落ちる」という点で優先目標の定義に合致する。
 *
 * `[v6.4]` **敵の選抜射手を優先目標に加えた**。4回目のテストプレイで
 * 「敵のマークスマンが見つかった場合、自陣のマークスマンをそこに割り当てたりするか」
 * と問われた点への答え。ドクトリン(ATP 3-21.8 の火力の統制、ADDRAC)では、
 * 対抗手段は**特定の個人を指名して差し向けること**ではなく、
 * 「見えている優先目標として全員の射撃配分に載せる」ことである。中隊長・小隊長が
 * 個々の射手を敵の射手へ割り当てる階層ではない(彼らが動かすのは担当区域と任務)。
 * 選抜射手は §10 の長射程と §8.6 の制圧耐性を持つため、放置すると損害が積み上がる。
 */
function priorityOf(t: Soldier): number {
  if (t.role === "mg") return 3;
  if (t.quals.designatedMarksman) return 3;
  if (t.role === "saw") return 2;
  if (t.isSquadLeader || t.isFireteamLeader || t.hqRole !== null) return 1;
  return 0;
}

function dist2(a: Soldier, b: Soldier): number {
  const dx = a.pos.x - b.pos.x;
  const dz = a.pos.z - b.pos.z;
  return dx * dx + dz * dz;
}

/**
 * FTリーダーが麾下の射撃目標を割り当てる。
 *
 * 手順(ドクトリンの射撃命令をそのまま手続きにしたもの):
 *   1. FT全員の視界を合わせて、いま撃てる敵の一覧を作る
 *   2. 優先度で並べる(重火器 → 指揮官 → その他。同点はIDで決定的に)
 *   3. 優先度の高い敵から順に射手を割り当てる。1体に貼り付けるのは
 *      `maxPerTarget` まで — そこを超えたら次の敵へ移り、隊形全体を覆う
 *
 * 誰も見えていない隊員には割り当てない(`assignedTarget = null` = 各自の判断)。
 */
export function assignFires(world: World, members: readonly Soldier[]): void {
  const shooters = members.filter((u) => u.status === "ok" && u.sees.length > 0);
  for (const u of members) if (!shooters.includes(u)) u.assignedTarget = null;
  if (shooters.length === 0) return;

  // ① FTの視界の合算(仕様 §5 — FT/分隊層は生の視界を合算してよい)
  const ids = new Set<number>();
  for (const u of shooters) for (const id of u.sees) ids.add(id);
  const targets: Soldier[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const t = world.soldierById.get(id);
    if (t && t.status === "ok") targets.push(t);
  }
  if (targets.length === 0) {
    for (const u of shooters) u.assignedTarget = null;
    return;
  }

  // ② 優先度順。同点はIDで割って決定的にする(乱数を使わない)
  targets.sort((a, b) => priorityOf(b) - priorityOf(a) || a.id - b.id);

  // ③ 1体あたりの射手数の上限。射手が敵より多いときだけ重ねる
  const maxPerTarget = Math.max(1, Math.ceil(shooters.length / targets.length));
  const assigned = new Map<number, number>();

  // 射手側もIDで安定に並べる。空間ハッシュの走査順に依存させない
  const ordered = [...shooters].sort((a, b) => a.id - b.id);
  for (const u of ordered) {
    let best: Soldier | null = null;
    let bestKey = -Infinity;
    for (const t of targets) {
      if (!u.sees.includes(t.id)) continue; // 本人に見えない敵は撃てない
      const n = assigned.get(t.id) ?? 0;
      if (n >= maxPerTarget) continue;
      // 優先度を主、近さを従で選ぶ。既に割り当てられている数が少ないほど優先
      const key = priorityOf(t) * 1000 - n * 100 - Math.sqrt(dist2(u, t)) * 0.1;
      if (key > bestKey) {
        bestKey = key;
        best = t;
      }
    }
    if (!best) {
      // 上限に達している敵しか見えない = 配分の都合で溢れた。各自の判断へ戻す
      u.assignedTarget = null;
      continue;
    }
    u.assignedTarget = best.id;
    assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
  }
}
