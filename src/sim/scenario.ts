/**
 * シナリオ生成。現時点では兵士の既定構築と、レンダラの立ち上げおよび決定性・
 * 戦力対称性テストで使うシナリオ2種のみ。
 * 実運用のシナリオは src/scenarios/ 配下のJSONになる予定(design §2, AD-10)。
 * このファイルはプログラム的なフィクスチャとして残す。
 */

import { makeSimpleBuilding } from "./cqb.ts";
import type {
  AABB,
  Bounds,
  FireteamPlan,
  PlatoonPlan,
  Scenario,
  Side,
  Soldier,
  SquadPlan,
  Vec2,
} from "./types.ts";

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}

/** UIから選べるシナリオの一覧。規模の段階を上げていくと階層が1つずつ増える。 */
export const SCENARIOS = {
  squad: {
    label: "分隊 vs 分隊",
    detail: "各9名。分隊長〜FTリーダーの2階層",
    make: (seed?: number) => demoCrossingScenario(seed),
  },
  platoon: {
    label: "小隊 vs 小隊",
    detail: "各29名。無線報告で捌く小隊長が加わる",
    make: (seed?: number) => platoonClashScenario(seed),
  },
  company: {
    label: "中隊 vs 中隊",
    detail: "各91名。CP・CCP・後送アセットを含む5階層すべて",
    make: (seed?: number) => companyClashScenario(seed),
  },
  urban: {
    label: "市街地(CQB)",
    detail: "建物の争奪。スタック→ブリーチ→室内掃討(仕様 §7)",
    make: (seed?: number) => urbanAssaultScenario(seed),
  },
} as const;

export type ScenarioKey = keyof typeof SCENARIOS;

export interface SoldierSeed {
  side: Side;
  companyId?: number;
  platoonId: number;
  squadId: number;
  fireteamId: number;
  isFireteamLeader?: boolean;
  isSquadLeader?: boolean;
  pos: Vec2;
  facing?: Vec2;
  moveTo?: Vec2;
  traits?: Partial<Soldier["traits"]>;
  role?: Soldier["role"];
  hqRole?: Soldier["hqRole"];
  quals?: Partial<Soldier["quals"]>;
}

export function makeSoldier(seed: SoldierSeed): Soldier {
  const facing = seed.facing ?? { x: 0, z: seed.side === "blue" ? 1 : -1 };
  return {
    id: nextId++,
    side: seed.side,
    companyId: seed.companyId ?? 0,
    platoonId: seed.platoonId,
    squadId: seed.squadId,
    fireteamId: seed.fireteamId,
    isFireteamLeader: seed.isFireteamLeader ?? false,
    isSquadLeader: seed.isSquadLeader ?? false,
    pos: { ...seed.pos },
    facing: { ...facing },
    status: "ok",
    suppressedUntilTick: 0,
    bleedOutTick: 0,
    order: seed.moveTo
      ? { kind: "move", target: { ...seed.moveTo }, issuedTick: 0 }
      : { kind: "hold", facing: { ...facing }, issuedTick: 0 },
    path: [],
    pathIdx: 0,
    sees: [],
    suppressor: false,
    eye: { ...seed.pos },
    peeking: false,
    role: seed.role ?? "rifleman",
    hqRole: seed.hqRole ?? null,
    quals: {
      medicalCrossTrained: seed.quals?.medicalCrossTrained ?? false,
      designatedMarksman: seed.quals?.designatedMarksman ?? false,
    },
    assignedAider: null,
    treating: null,
    aidProgressTicks: 0,
    stabilized: false,
    evac: "none",
    bearers: [],
    bearing: null,
    speedMul: 1,
    traits: {
      aggressiveness: seed.traits?.aggressiveness ?? 0.5,
      boldness: seed.traits?.boldness ?? 0.5,
      caution: seed.traits?.caution ?? 0.5,
    },
  };
}

/**
 * 本部要員が持つ、分隊コントローラを持たないことを表す squadId(仕様 §2)。
 * 負値であることに意味がある — world.ts の分隊/FT構築はここを見て弾く。
 */
export const HQ_SQUAD_ID = { platoon: -1, company: -2 } as const;

/**
 * 小隊本部(仕様 §2)。小隊長 + 無線手の2名編成 `[v6]`。
 *
 * 身体を持たせる目的は §12 の指揮官排除を成立させること。排除できない指揮官では、
 * 「指揮系統の崩壊」が勝利への近道条件として機能しない。
 */
