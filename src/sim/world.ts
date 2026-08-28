/**
 * World: シミュレーション状態を保持する唯一のミュータブルなコンテナ。
 * 1ティック進めるのに必要なものはすべてここに存在するか、ここから導出される。
 * three.js のハンドルも DOM のハンドルも持たず、完全にシリアライズ可能なので
 * リプレイやヘッドレステストからスナップショットを取れる。
 */

import { buildNavGrid, type NavGrid } from "./navgrid.ts";
import { buildCoverPoints } from "./cover.ts";
import { createRng, type Rng } from "./rng.ts";
import { NAV_MARGIN_OUTDOOR, NAV_STEP_OUTDOOR } from "./constants.ts";
import type {
  AABB,
  Bounds,
  ControlMeasure,
  FireteamState,
  Report,
  Scenario,
  Side,
  Soldier,
  Vec2,
} from "./types.ts";

export interface World {
  tick: number;
  bounds: Bounds;
  walls: AABB[];
  /** 屋外の粗いナビグリッド。建物ごとの細グリッドは後のスライスで追加(design §4.2) */
  navOutdoor: NavGrid;
  /** C2層が躍進先・射撃位置・側面攻撃位置を選ぶための遮蔽候補点の格子 */
  coverPoints: Vec2[];
  /** どちらの陣営にも帰属しない事象のための汎用ストリーム */
  rng: Rng;
  /**
   * **陣営ごとに独立した乱数ストリーム**。両方ともシナリオのシードで同一に初期化する。
   * これにより戦力対称性(仕様 §2/§13)が構造的に保証される: 鏡像の状況では両陣営が
   * 同じ乱数を引くため結果も鏡像になる。実際の(非対称な)戦闘では入力が異なるので
   * ストリームは自然に分岐していく。
   */
  rngBySide: Record<Side, Rng>;
  /** 挿入順が安定した配列。Mapではなくこちらを走査することでステップが決定論的になる */
  soldiers: Soldier[];
  soldierById: Map<number, Soldier>;
  /** FTコントローラ — 最下位のC2ノード(仕様 §1 [v5]) */
  fireteams: FireteamState[];
  /** 伝達中の無線報告。world.tick >= report.deliverTick になった時点で到達する */
  reports: Report[];
  controlMeasures: ControlMeasure[];
}

/** 兵士をディープコピーし、Worldがシナリオから独立して状態を所有できるようにする。 */
function cloneSoldier(s: Soldier): Soldier {
  return {
    ...s,
    pos: { ...s.pos },
    facing: { ...s.facing },
    order: {
      ...s.order,
      ...(s.order.target ? { target: { ...s.order.target } } : {}),
      ...(s.order.facing ? { facing: { ...s.order.facing } } : {}),
    },
    path: s.path.map((p) => ({ ...p })),
    sees: [...s.sees],
    traits: { ...s.traits },
  };
}

/** 編成に存在する (陣営, 分隊, FT) の組ごとにコントローラを1つ生成する。 */
function buildFireteams(scenario: Scenario, soldiers: Soldier[]): FireteamState[] {
  const seen = new Map<string, FireteamState>();
  let id = 0;
  for (const s of soldiers) {
    if (s.fireteamId < 0) continue; // 分隊長枠は自身のFTを持たない
    const key = `${s.side}:${s.squadId}:${s.fireteamId}`;
    if (seen.has(key)) continue;
    const spec = scenario.fireteamPlans?.find(
      (p) => p.side === s.side && p.squadId === s.squadId && p.ftIndex === s.fireteamId,
    );
    const objective = spec?.objective ?? { x: 0, z: 0 };
    const rallyPoint = spec?.rallyPoint ?? { x: s.pos.x, z: s.pos.z };
    const advanceDir = spec?.advanceDir ?? { ...s.facing };
    seen.set(key, {
      id: id++,
      side: s.side,
      squadId: s.squadId,
      ftIndex: s.fireteamId,
      mode: "ADVANCE",
      modeSince: 0,
      boundingLeg: "alpha",
      boundTarget: null,
      baseElement: "alpha",
      unitDest: new Map(),
      unitDestSince: new Map(),
      memory: new Map(),
      searchPoint: null,
      objective: { ...objective },
      advanceDir: { ...advanceDir },
      rallyPoint: { ...rallyPoint },
    });
  }
  return [...seen.values()];
}

export function createWorld(scenario: Scenario): World {
  const walls = scenario.walls.map((w) => ({ ...w }));
  const navOutdoor = buildNavGrid(walls, scenario.bounds, NAV_STEP_OUTDOOR, NAV_MARGIN_OUTDOOR);
  const coverPoints = buildCoverPoints(walls, scenario.bounds);
  const soldiers = scenario.soldiers.map(cloneSoldier);
  const soldierById = new Map(soldiers.map((s) => [s.id, s]));

  return {
    tick: 0,
    bounds: { ...scenario.bounds },
    walls,
    navOutdoor,
    coverPoints,
    rng: createRng(scenario.seed),
    rngBySide: { blue: createRng(scenario.seed), red: createRng(scenario.seed) },
    soldiers,
    soldierById,
    fireteams: buildFireteams(scenario, soldiers),
    reports: [],
    controlMeasures: (scenario.controlMeasures ?? []).map((cm) => ({
      ...cm,
      points: cm.points.map((p) => ({ ...p })),
    })),
  };
}

export function soldiersOf(world: World, side: Side): Soldier[] {
  return world.soldiers.filter((s) => s.side === side);
}

export function livingOf(world: World, side: Side): Soldier[] {
  return world.soldiers.filter((s) => s.side === side && s.status !== "kia");
}

export function squadSoldiers(world: World, squadId: number): Soldier[] {
  return world.soldiers.filter((s) => s.squadId === squadId);
}
