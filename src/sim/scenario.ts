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

  /** 分隊の初期展開間隔(m)。互いの視界(20m)が重ならない程度に離す */
  const SQUAD_SPACING = 30;
  const blueZ = -32;
  const redZ = 32;

  const soldiers: Soldier[] = [];
  const blueSquadIds = [0, 1, 2];
  const redSquadIds = [10, 11, 12];

  blueSquadIds.forEach((squadId, i) => {
    const x = (i - 1) * SQUAD_SPACING;
    soldiers.push(...makeSquad("blue", 0, squadId, { x, z: blueZ }, { x: 0, z: 1 }));
  });
  redSquadIds.forEach((squadId, i) => {
    // 点対称になるよう、順序も座標も反転させる
    const x = -(i - 1) * SQUAD_SPACING;
    soldiers.push(...makeSquad("red", 1, squadId, { x, z: redZ }, { x: 0, z: -1 }));
  });

  const blue = plansFor("blue", 0, blueSquadIds, objective, { x: 0, z: 1 }, { x: 0, z: blueZ });
  const red = plansFor("red", 1, redSquadIds, objective, { x: 0, z: -1 }, { x: 0, z: redZ });

  return {
    name: "platoon-clash",
    seed,
    bounds,
    walls: symmetricWalls(),
    soldiers,
    fireteamPlans: [...blue.fireteamPlans, ...red.fireteamPlans],
    squadPlans: [...blue.squadPlans, ...red.squadPlans],
    platoonPlans: [...blue.platoonPlans, ...red.platoonPlans],
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ ...objective }] }],
  };
}
