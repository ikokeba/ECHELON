/**
 * World: シミュレーション状態を保持する唯一のミュータブルなコンテナ。
 * 1ティック進めるのに必要なものはすべてここに存在するか、ここから導出される。
 * three.js のハンドルも DOM のハンドルも持たず、完全にシリアライズ可能なので
 * リプレイやヘッドレステストからスナップショットを取れる。
 */

import { appendBuildingNav, buildNavSet, type NavSet } from "./navgrid.ts";
import { buildCoverIndex, buildCoverPoints, type CoverIndex, type CoverPoint } from "./cover.ts";
import { successionSystem } from "./c2/succession.ts";
import { NO_FLOT } from "./c2/flot.ts";
import { clamp } from "./geometry.ts";
import { createRng, type Rng } from "./rng.ts";
import { buildWallIndex, type WallIndex } from "./wallIndex.ts";
import { defaultPosture, defaultTuning } from "./tuning.ts";
import { defaultDoctrine, type Doctrine } from "./doctrine.ts";
import type { ControlState } from "./control.ts";
import {
  CASEVAC_ASSETS_PER_COMPANY,
  CP_BOUNDS_MARGIN,
  CP_TRAIL_DIST,
  CQB,
  DOOR_THICKNESS,
  OBJECTIVE,
  SIM_HZ,
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
  FxEvent,
  Objective,
  PlatoonState,
  Posture,
  FireMission,
  ReinforcementSpec,
  ReinforcementState,
  Report,
  Scenario,
  BattleMode,
  Side,
  SimPhase,
  Soldier,
  SquadState,
  Tuning,
  Vec2,
  VictoryState,
} from "./types.ts";