function makePlatoonHq(
  side: Side,
  companyId: number,
  platoonId: number,
  anchor: Vec2,
  dir: Vec2,
): Soldier[] {
  const right = { x: -dir.z, z: dir.x };
  return (["pl", "plRto"] as const).map((hqRole, i) =>
    makeSoldier({
      side,
      companyId,
      platoonId,
      squadId: HQ_SQUAD_ID.platoon,
      fireteamId: -1,
      pos: {
        x: anchor.x + right.x * (i * 1.6 - 0.8),
        z: anchor.z + right.z * (i * 1.6 - 0.8),
      },
      facing: dir,
      hqRole,
    }),
  );
}

/**
 * 中隊本部(仕様 §2: XO/1SG/RTO は役割ごとに固定配置、直接操作は不可)。
 *
 * 中隊長・XO・RTOは指揮所(CP)に、1SGは負傷者集合点(CCP)に常駐する。
 * 1SGがCCPにいるのは「中隊トレインを運営する」現実の役割に対応させたもの(仕様 §2)。
 */
function makeCompanyHq(
  side: Side,
  companyId: number,
  cp: Vec2,
  ccp: Vec2,
  dir: Vec2,
): Soldier[] {
  const right = { x: -dir.z, z: dir.x };
  const atCp = (["co", "xo", "coRto"] as const).map((hqRole, i) =>
    makeSoldier({
      side,
      companyId,
      platoonId: -1,
      squadId: HQ_SQUAD_ID.company,
      fireteamId: -1,
      pos: { x: cp.x + right.x * (i - 1) * 1.8, z: cp.z + right.z * (i - 1) * 1.8 },
      facing: dir,
      hqRole,
    }),
  );
  const firstSergeant = makeSoldier({
    side,
    companyId,
    platoonId: -1,
    squadId: HQ_SQUAD_ID.company,
    fireteamId: -1,
    pos: { x: ccp.x, z: ccp.z },
    facing: dir,
    hqRole: "firstSergeant",
    // 1SGはCCP常駐で衛生実務を回すため、衛生要員兼任として扱う(仕様 §2 の中隊トレイン)
    quals: { medicalCrossTrained: true },
  });
  return [...atCp, firstSergeant];
}

/** 9名の分隊: 分隊長1 + 4名FT×2。`dir` 方向を向いて横並びに配置する(仕様 §2)。 */
function makeSquad(
  side: Side,
  platoonId: number,
  squadId: number,
  anchor: Vec2,
  dir: Vec2,
  companyId = 0,
): Soldier[] {
  const right = { x: -dir.z, z: dir.x };
  const soldiers: Soldier[] = [];

  soldiers.push(
    makeSoldier({
      side,
      companyId,
      platoonId,
      squadId,
      fireteamId: -1,
      isSquadLeader: true,
      pos: { x: anchor.x, z: anchor.z },
      facing: dir,
    }),
  );

  // FT内のMOS構成(仕様 §14 / mos-balance-simulator の4名編成):
  //   0 = FTリーダー, 1 = SAW手, 2 = 擲弾手, 3 = ライフルマン
  const ROLES: Soldier["role"][] = ["leader", "saw", "grenadier", "rifleman"];

  for (let ft = 0; ft < 2; ft++) {
    for (let m = 0; m < 4; m++) {
      const lateral = (ft === 0 ? -1 : 1) * 3 + (m - 1.5) * 1.6;
      const back = (m % 2) * -1.6 - ft * 0.4;
      soldiers.push(
        makeSoldier({
          side,
          companyId,
          platoonId,
          squadId,
          fireteamId: ft,
          isFireteamLeader: m === 0,
          pos: {
            x: anchor.x + right.x * lateral + dir.x * back,
            z: anchor.z + right.z * lateral + dir.z * back,
          },
          facing: dir,
          role: ROLES[m],
          quals: {
            // 各FTのライフルマン1名が衛生要員を兼任(仕様 §9/§14 `[v6]`)
            medicalCrossTrained: m === 3,
            // 選抜射手は分隊に1名、ブラボー組(ft=1)のライフルマンが兼任(仕様 §14)
            designatedMarksman: ft === 1 && m === 3,
          },
        }),
      );
    }
  }
  return soldiers;
}

/** 1象限分の壁リストを両軸に鏡像展開する。 */
function mirror(base: AABB[]): AABB[] {
  const out: AABB[] = [];
  for (const w of base) {
    out.push({ ...w });
    out.push({ ...w, cx: -w.cx });
    out.push({ ...w, cz: -w.cz });
    out.push({ ...w, cx: -w.cx, cz: -w.cz });
  }
  return out;
}

