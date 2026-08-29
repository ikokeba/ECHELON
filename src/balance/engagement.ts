/**
 * バランス検証用の抽象交戦モデル(仕様 §14 の戦力バランス検証)。
 *
 * `mos-balance-simulator.jsx` の置き換えだが、**モックのような並行実装ではない**:
 * 命中判定は実シムと同じ `rollShot` をそのまま呼び、係数も constants.ts の
 * 同じ値を使う。実シムとバランス検証がずれることが構造的にありえない形にしてある
 * (docs/design/00 §2「balance harness は実 resolveCombat を回す」)。
 *
 * 抽象化しているのは**戦闘以外**だけ:
 *   - 位置・遮蔽・視界を持たない(全員が全員を撃てる)
 *   - CASEVAC層を分離した純粋交戦モデル(仕様 §14 の検証条件と同じ)
 *   - 命中 = 排除。KIA/WIAの分岐は後送層の話なのでここでは扱わない
 *
 * モックが検証中に踏んだ2つの不具合は、構造として排除してある:
 *   - **先手バイアス**: 両軍がティック開始時点の状態に対して判定し、
 *     効果をまとめて適用する(実シムと同じ2フェーズ解決)
 *   - **擲弾の貢献集計**: 撃破の帰属を射手のロールで記録する
 */

import {
  EVADE_SEC,
  GRENADE,
  GRENADE_ATTEMPT_RATE_PER_SEC,
  SAW_SUPPRESS_MUL,
  SIM_DT,
  SUPPRESS_TRIGGER_RATE_PER_SEC,
} from "../sim/constants.ts";
import { chance, createRng, next, ratePerTick, type Rng } from "../sim/rng.ts";
import { rollShot } from "../sim/systems/combat.ts";
import type { SoldierRole } from "../sim/types.ts";

export interface Fighter {
  role: SoldierRole;
  /** 選抜射手(仕様 §14: 制圧下でも命中率低下が軽い) */
  marksman: boolean;
  alive: boolean;
  /** 制圧されて行動できないティック(仕様 §14 の行動抑制効果) */
  suppressedUntil: number;
  /** 制圧を受けている(命中率が下がる)ティック */
  accPenaltyUntil: number;
  grenades: number;
}

export type Composition = () => Fighter[];

function mk(role: SoldierRole, marksman = false): Fighter {
  return {
    role,
    marksman,
    alive: true,
    suppressedUntil: 0,
    accPenaltyUntil: 0,
    grenades: role === "grenadier" ? GRENADE.CHARGES : 0,
  };
}

/** 均一4名編成(対照実験用)。全員ライフルマン。 */
export const baselineTeam: Composition = () => [
  mk("rifleman"),
  mk("rifleman"),
  mk("rifleman"),
  mk("rifleman"),
];

/** MOS編成(仕様 §14): チームリーダー + SAW + 擲弾手 + ライフルマン(選抜射手兼任)。 */
export const mosTeam: Composition = () => [
  mk("leader"),
  mk("saw"),
  mk("grenadier"),
  mk("rifleman", true),
];

export interface BattleResult {
  winner: "A" | "B" | "draw";
  durationSec: number;
  survivorsA: number;
  survivorsB: number;
  /** 役割ごとの撃破数(A側) */
  killsByRoleA: Record<SoldierRole, number>;
  /** うち擲弾による撃破(A側)。小銃の戦果と混ぜない */
  grenadeKillsA: number;
}

/** 生存者から1名を一様に選ぶ。 */
function pickAlive(rng: Rng, team: readonly Fighter[]): Fighter | null {
  const alive = team.filter((f) => f.alive);
  if (alive.length === 0) return null;
  return alive[Math.floor(next(rng) * alive.length)] ?? null;
}

