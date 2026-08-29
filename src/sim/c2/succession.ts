/**
 * 指揮継承と指揮官排除(仕様 §12「近道条件: 指揮系統の崩壊 (C2 Decapitation)」)。
 *
 * 仕様が定めるメカニクスの要点:
 *   - 継承は**即時**。実際の軍隊と同様、無線自体は生きており次席者へ指揮権が自動的に
 *     引き継がれる。「通信途絶」ではなく「引き継ぎ直後の判断の質低下」として表現する
 *   - 直属の部下はその場で即座に指揮官の無力化を認識する(混乱期間は設けない)
 *   - 上位への報告のみ遅延・不確実化する(第5章の確度減衰システムに準拠)
 *   - 排除した指揮階層が高いほど、影響範囲と回復時間が拡大する
 *   - **自軍・敵軍を問わず同一のロジック**(仕様 §13)
 *
 * 実装: 判断の質低下を「意思決定周期が DEGRADE_FACTOR 倍に鈍り、DEGRADE_SEC[階層]
 * かけて線形に回復する」として表現する。仕様のいう「命令解釈の冗長化・新規戦術判断
 * 不可」を、周期という単一の軸に畳んだもの(数値はOQ-4の決定待ちの暫定値)。
 */

import { DEGRADE_FACTOR, DEGRADE_SEC, SIM_HZ } from "../constants.ts";
import { isOffField } from "../systems/litter.ts";
import type { CompanyState, PlatoonState, Side, Soldier, SquadState } from "../types.ts";
import type { World } from "../world.ts";

/** 継承の対象になる階層。FTリーダーは §12 の排除対象に含まれない。 */
export type CommandEchelon = "squad" | "platoon" | "company";

interface CommandNode {
  commanderId: number | null;
  degradedSinceTick: number | null;
}

function isFit(s: Soldier | undefined): s is Soldier {
  return s !== undefined && s.status === "ok" && !isOffField(s);
}

/**
 * 分隊の継承順位: 分隊長 → 生存しているFTリーダー(アルファ組優先) → 生存隊員。
 * 現実の継承順位(次席者が自動的に引き継ぐ)を、編成上の序列で近似する。
 */
function squadSuccessor(world: World, sq: SquadState): Soldier | undefined {
  const members = world.soldiers.filter(
    (s) => s.side === sq.side && s.squadId === sq.squadId && isFit(s),
  );
  return (
    members.find((s) => s.isSquadLeader) ??
    members.filter((s) => s.isFireteamLeader).sort((a, b) => a.fireteamId - b.fireteamId)[0] ??
    members[0]
  );
}

/** 小隊の継承順位: 小隊長 → 無線手ではなく**生存している分隊長**(現実の慣行)。 */
function platoonSuccessor(world: World, pl: PlatoonState): Soldier | undefined {
  const inPlatoon = world.soldiers.filter(
    (s) => s.side === pl.side && s.platoonId === pl.platoonId && isFit(s),
  );
  return (
    inPlatoon.find((s) => s.hqRole === "pl") ??
    inPlatoon.filter((s) => s.isSquadLeader).sort((a, b) => a.squadId - b.squadId)[0] ??
    inPlatoon.find((s) => s.hqRole === "plRto")
  );
}

/**
 * 中隊の継承順位: 中隊長 → XO(副官)→ 生存している小隊長。
 * 仕様 §11「中隊長が戦死/負傷すると副官(XO)が繰り上がり」をそのまま実装する。
 */
function companySuccessor(world: World, co: CompanyState): Soldier | undefined {
  const inCompany = world.soldiers.filter(
    (s) => s.side === co.side && s.companyId === co.companyId && isFit(s),
  );
  return (
    inCompany.find((s) => s.hqRole === "co") ??
    inCompany.find((s) => s.hqRole === "xo") ??
    inCompany.filter((s) => s.hqRole === "pl").sort((a, b) => a.platoonId - b.platoonId)[0] ??
    inCompany.filter((s) => s.isSquadLeader).sort((a, b) => a.squadId - b.squadId)[0]
  );
}

function updateNode(
  world: World,
  node: CommandNode,
  successor: Soldier | undefined,
  echelon: CommandEchelon,
): void {
  const current = node.commanderId !== null ? world.soldierById.get(node.commanderId) : undefined;
  if (isFit(current)) return; // 現指揮官が健在。何もしない

  const next = successor;
  if (!next) {
    // 指揮を執れる者がいない。ノードは事実上壊滅しているので、劣化状態も持たせない
    node.commanderId = null;
    return;
  }
  if (node.commanderId === next.id) return;

  const isInitialAssignment = node.commanderId === null && world.tick === 0;
  node.commanderId = next.id;
  // 初期割り当て(戦闘開始時)は継承ではないので判断の質は落ちない
  if (!isInitialAssignment) node.degradedSinceTick = world.tick;
  void echelon;
}

/**
 * 各C2ノードの指揮官を確認し、無力化されていれば次席者へ即時継承する。
 * step.ts でC2層より前に実行する — このティックの判断は継承後の指揮官が行う。
 */
export function successionSystem(world: World): void {
  for (const sq of world.squads) updateNode(world, sq, squadSuccessor(world, sq), "squad");
  for (const pl of world.platoons) {
    updateNode(world, pl, platoonSuccessor(world, pl), "platoon");
  }
  for (const co of world.companies) {
    updateNode(world, co, companySuccessor(world, co), "company");
  }
}

/**
 * このノードの意思決定の「質」を表す係数 (DEGRADE_FACTOR..1]。
 * 1 が平常。継承直後は DEGRADE_FACTOR まで落ち、DEGRADE_SEC[階層] かけて線形に戻る。
 *
 * 呼び出し側は意思決定周期を `base / factor` に伸ばす。階層が高いほど
 * DEGRADE_SEC が長い = 影響が長引く(仕様 §12「排除した指揮階層が高いほど…回復までの
 * 時間が拡大する」)。
 */
export function commandFactor(node: CommandNode, tick: number, echelon: CommandEchelon): number {
  if (node.degradedSinceTick === null) return 1;
  const elapsed = (tick - node.degradedSinceTick) / SIM_HZ;
  const window = DEGRADE_SEC[echelon];
  if (elapsed >= window) {
    node.degradedSinceTick = null; // 回復完了
    return 1;
  }
  return DEGRADE_FACTOR + (1 - DEGRADE_FACTOR) * (elapsed / window);
}

/** このノードがいま指揮継承直後の劣化状態にあるか(HUD表示用)。 */
export function isDegraded(node: CommandNode): boolean {
  return node.degradedSinceTick !== null;
}

/** 指定陣営で、いま劣化状態にある指揮ノードの数(HUD表示用)。 */
export function degradedNodeCount(world: World, side: Side): number {
  let n = 0;
  for (const sq of world.squads) if (sq.side === side && isDegraded(sq)) n++;
  for (const pl of world.platoons) if (pl.side === side && isDegraded(pl)) n++;
  for (const co of world.companies) if (co.side === side && isDegraded(co)) n++;
  return n;
}