/**
 * 原点まわりの180°回転に対して対称な壁配置を作る。
 * 両陣営が本当に公平な盤面で戦うために必須(仕様 §2/§13)。
 */
function symmetricWalls(): AABB[] {
  const walls = mirror([
    { cx: 10, cz: 4, hw: 4, hd: 0.4 },
    { cx: 18, cz: 10, hw: 0.4, hd: 3 },
    { cx: 6, cz: 12, hw: 2.5, hd: 0.4 },
    { cx: 24, cz: 3, hw: 0.4, hd: 2.5 },
    { cx: 3, cz: 3, hw: 0.6, hd: 0.6 },
    { cx: 30, cz: 14, hw: 3, hd: 0.4 },
    { cx: 38, cz: 6, hw: 0.4, hd: 3 },
    { cx: 44, cz: 16, hw: 2, hd: 0.4 },
    { cx: 14, cz: 20, hw: 0.4, hd: 2.5 },
    { cx: 34, cz: 22, hw: 2.5, hd: 0.4 },
  ]);
  // 中央施設 — ピンホイール形状(180°回転対称)
  walls.push(
    { cx: 1.4, cz: 3, hw: 1.6, hd: 0.4 },
    { cx: -1.4, cz: -3, hw: 1.6, hd: 0.4 },
    { cx: 3, cz: -1.4, hw: 0.4, hd: 1.6 },
    { cx: -3, cz: 1.4, hw: 0.4, hd: 1.6 },
  );
  return walls;
}

function plansFor(
  side: Side,
  platoonId: number,
  squadIds: number[],
  objective: Vec2,
  advanceDir: Vec2,
  rallyPoint: Vec2,
  companyId = 0,
): { fireteamPlans: FireteamPlan[]; squadPlans: SquadPlan[]; platoonPlans: PlatoonPlan[] } {
  return {
    fireteamPlans: squadIds.flatMap((squadId) =>
      [0, 1].map((ftIndex) => ({
        side,
        squadId,
        ftIndex,
        objective: { ...objective },
        advanceDir: { ...advanceDir },
        rallyPoint: { ...rallyPoint },
      })),
    ),
    squadPlans: squadIds.map((squadId) => ({
      side,
      squadId,
      platoonId,
      objective: { ...objective },
      advanceDir: { ...advanceDir },
      rallyPoint: { ...rallyPoint },
    })),
    platoonPlans: [
      {
        side,
        platoonId,
        companyId,
        objective: { ...objective },
        advanceDir: { ...advanceDir },
        rallyPoint: { ...rallyPoint },
      },
    ],
  };
}

/**
 * 1個分隊 vs 1個分隊(各9名)。分隊層以下の検証用の最小シナリオ。
 * 両分隊とも同一の中央目標へ向かうよう命令されるため、必ず接敵して戦闘になる。
 */
export function demoCrossingScenario(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -32, maxX: 32, minZ: -22, maxZ: 22 };
  const blueStart = { x: 0, z: -17 };
  const redStart = { x: 0, z: 17 };
  const objective = { x: 0, z: 0 };

  const soldiers = [
    ...makeSquad("blue", 0, 0, blueStart, { x: 0, z: 1 }),
    ...makeSquad("red", 1, 1, redStart, { x: 0, z: -1 }),
  ];

  const blue = plansFor("blue", 0, [0], objective, { x: 0, z: 1 }, blueStart);
  const red = plansFor("red", 1, [1], objective, { x: 0, z: -1 }, redStart);

  return {
    name: "demo-crossing",
    seed,
    bounds,
    walls: symmetricWalls().filter(
      (w) => Math.abs(w.cx) <= 30 && Math.abs(w.cz) <= 20,
    ),
    soldiers,
    fireteamPlans: [...blue.fireteamPlans, ...red.fireteamPlans],
    squadPlans: [...blue.squadPlans, ...red.squadPlans],
    platoonPlans: [...blue.platoonPlans, ...red.platoonPlans],
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ ...objective }] }],
  };
}

/** 分隊の初期展開間隔(m)。互いの視界(20m)が重ならない程度に離す */
const SQUAD_SPACING = 30;

/**
 * 小隊1個分の兵士と計画を組み立てる共通処理。
 * `platoonClashScenario` と `companyClashScenario` の両方から使う。
 */
