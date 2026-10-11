/**
 * 視点の解決 — 「いまこの立場からは戦場がどう見えるか」を組み立てる(仕様 §5)。
 *
 * 描画とHUDはここが返すものだけを使う。ground truth を直接読んでよいのは
 * `truth`(開発用のデバッグ視点)を選んだときだけ。
 *
 * これは仕様 §5 をUIに強制するための境界でもある。レンダラが world.soldiers を
 * 直接舐めてしまうと、プレイヤーは常に全知になり、階層構造の意味が消える。
 */

import { isOffField } from "./systems/litter.ts";
import type { Contact, Side, Soldier, Vec2 } from "./types.ts";
import type { World } from "./world.ts";

export type ViewEchelon = "company" | "platoon" | "squad" | "truth";

export interface ViewSpec {
  side: Side;
  echelon: ViewEchelon;
  /** echelon === "squad" のとき、どの分隊の視点か */
  squadId?: number | null;
  /** echelon === "platoon" のとき、どの小隊の視点か */
  platoonId?: number | null;
}

/** 描画用にまとめた「この視点から見える敵」。 */
export interface VisibleEnemy {
  /** 表示位置(最終目撃位置。現在位置ではない) */
  pos: Vec2;
  /** 0..1。0 は確度が尽きた最終目撃情報(ゴースト) */
  confidence: number;
  /** 不確度円の半径 m */
  posError: number;
}

export interface ViewResult {
  /** 味方は常に完全に見える(自軍の編成は把握しているため) */
  friendly: Soldier[];
  /** 敵は視点階層の world picture 経由でしか見えない */
  enemies: VisibleEnemy[];
  /**
   * 神視点(`truth`)のときだけ入る、敵兵士の実体そのもの(仕様 §5 の境界の外)。
   * レンダラはこれがある場合、敵も味方と同じ向き付きトークンで描く
   * (指摘: 神視点では陣営に関係なく全ユニットを方向含めて表示)。非truthでは常に空。
   */
  enemiesTruth: Soldier[];
  /** 敵陣営(描画色の決定に使う) */
  enemySide: Side;
  /**
   * この視点の像に載っている敵ドローン(`[v7.5]` ロードマップ S-6)。兵士の接触と同じく
   * 最終目撃位置で、確度と不確度円つき。神視点では空(実体はドローンの描画が別に出す)
   */
  uas: VisibleEnemy[];
  /** 確度が尽きていない接触の件数 */
  known: number;
  /** 確度0のゴーストの件数 */
  stale: number;
}

function toVisible(c: Contact): VisibleEnemy {
  return { pos: { ...c.pos }, confidence: c.confidence, posError: c.posError };
}

/** 視点の階層のコントローラ(分隊・小隊・中隊)。該当がなければ null */
function nodeFor(
  world: World,
  spec: ViewSpec,
): { belief: Map<string, Contact>; uas: Map<string, Contact> } | null {
  if (spec.echelon === "squad") {
    return (
      (spec.squadId != null
        ? world.squads.find((s) => s.side === spec.side && s.squadId === spec.squadId)
        : world.squads.find((s) => s.side === spec.side)) ?? null
    );
  }
  if (spec.echelon === "platoon") {
    return (
      (spec.platoonId != null
        ? world.platoons.find((p) => p.side === spec.side && p.platoonId === spec.platoonId)
        : world.platoons.find((p) => p.side === spec.side)) ?? null
    );
  }
  if (spec.echelon === "company") {
    return world.companies.find((c) => c.side === spec.side) ?? null;
  }
  return null;
}

/** 指定した視点の belief を取り出す。該当がなければ空。 */
export function beliefFor(world: World, spec: ViewSpec): Map<string, Contact> {
  return nodeFor(world, spec)?.belief ?? new Map();
}

/** 指定した視点の、敵ドローンの像(`[v7.5]` S-6)。該当がなければ空。 */
export function uasFor(world: World, spec: ViewSpec): Map<string, Contact> {
  return nodeFor(world, spec)?.uas ?? new Map();
}

export function resolveView(world: World, spec: ViewSpec): ViewResult {
  // 後送済みの兵士は戦場を離脱しているので描画しない(仕様 §9)。
  // 生存者としてはカウントされるため、HUDの集計とは別扱いになる。
  const friendly = world.soldiers.filter((s) => s.side === spec.side && !isOffField(s));
  const enemySide: Side = spec.side === "blue" ? "red" : "blue";

  if (spec.echelon === "truth") {
    // デバッグ視点: 敵の実体をそのまま渡す(向き付きトークンで描くため)。
    const enemiesTruth = world.soldiers.filter(
      (s) => s.side !== spec.side && s.status !== "kia" && !isOffField(s),
    );
    return {
      friendly,
      enemies: [],
      enemiesTruth,
      enemySide,
      uas: [],
      known: enemiesTruth.length,
      stale: 0,
    };
  }

  const belief = beliefFor(world, spec);
  const enemies: VisibleEnemy[] = [];
  let known = 0;
  let stale = 0;
  for (const c of belief.values()) {
    enemies.push(toVisible(c));
    if (c.confidence > 0) known++;
    else stale++;
  }
  const uas = [...uasFor(world, spec).values()].filter((c) => c.confidence > 0).map(toVisible);
  return { friendly, enemies, enemiesTruth: [], enemySide, uas, known, stale };
}
