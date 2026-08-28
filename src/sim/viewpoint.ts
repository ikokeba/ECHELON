/**
 * 視点の解決 — 「いまこの立場からは戦場がどう見えるか」を組み立てる(仕様 §5)。
 *
 * 描画とHUDはここが返すものだけを使う。ground truth を直接読んでよいのは
 * `truth`(開発用のデバッグ視点)を選んだときだけ。
 *
 * これは仕様 §5 をUIに強制するための境界でもある。レンダラが world.soldiers を
 * 直接舐めてしまうと、プレイヤーは常に全知になり、階層構造の意味が消える。
 */

import type { Contact, Side, Soldier, Vec2 } from "./types.ts";
import type { World } from "./world.ts";

export type ViewEchelon = "platoon" | "squad" | "truth";

export interface ViewSpec {
  side: Side;
  echelon: ViewEchelon;
  /** echelon === "squad" のとき、どの分隊の視点か */
  squadId?: number | null;
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
  /** 敵陣営(描画色の決定に使う) */
  enemySide: Side;
  /** 確度が尽きていない接触の件数 */
  known: number;
  /** 確度0のゴーストの件数 */
  stale: number;
}

function toVisible(c: Contact): VisibleEnemy {
  return { pos: { ...c.pos }, confidence: c.confidence, posError: c.posError };
}

/** 指定した視点の belief を取り出す。該当がなければ空。 */
export function beliefFor(world: World, spec: ViewSpec): Map<string, Contact> {
  if (spec.echelon === "squad") {
    const sq =
      spec.squadId != null
        ? world.squads.find((s) => s.side === spec.side && s.squadId === spec.squadId)
        : world.squads.find((s) => s.side === spec.side);
    return sq?.belief ?? new Map();
  }
  if (spec.echelon === "platoon") {
    const pl = world.platoons.find((p) => p.side === spec.side);
    return pl?.belief ?? new Map();
  }
  return new Map();
}

export function resolveView(world: World, spec: ViewSpec): ViewResult {
  // 後送済みの兵士は戦場を離脱しているので描画しない(仕様 §9)。
  // 生存者としてはカウントされるため、HUDの集計とは別扱いになる。
  const friendly = world.soldiers.filter((s) => s.side === spec.side && s.evac !== "evacuated");
  const enemySide: Side = spec.side === "blue" ? "red" : "blue";

  if (spec.echelon === "truth") {
    // デバッグ視点: 敵の現在位置をそのまま出す。確度は常に1。
    const enemies = world.soldiers
      .filter((s) => s.side !== spec.side && s.status !== "kia")
      .map((s) => ({ pos: { ...s.pos }, confidence: 1, posError: 0 }));
    return { friendly, enemies, enemySide, known: enemies.length, stale: 0 };
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
  return { friendly, enemies, enemySide, known, stale };
}