function buildPlatoon(
  side: Side,
  platoonId: number,
  squadIds: number[],
  center: Vec2,
  dir: Vec2,
  objective: Vec2,
  companyId = 0,
): {
  soldiers: Soldier[];
  plans: ReturnType<typeof plansFor>;
} {
  const right = { x: -dir.z, z: dir.x };
  const soldiers: Soldier[] = [];
  squadIds.forEach((squadId, i) => {
    const lateral = (i - (squadIds.length - 1) / 2) * SQUAD_SPACING;
    soldiers.push(
      ...makeSquad(
        side,
        platoonId,
        squadId,
        { x: center.x + right.x * lateral, z: center.z + right.z * lateral },
        dir,
        companyId,
      ),
    );
  });
  // 小隊本部は分隊列の後方に置く(仕様 §2/§3②: 小隊長は担当区域全体を見渡す位置)
  soldiers.push(
    ...makePlatoonHq(
      side,
      companyId,
      platoonId,
      { x: center.x - dir.x * 10, z: center.z - dir.z * 10 },
      dir,
    ),
  );
  return {
    soldiers,
    plans: plansFor(side, platoonId, squadIds, objective, dir, center, companyId),
  };
}

/**
 * 1個小隊 vs 1個小隊(各3個分隊 = 27名)。
 *
 * 仕様 §5 の情報階層化が意味を持つ最小規模: 小隊長は3個分隊を無線報告だけで捌く。
 * 分隊は横に離して配置するので、各分隊長の視界は互いに重ならず、小隊長のもとには
 * 断片的な報告だけが遅れて届く。
 *
 * 仕様上の小隊は3個ライフル分隊+火器分隊+小隊本部の約40名(§2)。
 * `[v6]` で小隊本部(小隊長+無線手)を追加したため現状29名。火器分隊は未実装。
 */
export function platoonClashScenario(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -56, maxX: 56, minZ: -40, maxZ: 40 };
  const objective = { x: 0, z: 0 };

  const blue = buildPlatoon("blue", 0, [0, 1, 2], { x: 0, z: -32 }, { x: 0, z: 1 }, objective);
  const red = buildPlatoon("red", 1, [10, 11, 12], { x: 0, z: 32 }, { x: 0, z: -1 }, objective);

  return {
    name: "platoon-clash",
    seed,
    bounds,
    walls: symmetricWalls(),
    soldiers: [...blue.soldiers, ...red.soldiers],
    fireteamPlans: [...blue.plans.fireteamPlans, ...red.plans.fireteamPlans],
    squadPlans: [...blue.plans.squadPlans, ...red.plans.squadPlans],
    platoonPlans: [...blue.plans.platoonPlans, ...red.plans.platoonPlans],
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ ...objective }] }],
  };
}

/**
 * 1個中隊 vs 1個中隊(各3個小隊 × (3個分隊+小隊本部) + 中隊本部 = 91名、両軍182名)。
 *
 * 仕様 §2 が想定する規模(中隊 = 3〜4個小隊)の下限。火器分隊が未実装のため、
 * 仕様上の約130名/中隊にはまだ届いていない。
 *
 * `[v6]` 中隊長のC2・小隊本部・中隊本部・CP・CCPを追加し、5階層すべてが揃った。
 */