interface Effect {
  kill?: Fighter;
  suppress?: Fighter;
  by: SoldierRole;
  /**
   * 擲弾による撃破か。擲弾手の**小銃による撃破と混ぜない**のが要点 —
   * 仕様 §14 の検証では「擲弾手の貢献集計が常に0を指していた集計バグ」が見つかっている。
   * 役割別に数えるだけでは、今度は逆に小銃の戦果まで擲弾の貢献に見えてしまう。
   */
  viaGrenade?: boolean;
}

/** 片側の1ティック分の判定。**効果は返すだけで適用しない**(2フェーズ解決)。 */
function rollTeam(rng: Rng, self: readonly Fighter[], enemy: readonly Fighter[], tick: number): Effect[] {
  const out: Effect[] = [];
  for (const u of self) {
    if (!u.alive) continue;
    // 行動抑制中は撃てない(仕様 §14)
    if (u.suppressedUntil > tick) continue;

    // 擲弾手: 遮蔽無視の範囲攻撃。抽象モデルでは確定排除として扱う(仕様 §14)
    if (u.role === "grenadier" && u.grenades > 0) {
      if (chance(rng, ratePerTick(GRENADE_ATTEMPT_RATE_PER_SEC, SIM_DT))) {
        u.grenades -= 1;
        if (chance(rng, GRENADE.SUCCESS_RATE)) {
          const t = pickAlive(rng, enemy);
          if (t) out.push({ kill: t, by: u.role, viaGrenade: true });
        }
        continue; // このティックは擲弾行動のみ
      }
    }

    // 通常射撃 — 実シムと同一の rollShot
    const shot = rollShot(rng, {
      shooterSuppressed: u.accPenaltyUntil > tick,
      shooterIsMarksman: u.marksman,
      shooterMoving: false,
      shooterIsSaw: u.role === "saw",
    });
    if (shot.hit) {
      const t = pickAlive(rng, enemy);
      if (t) out.push({ kill: t, by: u.role });
    }

    // 制圧: SAW手は行動抑制の誘発率が1.5倍(仕様 §14)
    const mul = u.role === "saw" ? SAW_SUPPRESS_MUL : 1;
    if (chance(rng, ratePerTick(SUPPRESS_TRIGGER_RATE_PER_SEC * mul, SIM_DT))) {
      const t = pickAlive(rng, enemy);
      if (t) out.push({ suppress: t, by: u.role });
    }
  }
  return out;
}

const EMPTY_KILLS = (): Record<SoldierRole, number> => ({
  leader: 0,
  saw: 0,
  grenadier: 0,
  rifleman: 0,
  mg: 0,
});

export interface BattleOptions {
  maxSec?: number;
  /**
   * 両陣営に**同一の乱数ストリーム**を与える(既定 false)。
   *
   * true にすると、編成が同一なら両軍がまったく同じ判定を引くため、結果は必ず
   * 相打ちの引き分けになる。これは処理順に由来する先手バイアスが存在しないことの
   * **構造的な証明**で、勝率の統計より強い(仕様 §2/§13、§14 の先手バイアス不具合)。
   *
   * false のときは陣営ごとに脱相関させたストリームを使う。モンテカルロで勝率を
   * 測りたいときは、両軍が同じ乱数を引いては標本にならないため。
   */
  mirrored?: boolean;
}