export interface World {
  tick: number;
  /**
   * 局面(`[v6.5]`)。既定は `battle` — ヘッドレステストとバランスハーネスは
   * 立案を挟まず即座に戦闘を始める。UIは `beginPlanning` で `planning` にしてから
   * プレイヤーの「戦闘開始」を待つ。`planning` の間 `stepWorld` は何もしない。
   */
  phase: SimPhase;
  /**
   * 戦闘の型(仕様 §12「モード別の追加条件」)。`[v6.8]`
   * 既定は `meeting`(遭遇戦)なので、既存のテストとバランスハーネスは影響を受けない。
   */
  mode: BattleMode;
  /** `mode === "assault"` のときの攻撃側。防御側は最初から全拠点を保有する */
  attacker: Side;
  /** 攻防戦の制限時間(ティック)。0 なら無制限 */
  timeLimitTicks: number;
  bounds: Bounds;
  /**
   * 視線と移動を遮るもの。構造物の壁に加え、**閉じている扉**の板も含む(仕様 §7.6)。
   * 扉が開くとそのAABBはここから取り除かれ、視線も移動も通るようになる。
   */
  walls: AABB[];
  /**
   * `walls` の空間索引。`[v6.2]` 索敵は毎ティック 兵士×近傍×壁 の計算になるので、
   * 市街地マップ(壁460枚)では全数走査が支配的になる。答えは全数走査と厳密に同じ。
   * `walls` を差し替えたら必ず `refreshBlockers` を通して張り直すこと。
   */
  wallIndex: WallIndex;
  /** 構造物の壁だけ。扉は常に開いているものとしてナビグリッドを作るために使う */
  structuralWalls: AABB[];
  /**
   * 経路探索用の壁(`[v6.10]`)。`structuralWalls` との違いは**窓が塞がっている**ことだけ。
   * ナビグリッドはこちらから張る — 窓から出入りできてしまうと突入ドリルが意味を失う。
   */
  navWalls: AABB[];
  /** 建物(仕様 §7)。屋外と屋内はシームレスな1つのマップ */
  buildings: Building[];
  /** 扉。開閉が視界の境界線になる(仕様 §7.6) */
  doors: Door[];
  /**
   * 屋外1.0m + 建物ごと0.3m を束ねた探索空間(design §4.2)。
   * 街路から建物内部まで1回のA*で経路が出る。
   */
  nav: NavSet;
  /**
   * 屋内の細ナビグリッドを持っている建物のid。`[v6.3]`
   *
   * 屋内グリッドは 0.3m 刻みなので、1棟で数千ノードになる。市街地マップが100棟規模に
   * なると全棟ぶんを常時持つのは現実的でない(ノード数50万超)。**実際に突入する建物だけ**
   * 遅延して張り、必要になった時点で `nav` を組み直す。
   *
   * 屋外の移動は屋外グリッドだけで完結するので、張られていない建物があっても
   * 誰も困らない — 屋内へ入るのは §7.2 の突入ドリルの担当で、その入口で活性化する。
   */
  navBuildings: Set<number>;
  /** C2層が躍進先・射撃位置・側面攻撃位置を選ぶための遮蔽候補点の格子 */
  coverPoints: CoverPoint[];
  /**
   * 遮蔽候補点の空間索引。`[v6.3]` 候補点の探索はどれも半径で絞れるのに全点走査
   * だったため、盤面2倍(候補点3.1万)でFTリーダーAIがティック時間の83%を占めた。
   */
  coverIndex: CoverIndex;
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
  /**
   * 飛翔中の火力支援任務(`[v6.9]` 仕様 §10/§11)。
   * 照準点は**要請時点の中隊長の像**で凍結されている(仕様 §5)。
   */
  fireMissions: FireMission[];
  nextFireMissionId: number;
  controlMeasures: ControlMeasure[];
  /** 陣営ごとの負傷者集合点(CCP、仕様 §9)。担架班の搬送先。 */
  ccp: Record<Side, Vec2>;
  /** 争奪する拠点(仕様 §12) */
  objectives: Objective[];
  /** 過半数の拠点を確保し始めたティック(陣営別)。勝利判定の保持時間に使う */
  majoritySince: Record<Side, number | null>;
  /** 決着(仕様 §12)。null なら戦闘継続中 */
  victory: VictoryState | null;
  /**
   * いま人間が操作しているノード(仕様 §4)。null なら全ユニットがAI制御。
   * 人間はAIの意思決定者を置き換えるだけで、配管も能力も変わらない。
   */
  control: ControlState | null;
  /**
   * 外部エージェント(LLM など、`[v7.0]` src/llm/)が座っている指揮ノード。
   * 人間の操作枠(`control`)とは別に持つので、人間が別の部隊を操作していても
   * エージェントの座席は外れない。座席のノードはAIが止まり、エージェントが
   * 人間と**同じ命令だけ**を出す(仕様 §4: 置き換えるのであって能力は足さない)。
   */
  agentSeats: ControlState[];
  /** 後援部隊(`[v7.0]` systems/reinforcement.ts)。陣営ごと */
  reinforcement: Record<Side, ReinforcementState>;
  /**
   * そのティックの描画用エフェクトイベント(`[v6.1]`)。`stepWorld` 先頭で空にし、
   * `combatSystem` が発砲・擲弾着弾を push する。**シムの結果には影響しない**。
   */
  fx: FxEvent[];
  /**
   * 実行時チューニング(`[v6.1]`)。既定は `constants.ts` そのまま。デバッグUIの
   * スライダーだけがこれを書き換える。対称性・決定論テストはここに触れない。
   */
  tuning: Tuning;
  /** 陣営ごとのリスク許容度(`[v6.1]`)。既定は両陣営 0.5 で現行挙動と一致。 */
  posture: Record<Side, Posture>;
  /**
   * 陣営ごとのドクトリン(指揮文化)。`[v6.8]` 仕様 §13。
   * 切り替わるのは能力ではなく**統制の効き方**(判断周期・無線・自主性)。
   * 既定は両陣営 `regular` = 全係数 identity で、現行の挙動と厳密に一致する。
   */
  doctrine: Record<Side, Doctrine>;
}

/** その陣営のドクトリン(仕様 §13)。C2の各層から引く。 */
export function sideDoctrine(world: World, side: Side): Doctrine {
  return world.doctrine[side];
}

/** 攻撃側の反対。攻防戦の防御側(仕様 §12)。 */
export function defenderOf(attacker: Side): Side {
  return attacker === "blue" ? "red" : "blue";
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

/** 後援部隊の設定。回数0は「なし」と同じに扱う */
function activeReinforcement(scenario: Scenario, side: Side): ReinforcementSpec | null {
  const r = scenario.reinforcement?.[side];
  return r && r.calls > 0 ? { ...r } : null;
}

/** 編成に存在する (陣営, 分隊, FT) の組ごとにコントローラを1つ生成する。 */
export function buildFireteams(scenario: Scenario, soldiers: Soldier[]): FireteamState[] {
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
      watch: null,
      assignedRole: null,
      flankGoal: null,
      flankDone: false,
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
export function buildSquads(scenario: Scenario, soldiers: Soldier[]): SquadState[] {
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
      mission: { kind: "seize", target: { ...(spec?.objective ?? { x: 0, z: 0 }) } },
      advanceDir: { ...(spec?.advanceDir ?? s.facing) },
      rallyPoint: { ...(spec?.rallyPoint ?? s.pos) },
      lastReportTick: 0,
      lastDecisionTick: 0,
      casevacOrders: [],
      watch: null,
      commanderId: null,
      degradedSinceTick: null,
      assaultDoorId: null,
      clearedDoorIds: [],
      flank: null,
      flankGoal: null,
      flankAssault: false,
    });
  }
  return [...seen.values()];
}