export function companyClashScenario(seed = 1): Scenario {
  resetIds();
  // CP(z=±70)とCCP(z=±78)を盤内に収める必要がある。ナビグリッドは bounds から
  // 作られるので、CCPが外に出ると担架班が永久にたどり着けない(実際に描画で発見した)。
  const bounds: Bounds = { minX: -110, maxX: 110, minZ: -85, maxZ: 85 };
  const objective = { x: 0, z: 0 };

  /** 小隊の初期展開間隔(m)。分隊3個分の正面幅より広く取る */
  const PLATOON_SPACING = 110;

  const soldiers: Soldier[] = [];
  const fireteamPlans: FireteamPlan[] = [];
  const squadPlans: SquadPlan[] = [];
  const platoonPlans: PlatoonPlan[] = [];

  // 指揮所(CP)と負傷者集合点(CCP)は中隊の後方に置く(仕様 §11)。
  // 点対称を保つため両陣営で符号を反転させる。
  const blueCcp = { x: 0, z: -78 };
  const redCcp = { x: 0, z: 78 };
  const blueCp = { x: 0, z: -70 };
  const redCp = { x: 0, z: 70 };

  for (let p = 0; p < 3; p++) {
    const lateral = (p - 1) * PLATOON_SPACING * 0.5;
    const blue = buildPlatoon(
      "blue",
      p,
      [p * 10, p * 10 + 1, p * 10 + 2],
      { x: lateral, z: -58 },
      { x: 0, z: 1 },
      objective,
      0,
    );
    // 点対称になるよう座標も向きも反転させる
    const red = buildPlatoon(
      "red",
      100 + p,
      [1000 + p * 10, 1000 + p * 10 + 1, 1000 + p * 10 + 2],
      { x: -lateral, z: 58 },
      { x: 0, z: -1 },
      objective,
      1,
    );
    soldiers.push(...blue.soldiers, ...red.soldiers);
    fireteamPlans.push(...blue.plans.fireteamPlans, ...red.plans.fireteamPlans);
    squadPlans.push(...blue.plans.squadPlans, ...red.plans.squadPlans);
    platoonPlans.push(...blue.plans.platoonPlans, ...red.plans.platoonPlans);
  }

  soldiers.push(
    ...makeCompanyHq("blue", 0, blueCp, blueCcp, { x: 0, z: 1 }),
    ...makeCompanyHq("red", 1, redCp, redCcp, { x: 0, z: -1 }),
  );

  return {
    name: "company-clash",
    seed,
    bounds,
    walls: symmetricWalls(),
    soldiers,
    fireteamPlans,
    squadPlans,
    platoonPlans,
    companyPlans: [
      {
        side: "blue",
        companyId: 0,
        objective: { ...objective },
        advanceDir: { x: 0, z: 1 },
        rallyPoint: { ...blueCp },
        cp: { ...blueCp },
      },
      {
        side: "red",
        companyId: 1,
        objective: { ...objective },
        advanceDir: { x: 0, z: -1 },
        rallyPoint: { ...redCp },
        cp: { ...redCp },
      },
    ],
    ccp: { blue: { ...blueCcp }, red: { ...redCcp } },
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ ...objective }] }],
  };
}

/**
 * 市街地戦(CQB)シナリオ。1個分隊 vs 1個分隊で、中央の建物を争奪する(仕様 §7)。
 *
 * 屋外と屋内はシームレスな1つのマップ(仕様 §7.1)。両分隊とも建物内部を任務目標と
 * するため、必ず「街路を進む → 扉にスタック → ブリーチ → 室内掃討」の流れになる。
 * 建物は原点まわりに点対称な位置へ2棟置き、扉を互いに反対側へ向けて公平を保つ
 * (仕様 §2/§13)。
 */
export function urbanAssaultScenario(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -40, maxX: 40, minZ: -34, maxZ: 34 };

  // 建物2棟。180°回転で互いに重なる位置・向きに置く
  const north = makeSimpleBuilding(1, { minX: -7, maxX: 3, minZ: 4, maxZ: 12 }, "south");
  const south = makeSimpleBuilding(2, { minX: -3, maxX: 7, minZ: -12, maxZ: -4 }, "north");

  // 遮蔽としての街路構造。これも点対称に置く
  const streetWalls: AABB[] = [];
  for (const [cx, cz, hw, hd] of [
    [16, 8, 3, 0.4],
    [24, -2, 0.4, 3],
    [12, -14, 2.5, 0.4],
    [30, 6, 0.4, 2.5],
  ] as const) {
    streetWalls.push({ cx, cz, hw, hd });
    streetWalls.push({ cx: -cx, cz: -cz, hw, hd });
  }

  const blueStart = { x: 0, z: -26 };
  const redStart = { x: 0, z: 26 };
  // 各分隊の任務目標は「敵側の建物の中」。必ず突入が発生する
  const blueObjective = { x: -2, z: 8 };
  const redObjective = { x: 2, z: -8 };

  const soldiers = [
    ...makeSquad("blue", 0, 0, blueStart, { x: 0, z: 1 }),
    ...makeSquad("red", 1, 1, redStart, { x: 0, z: -1 }),
  ];

  const blue = plansFor("blue", 0, [0], blueObjective, { x: 0, z: 1 }, blueStart);
  const red = plansFor("red", 1, [1], redObjective, { x: 0, z: -1 }, redStart);

  return {
    name: "urban-assault",
    seed,
    bounds,
    walls: [...north.walls, ...south.walls, ...streetWalls],
    buildings: [north.building, south.building],
    soldiers,
    fireteamPlans: [...blue.fireteamPlans, ...red.fireteamPlans],
    squadPlans: [...blue.squadPlans, ...red.squadPlans],
    platoonPlans: [...blue.platoonPlans, ...red.platoonPlans],
    ccp: { blue: { x: 0, z: -30 }, red: { x: 0, z: 30 } },
    controlMeasures: [
      { kind: "OBJ", label: "OBJ NORTH", points: [{ ...blueObjective }] },
      { kind: "OBJ", label: "OBJ SOUTH", points: [{ ...redObjective }] },
    ],
  };
}
