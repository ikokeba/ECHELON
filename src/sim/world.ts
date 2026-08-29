/**
 * World: シミュレーション状態を保持する唯一のミュータブルなコンテナ。
 * 1ティック進めるのに必要なものはすべてここに存在するか、ここから導出される。
 * three.js のハンドルも DOM のハンドルも持たず、完全にシリアライズ可能なので
 * リプレイやヘッドレステストからスナップショットを取れる。
 */

import { buildNavSet, type NavSet } from "./navgrid.ts";
import { buildCoverPoints } from "./cover.ts";
import { successionSystem } from "./c2/succession.ts";
import { clamp } from "./geometry.ts";
import { createRng, type Rng } from "./rng.ts";
import type { ControlState } from "./control.ts";
import {
  CASEVAC_ASSETS_PER_COMPANY,
  CP_BOUNDS_MARGIN,
  CP_TRAIL_DIST,
  CQB,
  DOOR_THICKNESS,
  NAV_MARGIN_OUTDOOR,
  NAV_STEP_OUTDOOR,
} from "./constants.ts";
import type {
  AABB,
  Bounds,
  Building,
  CompanyState,
  ControlMeasure,
  Door,
  FireteamState,
  PlatoonState,
  Report,
  Scenario,
  Side,
  Soldier,
  SquadState,
  Vec2,
} from "./types.ts";

export interface World {
  tick: number;
  bounds: Bounds;
  /**
   * 視線と移動を遮るもの。構造物の壁に加え、**閉じている扉**の板も含む(仕様 §7.6)。
   * 扉が開くとそのAABBはここから取り除かれ、視線も移動も通るようになる。
   */
  walls: AABB[];
  /** 構造物の壁だけ。扉は常に開いているものとしてナビグリッドを作るために使う */
  structuralWalls: AABB[];
  /** 建物(仕様 §7)。屋外と屋内はシームレスな1つのマップ */
  buildings: Building[];
  /** 扉。開閉が視界の境界線になる(仕様 §7.6) */
  doors: Door[];
  /**
   * 屋外1.0m + 建物ごと0.3m を束ねた探索空間(design §4.2)。
   * 街路から建物内部まで1回のA*で経路が出る。
   */
  nav: NavSet;
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
  /** 分隊長コントローラ。麾下FTの視界の合算を直接持つ(仕様 §5) */
  squads: SquadState[];
  /** 小隊長コントローラ。無線報告のみから world picture を構築する(仕様 §5) */
  platoons: PlatoonState[];
  /** 中隊長コントローラ。小隊長からの報告の集約のみを持つ(仕様 §3①/§5/§11) */
  companies: CompanyState[];
  /** 補充兵に割り当てる次の兵士ID(仕様 §9 の補充兵システム) */
  nextSoldierId: number;
  /** 伝達中の無線報告。world.tick >= report.deliverTick になった時点で到達する */
  reports: Report[];
  controlMeasures: ControlMeasure[];
  /** 陣営ごとの負傷者集合点(CCP、仕様 §9)。担架班の搬送先。 */
  ccp: Record<Side, Vec2>;
  /**
   * いま人間が操作しているノード(仕様 §4)。null なら全ユニットがAI制御。
   * 人間はAIの意思決定者を置き換えるだけで、配管も能力も変わらない。
   */
  control: ControlState | null;
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
    bearers: [...s.bearers],
    quals: { ...s.quals },
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
      technique: "traveling",
      assignedRole: null,
      cqbDoorId: null,
      cqbStage: "stack",
      cqbStageSince: 0,
      cqbCorner: new Map(),
      cqbEntryOrder: [],
      routedSinceTick: null,
    });
  }
  return [...seen.values()];
}

