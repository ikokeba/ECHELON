/**
 * シナリオ生成。現時点では兵士の既定構築と、レンダラの立ち上げおよび決定性・
 * 戦力対称性テストで使うシナリオ2種のみ。
 * 実運用のシナリオは src/scenarios/ 配下のJSONになる予定(design §2, AD-10)。
 * このファイルはプログラム的なフィクスチャとして残す。
 */

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

export interface SoldierSeed {
  side: Side;
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
  quals?: Partial<Soldier["quals"]>;
}

export function makeSoldier(seed: SoldierSeed): Soldier {
  const facing = seed.facing ?? { x: 0, z: seed.side === "blue" ? 1 : -1 };
  return {
    id: nextId++,
    side: seed.side,
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
    role: seed.role ?? "rifleman",
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

/** 9名の分隊: 分隊長1 + 4名FT×2。`dir` 方向を向いて横並びに配置する(仕様 §2)。 */
function makeSquad(
  side: Side,
  platoonId: number,
  squadId: number,
  anchor: Vec2,
  dir: Vec2,
): Soldier[] {
  const right = { x: -dir.z, z: dir.x };
  const soldiers: Soldier[] = [];

  soldiers.push(
    makeSoldier({
      side,
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
      ),
    );
  });
  return {
    soldiers,
    plans: plansFor(side, platoonId, squadIds, objective, dir, center),
  };
}

/**
 * 1個小隊 vs 1個小隊(各3個分隊 = 27名)。
 *
 * 仕様 §5 の情報階層化が意味を持つ最小規模: 小隊長は3個分隊を無線報告だけで捌く。
 * 分隊は横に離して配置するので、各分隊長の視界は互いに重ならず、小隊長のもとには
 * 断片的な報告だけが遅れて届く。
 *
 * 仕様上の小隊は3個ライフル分隊+火器分隊+小隊本部の約40名(§2)だが、
 * 火器分隊と小隊本部は未実装のため現状は3個ライフル分隊のみ。
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
 * 1個中隊 vs 1個中隊(各3個小隊 × 3個分隊 = 81名、両軍162名)。
 *
 * 仕様 §2 が想定する規模(中隊 = 3〜4個小隊)の下限。火器分隊・小隊本部・中隊本部が
 * 未実装のため、仕様上の約130名/中隊には届いていない。
 *
 * 中隊長のC2はまだ存在しないため、3個小隊はそれぞれ独立に動く。この状態でも
 * 規模のパフォーマンス特性(design OQ-5)は測れる。
 */
export function companyClashScenario(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -110, maxX: 110, minZ: -70, maxZ: 70 };
  const objective = { x: 0, z: 0 };

  /** 小隊の初期展開間隔(m)。分隊3個分の正面幅より広く取る */
  const PLATOON_SPACING = 110;

  const soldiers: Soldier[] = [];
  const fireteamPlans: FireteamPlan[] = [];
  const squadPlans: SquadPlan[] = [];
  const platoonPlans: PlatoonPlan[] = [];

  for (let p = 0; p < 3; p++) {
    const lateral = (p - 1) * PLATOON_SPACING * 0.5;
    const blue = buildPlatoon(
      "blue",
      p,
      [p * 10, p * 10 + 1, p * 10 + 2],
      { x: lateral, z: -58 },
      { x: 0, z: 1 },
      objective,
    );
    // 点対称になるよう座標も向きも反転させる
    const red = buildPlatoon(
      "red",
      100 + p,
      [1000 + p * 10, 1000 + p * 10 + 1, 1000 + p * 10 + 2],
      { x: -lateral, z: 58 },
      { x: 0, z: -1 },
      objective,
    );
    soldiers.push(...blue.soldiers, ...red.soldiers);
    fireteamPlans.push(...blue.plans.fireteamPlans, ...red.plans.fireteamPlans);
    squadPlans.push(...blue.plans.squadPlans, ...red.plans.squadPlans);
    platoonPlans.push(...blue.plans.platoonPlans, ...red.plans.platoonPlans);
  }

  return {
    name: "company-clash",
    seed,
    bounds,
    walls: symmetricWalls(),
    soldiers,
    fireteamPlans,
    squadPlans,
    platoonPlans,
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ ...objective }] }],
  };
}