/** 編成に存在する (陣営, 小隊) の組ごとに小隊長コントローラを生成する。 */
export function buildPlatoons(scenario: Scenario, soldiers: Soldier[]): PlatoonState[] {
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
      squadMissions: new Map(),
      squadTechniques: new Map(),
      squadReports: new Map(),
      flot: { ...NO_FLOT },
      consolidation: null,
      objective: { ...(spec?.objective ?? { x: 0, z: 0 }) },
      mission: { kind: "seize", target: { ...(spec?.objective ?? { x: 0, z: 0 }) } },
      advanceDir: { ...(spec?.advanceDir ?? s.facing) },
      rallyPoint: { ...(spec?.rallyPoint ?? s.pos) },
      lastReportTick: 0,
      lastDecisionTick: 0,
      commanderId: null,
      degradedSinceTick: null,
      flank: null,
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
      platoonMissions: new Map(),
      platoonReports: new Map(),
      flot: { ...NO_FLOT },
      objective: { ...(spec?.objective ?? { x: 0, z: 0 }) },
      advanceDir: { ...advanceDir },
      rallyPoint: { ...(spec?.rallyPoint ?? cp) },
      lastDecisionTick: 0,
      assets: Array.from({ length: CASEVAC_ASSETS_PER_COMPANY }, () => ({
        id: assetId++,
        arriveTick: null,
      })),
      // 迫撃砲(`[v6.9]` 仕様 §10/§11)。**使った数**を持つ — 保有数はドクトリンの
      // `fireSupport` に掛かるので、実行中にドクトリンを切り替えても矛盾しない
      mortarRoundsUsed: 0,
      lastFireMissionTick: 0,
      // 立案フェーズを踏んだときだけ `beginPlanning` が入れる(`[v6.5]`)
      plan: null,
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

/**
 * 視線・移動の判定対象を差し替える。**空間索引を必ず一緒に張り直す**ので、
 * `world.walls` へ直接代入するのではなく必ずここを通すこと(`[v6.2]`)。
 * 索引だけ古いままだと、見えないはずの壁越しに視線が通るなどの形で静かに壊れる。
 */
export function setBlockers(world: World, walls: AABB[]): void {
  world.walls = walls;
  world.wallIndex = buildWallIndex(walls, world.bounds);
}

/**
 * この建物の屋内ナビグリッドを張る(まだ無ければ)。`[v6.3]`
 *
 * 突入が決まった時点で呼ぶ。屋外の移動は屋外グリッドで完結するので、突入しない建物の
 * 屋内グリッドは作らない — 市街地マップが100棟規模になると全棟ぶんは持てない。
 * 兵士が保持している経路はワールド座標の列なので、張り直しても無効化されない。
 */
export function activateBuildingNav(world: World, buildingId: number): void {
  if (world.navBuildings.has(buildingId)) return;
  const b = world.buildings.find((x) => x.id === buildingId);
  if (!b) return;
  world.navBuildings.add(buildingId);
  // 全体を作り直さない。屋外グリッドは最初から全建物の内部を除いてあるので、
  // この1棟の細グリッドと継ぎ目を**追記**するだけでよい(`[v6.3]`)。
  appendBuildingNav(
    world.nav,
    world.navWalls,
    world.bounds,
    b,
    CQB.NAV_STEP,
    CQB.NAV_MARGIN,
    NAV_STEP_OUTDOOR,
  );
}

/** 扉の開閉が変わったあとに呼ぶ。視線・移動の判定対象と、その空間索引を組み直す。 */
export function refreshBlockers(world: World): void {
  setBlockers(world, blockersOf(world.structuralWalls, world.doors));
}

function buildWorld(scenario: Scenario): World {
  const structuralWalls = scenario.walls.map((w) => ({ ...w }));
  // 経路探索用は「視線用の壁 + 窓の栓」(`[v6.10]`)。差分で持つので、シナリオが
  // どこにどれだけ壁を足しても経路側へ取りこぼしようがない
  const navWalls = [
    ...structuralWalls.map((w) => ({ ...w })),
    ...(scenario.windowPlugs ?? []).map((w) => ({ ...w })),
  ];
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
  // `[v6.3]` 起動時に細グリッドを張るのは**拠点を含む建物だけ**。それ以外は
  // 突入が決まった時点で `activateBuildingNav` が張る。
  const navBuildings = new Set<number>(
    buildings
      .filter((b) =>
        (scenario.objectives ?? []).some(
          (o) =>
            o.pos.x >= b.bounds.minX &&
            o.pos.x <= b.bounds.maxX &&
            o.pos.z >= b.bounds.minZ &&
            o.pos.z <= b.bounds.maxZ,
        ),
      )
      .map((b) => b.id),
  );
  // `[v6.12]` シナリオが指定した建物(塹壕)も最初から張る
  for (const id of scenario.navBuildingIds ?? []) navBuildings.add(id);
  const nav = buildNavSet(
    navWalls,
    scenario.bounds,
    NAV_STEP_OUTDOOR,
    NAV_MARGIN_OUTDOOR,
    buildings,
    buildings.filter((b) => navBuildings.has(b.id)),
    CQB.NAV_STEP,
    CQB.NAV_MARGIN,
  );
  // 遮蔽は**窓の空いていない壁**から作る(`[v6.10]`)。窓は視線を通すだけで、
  // 壁そのものが薄くなるわけではない。穴の空いた壁から作ると建物の外面に沿った
  // 遮蔽点が消え、接敵中の兵士が壁に寄らず開豁地に立ち続ける
  // (実測: 開豁地で静止したまま撃ち合う割合 9.7% → 15.2%)。
  const coverPoints = buildCoverPoints(navWalls, scenario.bounds, buildings);
  const coverIndex = buildCoverIndex(coverPoints, scenario.bounds);
  const soldiers = scenario.soldiers.map(cloneSoldier);
  const soldierById = new Map(soldiers.map((s) => [s.id, s]));

  const mode: BattleMode = scenario.mode ?? "meeting";
  const attacker: Side = scenario.attacker ?? "blue";
  return {
    tick: 0,
    phase: "battle",
    mode,
    attacker,
    timeLimitTicks:
      mode === "assault"
        ? Math.round((scenario.timeLimitSec ?? OBJECTIVE.ASSAULT_TIME_LIMIT_SEC) * SIM_HZ)
        : 0,
    bounds: { ...scenario.bounds },
    walls,
    wallIndex: buildWallIndex(walls, scenario.bounds),
    structuralWalls,
    navWalls,
    buildings,
    doors,
    nav,
    navBuildings,
    coverPoints,
    coverIndex,
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
    fireMissions: [],
    nextFireMissionId: 1,
    controlMeasures: (scenario.controlMeasures ?? []).map((cm) => ({
      ...cm,
      points: cm.points.map((p) => ({ ...p })),
    })),
    ccp: {
      blue: { ...(scenario.ccp?.blue ?? defaultCcp(soldiers, "blue")) },
      red: { ...(scenario.ccp?.red ?? defaultCcp(soldiers, "red")) },
    },
    // 攻防戦では**防御側が最初から全拠点を保有する**(仕様 §12)。`[v6.8]`
    // これだけで守備のC2(`assignHolders`)が開始直後から働き、防御側は拠点に張り付く。
    objectives: (scenario.objectives ?? []).map((o) => ({
      ...o,
      pos: { ...o.pos },
      owner: mode === "assault" ? defenderOf(attacker) : null,
      progress: mode === "assault" ? 1 : 0,
      progressBy: mode === "assault" ? defenderOf(attacker) : null,
      contested: false,
    })),
    majoritySince: { blue: null, red: null },
    victory: null,
    control: null,
    agentSeats: [],
    reinforcement: {
      blue: { spec: activeReinforcement(scenario, "blue"), callsUsed: 0, pending: [], arrived: 0 },
      red: { spec: activeReinforcement(scenario, "red"), callsUsed: 0, pending: [], arrived: 0 },
    },
    fx: [],
    tuning: defaultTuning(),
    posture: defaultPosture(),
    doctrine: defaultDoctrine(),
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