/** 1戦闘。上限に達したら引き分け。 */
export function simulateBattle(
  seed: number,
  compA: Composition,
  compB: Composition,
  opts: BattleOptions = {},
): BattleResult {
  const maxSec = opts.maxSec ?? 800;
  // 陣営ごとに独立したストリーム(実シムと同じ構造、仕様 §2/§13)。
  // 鏡像検証のときだけ同一シードにする
  const rngA = createRng(seed);
  const rngB = createRng(opts.mirrored ? seed : (seed ^ 0x9e3779b9) >>> 0);
  const A = compA();
  const B = compB();
  const killsByRoleA = EMPTY_KILLS();
  let grenadeKillsA = 0;
  const maxTicks = Math.round(maxSec / SIM_DT);
  const evadeTicks = Math.round(EVADE_SEC / SIM_DT);

  for (let tick = 0; tick < maxTicks; tick++) {
    // 判定フェーズ: 両軍がティック開始時点の状態に対して判定する
    const fromA = rollTeam(rngA, A, B, tick);
    const fromB = rollTeam(rngB, B, A, tick);

    // 適用フェーズ: ここで初めて効果が入る。先手バイアスが原理的に生じない
    for (const e of fromA) {
      if (e.kill && e.kill.alive) {
        e.kill.alive = false;
        killsByRoleA[e.by] += 1;
        if (e.viaGrenade) grenadeKillsA += 1;
      }
      if (e.suppress && e.suppress.alive) {
        e.suppress.suppressedUntil = Math.max(e.suppress.suppressedUntil, tick + evadeTicks);
        e.suppress.accPenaltyUntil = tick + 2;
      }
    }
    for (const e of fromB) {
      if (e.kill && e.kill.alive) e.kill.alive = false;
      if (e.suppress && e.suppress.alive) {
        e.suppress.suppressedUntil = Math.max(e.suppress.suppressedUntil, tick + evadeTicks);
        e.suppress.accPenaltyUntil = tick + 2;
      }
    }

    const aliveA = A.some((f) => f.alive);
    const aliveB = B.some((f) => f.alive);
    if (!aliveA || !aliveB) {
      return {
        winner: aliveA && !aliveB ? "A" : !aliveA && aliveB ? "B" : "draw",
        durationSec: tick * SIM_DT,
        survivorsA: A.filter((f) => f.alive).length,
        survivorsB: B.filter((f) => f.alive).length,
        killsByRoleA,
        grenadeKillsA,
      };
    }
  }

  return {
    winner: "draw",
    durationSec: maxSec,
    survivorsA: A.filter((f) => f.alive).length,
    survivorsB: B.filter((f) => f.alive).length,
    killsByRoleA,
    grenadeKillsA,
  };
}

export interface BatchStats {
  n: number;
  winRateA: number;
  winRateB: number;
  drawRate: number;
  avgDurationSec: number;
  avgSurvivorsOfWinner: number;
  /** A側の役割別平均撃破数 */
  avgKillsByRoleA: Record<SoldierRole, number>;
  /** A側の1戦あたり平均擲弾撃破数(仕様 §14 の検証項目) */
  avgGrenadeKillsA: number;
}

/**
 * モンテカルロ試行。**シードは試行ごとに決定論的に導出する**ので、
 * 同じ引数なら何度回しても同じ結果になる(検証の再現性)。
 */
export function runBatch(
  n: number,
  compA: Composition,
  compB: Composition,
  baseSeed = 1,
): BatchStats {
  let winA = 0;
  let winB = 0;
  let draw = 0;
  let durSum = 0;
  let survWinner = 0;
  const kills = EMPTY_KILLS();
  let grenadeKills = 0;

  for (let i = 0; i < n; i++) {
    const r = simulateBattle(baseSeed + i * 7919, compA, compB);
    if (r.winner === "A") {
      winA++;
      survWinner += r.survivorsA;
    } else if (r.winner === "B") {
      winB++;
      survWinner += r.survivorsB;
    } else {
      draw++;
    }
    durSum += r.durationSec;
    for (const role of Object.keys(kills) as SoldierRole[]) {
      kills[role] += r.killsByRoleA[role];
    }
    grenadeKills += r.grenadeKillsA;
  }

  const avgKills = EMPTY_KILLS();
  for (const role of Object.keys(kills) as SoldierRole[]) avgKills[role] = kills[role] / n;

  return {
    n,
    winRateA: (winA / n) * 100,
    winRateB: (winB / n) * 100,
    drawRate: (draw / n) * 100,
    avgDurationSec: durSum / n,
    avgSurvivorsOfWinner: survWinner / Math.max(1, winA + winB),
    avgKillsByRoleA: avgKills,
    avgGrenadeKillsA: grenadeKills / n,
  };
}