/** 編成に存在する (陣営, 分隊) の組ごとに分隊長コントローラを生成する。 */
function buildSquads(scenario: Scenario, soldiers: Soldier[]): SquadState[] {
  const seen = new Map<string, SquadState>();
  let id = 0;
  for (const s of soldiers) {
    if (s.squadId < 0) continue; // 本部要員は分隊コントローラを持たない(仕様 §2)
    const key = `${s.side}:${s.squadId}`;
    if (seen.has(key)) continue;
    const spec = scenario.squadPlans?.find((p) => p.side === s.side && p.squadId === s.squadId);
    seen.set(key, {
      id: id++,
      side: s.side,
      squadId: s.squadId,
      platoonId: spec?.platoonId ?? s.platoonId,
      belief: new Map(),
      technique: "traveling",
      objective: { ...(spec?.objective ?? { x: 0, z: 0 }) },
      advanceDir: { ...(spec?.advanceDir ?? s.facing) },
      rallyPoint: { ...(spec?.rallyPoint ?? s.pos) },
      lastReportTick: 0,
      lastDecisionTick: 0,
      casevacOrders: [],
      commanderId: null,
      degradedSinceTick: null,
      assaultDoorId: null,
      clearedDoorIds: [],
    });
  }
  return [...seen.values()];
}

/** 編成に存在する (陣営, 小隊) の組ごとに小隊長コントローラを生成する。 */
function buildPlatoons(scenario: Scenario, soldiers: Soldier[]): PlatoonState[] {
  const seen = new Map<string, PlatoonState>();
  let id = 0;
  for (const s of soldiers) {
    if (s.platoonId < 0) continue; // 中隊本部は小隊に属さない
    const key = `${s.side}:${s.platoonId}`;
    if (seen.has(key)) continue;
    const spec = scenario.platoonPlans?.find(
      (p) => p.side === s.side && p.platoonId === s.platoonId,
    );
    seen.set(key, {
      id: id++,
      side: s.side,
      platoonId: s.platoonId,
      companyId: spec?.companyId ?? s.companyId,
      belief: new Map(),
      squadObjectives: new Map(),
      squadTechniques: new Map(),
      objective: { ...(spec?.objective ?? { x: 0, z: 0 }) },
      advanceDir: { ...(spec?.advanceDir ?? s.facing) },
      rallyPoint: { ...(spec?.rallyPoint ?? s.pos) },
      lastReportTick: 0,
      lastDecisionTick: 0,
      commanderId: null,
      degradedSinceTick: null,
    });
  }
  return [...seen.values()];
}

/**
 * 編成に存在する (陣営, 中隊) の組ごとに中隊長コントローラを生成する(仕様 §3①/§11)。
 * 指揮所(CP)の位置指定がない場合は、初期配置の重心から後退した位置へ自動配置する。
 */
function buildCompanies(scenario: Scenario, soldiers: Soldier[]): CompanyState[] {
  const seen = new Map<string, CompanyState>();
  let id = 0;
  let assetId = 0;
  for (const s of soldiers) {
    const key = `${s.side}:${s.companyId}`;
    if (seen.has(key)) continue;
    const spec = scenario.companyPlans?.find(
      (p) => p.side === s.side && p.companyId === s.companyId,
    );
    const advanceDir = spec?.advanceDir ?? s.facing;

    let cp = spec?.cp;
    if (!cp) {
      const men = soldiers.filter((m) => m.side === s.side && m.companyId === s.companyId);
      let x = 0;
      let z = 0;
      for (const m of men) {
        x += m.pos.x;
        z += m.pos.z;
      }
      x /= men.length;
      z /= men.length;
      // 盤外へはみ出さないよう境界内へ収める。ナビグリッドは bounds から作られるため、
      // 外に出た指揮所へは誰も到達できない
      const m = CP_BOUNDS_MARGIN;
      cp = {
        x: clamp(
          x - advanceDir.x * CP_TRAIL_DIST,
          scenario.bounds.minX + m,
          scenario.bounds.maxX - m,
        ),
        z: clamp(
          z - advanceDir.z * CP_TRAIL_DIST,
          scenario.bounds.minZ + m,
          scenario.bounds.maxZ - m,
        ),
      };
    }

    seen.set(key, {
      id: id++,
      side: s.side,
      companyId: s.companyId,
      belief: new Map(),
      cp: { ...cp },
      platoonObjectives: new Map(),
      objective: { ...(spec?.objective ?? { x: 0, z: 0 }) },
      advanceDir: { ...advanceDir },
      rallyPoint: { ...(spec?.rallyPoint ?? cp) },
      lastDecisionTick: 0,
      assets: Array.from({ length: CASEVAC_ASSETS_PER_COMPANY }, () => ({
        id: assetId++,
        arriveTick: null,
      })),
      commanderId: null,
      degradedSinceTick: null,
    });
  }
  return [...seen.values()];
}

/**
 * 陣営の負傷者集合点(CCP、仕様 §9)。シナリオ指定がなければ初期配置の重心を使う。
 * 前線が押し上がっても後方に残るので、後送の距離が戦況とともに伸びていく。
 */
function defaultCcp(soldiers: readonly Soldier[], side: Side): Vec2 {
  const men = soldiers.filter((s) => s.side === side);
  if (men.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const m of men) {
    x += m.pos.x;
    z += m.pos.z;
  }
  return { x: x / men.length, z: z / men.length };
}

export function createWorld(scenario: Scenario): World {
  const world = buildWorld(scenario);
  // 各C2ノードの初期指揮官を席に着かせる(仕様 §12)。tick 0 の割り当ては
  // 「継承」ではないので判断の質は落ちない — successionSystem 側で区別している。
  successionSystem(world);
  return world;
}

/**
 * 閉じている扉が占める板のAABB(仕様 §7.6)。開口部を法線方向に薄く塞ぐ。
 * 開いた扉はこのリストから外れるので、視線も移動もその瞬間から通る。
 */
export function doorBlocker(d: Door): AABB {
  // 法線がX方向寄りなら板はZ方向に伸びる(その逆も同様)
  const alongX = Math.abs(d.normal.x) > Math.abs(d.normal.z);
  return {
    cx: d.pos.x,
    cz: d.pos.z,
    hw: alongX ? DOOR_THICKNESS : d.width / 2,
    hd: alongX ? d.width / 2 : DOOR_THICKNESS,
  };
}

/** 構造物の壁 + 閉じている扉。視線・移動の判定はこれを使う。 */
function blockersOf(structural: readonly AABB[], doors: readonly Door[]): AABB[] {
  return [...structural, ...doors.filter((d) => !d.open).map(doorBlocker)];
}

/** 扉の開閉が変わったあとに呼ぶ。視線・移動の判定対象を組み直す。 */
export function refreshBlockers(world: World): void {
  world.walls = blockersOf(world.structuralWalls, world.doors);
}

function buildWorld(scenario: Scenario): World {
  const structuralWalls = scenario.walls.map((w) => ({ ...w }));
  const buildings = (scenario.buildings ?? []).map((b) => ({
    ...b,
    bounds: { ...b.bounds },
    rooms: b.rooms.map((r) => ({ ...r, bounds: { ...r.bounds } })),
    doors: b.doors.map((d) => ({ ...d, pos: { ...d.pos }, normal: { ...d.normal } })),
  }));
  const doors = buildings.flatMap((b) => b.doors);
  const walls = blockersOf(structuralWalls, doors);

  // ナビグリッドは**扉を通れるもの**として作る。閉じた扉は移動を阻むが、それは
  // 経路の有無ではなく通過の可否の問題で、ブリーチすれば通れるようになるため。
  const nav = buildNavSet(
    structuralWalls,
    scenario.bounds,
    NAV_STEP_OUTDOOR,
    NAV_MARGIN_OUTDOOR,
    buildings,
    CQB.NAV_STEP,
    CQB.NAV_MARGIN,
  );
  const coverPoints = buildCoverPoints(structuralWalls, scenario.bounds);
  const soldiers = scenario.soldiers.map(cloneSoldier);
  const soldierById = new Map(soldiers.map((s) => [s.id, s]));

  return {
    tick: 0,
    bounds: { ...scenario.bounds },
    walls,
    structuralWalls,
    buildings,
    doors,
    nav,
    coverPoints,
    rng: createRng(scenario.seed),
    rngBySide: { blue: createRng(scenario.seed), red: createRng(scenario.seed) },
    soldiers,
    soldierById,
    fireteams: buildFireteams(scenario, soldiers),
    squads: buildSquads(scenario, soldiers),
    platoons: buildPlatoons(scenario, soldiers),
    companies: buildCompanies(scenario, soldiers),
    nextSoldierId: soldiers.reduce((mx, s) => Math.max(mx, s.id), 0) + 1,
    reports: [],
    controlMeasures: (scenario.controlMeasures ?? []).map((cm) => ({
      ...cm,
      points: cm.points.map((p) => ({ ...p })),
    })),
    ccp: {
      blue: { ...(scenario.ccp?.blue ?? defaultCcp(soldiers, "blue")) },
      red: { ...(scenario.ccp?.red ?? defaultCcp(soldiers, "red")) },
    },
    control: null,
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
