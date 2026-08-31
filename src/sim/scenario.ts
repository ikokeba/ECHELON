/**
 * シナリオ生成。現時点では兵士の既定構築と、レンダラの立ち上げおよび決定性・
 * 戦力対称性テストで使うシナリオ2種のみ。
 * 実運用のシナリオは src/scenarios/ 配下のJSONになる予定(design §2, AD-10)。
 * このファイルはプログラム的なフィクスチャとして残す。
 */

import { GRENADE, OBJECTIVE } from "./constants.ts";
import { traitProfile } from "./traits.ts";
import {
  deepestRoomCenter,
  makeCorridorBuilding,
  makeSimpleBuilding,
  type DoorSide,
} from "./cqb.ts";
import type {
  AABB,
  Bounds,
  Building,
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
  /** 自軍の中での編成上の通し番号(鏡像で一致すること)。`[v6.3]` */
  ordinal?: number;
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
    evadeUntilTick: 0,
    observedByEnemy: false,
    assaultingUntilTick: 0,
    holdFireUntilTick: 0,
    // 擲弾は擲弾手のみが携行する(仕様 §14: 3発/戦闘)
    grenades: (seed.role ?? "rifleman") === "grenadier" ? GRENADE.CHARGES : 0,
    routed: false,
    bleedOutTick: 0,
    order: seed.moveTo
      ? { kind: "move", target: { ...seed.moveTo }, issuedTick: 0 }
      : { kind: "hold", facing: { ...facing }, issuedTick: 0 },
    path: [],
    pathIdx: 0,
    stuckTicks: 0,
    sees: [],
    suppressor: false,
    assignedTarget: null,
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
    ordinal: seed.ordinal ?? 0,
    seesFar: [],
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
  /**
   * 自軍の中での分隊の通し番号(`[v6.2]` OQ-6)。個体差の割り当てに使う。
   * **両陣営で同じ番号が鏡像の分隊に振られること**が要件 — 詳細は traits.ts。
   */
  variant = 0,
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
      traits: traitProfile(variant * 16),
      ordinal: variant * 16,
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
          traits: traitProfile(variant * 16 + 1 + ft * 4 + m),
          ordinal: variant * 16 + 1 + ft * 4 + m,
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

/**
 * 火器分隊(小隊直轄の機関銃班、仕様 §2「M240系×2、通常分隊と同格」)。`[v6.1]`
 * 7名 = 分隊長1 + MG班2組(各: 機関銃射手1 + 副射手/弾薬手2)。
 * 仕様に内部数値がないため7名編成とした(小隊本部の2名編成と同じ扱いの暫定)。
 */
function makeWeaponsSquad(
  side: Side,
  platoonId: number,
  squadId: number,
  anchor: Vec2,
  dir: Vec2,
  companyId = 0,
  /** 自軍の中での通し番号(`[v6.2]` OQ-6)。個体差の割り当てに使う */
  variant = 0,
): Soldier[] {
  const right = { x: -dir.z, z: dir.x };
  const soldiers: Soldier[] = [
    makeSoldier({
      side,
      companyId,
      platoonId,
      squadId,
      fireteamId: -1,
      isSquadLeader: true,
      pos: { x: anchor.x, z: anchor.z },
      facing: dir,
      traits: traitProfile(variant * 16),
      ordinal: variant * 16,
    }),
  ];
  // 各班: 射手(mg) + 副射手 + 弾薬手。1丁につき射手1名 = 分隊に機関銃2丁。
  const ROLES: Soldier["role"][] = ["mg", "rifleman", "rifleman"];
  for (let ft = 0; ft < 2; ft++) {
    for (let m = 0; m < 3; m++) {
      const lateral = (ft === 0 ? -1 : 1) * 3 + (m - 1) * 1.6;
      const back = (m % 2) * -1.6;
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
          traits: traitProfile(variant * 16 + 1 + ft * 3 + m),
          ordinal: variant * 16 + 1 + ft * 3 + m,
          quals: { medicalCrossTrained: m === 2, designatedMarksman: false },
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
 *
 * `[v6.3]` `scale` で盤面ごと拡大できるようにした。射程を仕様 §10 の本来の値
 * (ライフル150m)へ戻した結果、従来の盤面では**展開地から敵展開地まで射程内**に
 * 入ってしまい、部隊が一歩も動かずに撃ち合う状態になったため。
 */
function symmetricWalls(scale = 1): AABB[] {
  const k = scale;
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
  // 位置だけ拡大し、遮蔽そのものの大きさは変えない(人体スケールの遮蔽のまま
  // 盤面だけ広くする)。壁が疎になるぶんは長射程の見通しとして意味を持つ。
  if (k === 1) return walls;
  return walls.map((w) => ({ cx: w.cx * k, cz: w.cz * k, hw: w.hw, hd: w.hd }));
}

/**
 * 建物の扉が向く面。**点対称((x,z)→(-x,-z))のもとで面も反転する**よう、
 * 規則を「原点対称で符号が反転する」形にしてある(南↔北、東↔西)。
 * これにより、ある建物と、その点対称の双子は、互いに厳密な鏡像の壁集合になる。
 */
function cityDoor(cx: number, cz: number): DoorSide {
  if (Math.abs(cx) >= 150) return cx < 0 ? "east" : "west"; // 外周列は内側(中心方向)を向く
  return cz < 0 ? "south" : "north"; // それ以外は中央広場側を向く
}

/**
 * 中隊戦のための市街地マップ。**原点まわりの180°回転に対して厳密に点対称**で、
 * 仕様 §2/§13 の戦力対称性(`test/symmetry.test.ts` のラベル入替=厳密反転)を保つ。
 *
 * 四角い建物 34 棟を街区状に並べ、あいだに南北・東西の街路を通す(= 十字路)。中央は
 * 建物を抜いて広場にし、そこを塞ぐ庁舎ペア + 千鳥配置の小屋で中央の縦走路を分断する
 * (= 迂回・寄り道を強いる)。左右の中間縦深にも広場を1つずつ空ける。建物どうしをつなぐ
 * 低い塀で通りの縁を作り、通り抜けを絞って路地・袋小路にしてある。
 *
 * `[v6.2]` 建物の中身は `makeCorridorBuilding` の**中廊下+区画**(奥行があれば前後2室)。
 * 分隊は1棟のなかでスタック→ブリーチ→掃討を部屋の数だけ繰り返す。
 *
 * `[v6.2]` 展開地(z=±58)の正面に**外縁の街区**(z≈±48)を置いてある。これが無いと
 * 街区の隙間が展開地から展開地まで一直線に抜けてしまい、選抜射手(索敵300m、仕様 §10)が
 * 誰も動かないうちから 120m 先を撃ち始める。仕様 §10 が前提にしている「市街地の見通し
 * 距離が交戦距離を自然に制限する」を成り立たせるための行。
 *
 * `cz < 0` 側だけを列挙し、各要素を点対称の双子として複製する。
 */
function symmetricCity(): { walls: AABB[]; buildings: Building[]; objectiveRoom: Vec2 } {
  // `[v6.3]` 街区は手置きの座標表ではなく**格子から生成**する。盤面を2倍(440×340)へ
  // 広げるにあたり、手置きでは棟数が100近くになって管理できないため。
  //
  // 生成規則:
  //   - 建物 24×16m を 36×30m の間隔で並べる(街路の幅が x12m / z14m 残る)
  //   - `cz < 0` 側だけ作り、点対称の双子を複製する(仕様 §2/§13)
  //   - `SKIP` に入る格子点は建物を置かず**広場**にする。拠点と、迂回を作る抜けを兼ねる
  const PITCH_X = 36;
  const PITCH_Z = 30;
  const HW = 12;
  const HD = 8;
  /** 街区を置く格子点。i は x 方向(±)、j は z 方向(手前から奥へ) */
  const COLS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  const ROWS = [-4, -3, -2, -1];
  /** 広場にする格子点 `i:j`。中央広場・左右の広場・迂回のための抜け */
  const SKIP = new Set(["0:-1", "-3:-2", "3:-2", "0:-3", "-1:-4", "1:-4"]);

  const half: Array<{ cx: number; cz: number; hw: number; hd: number }> = [];
  for (const j of ROWS) {
    for (const i of COLS) {
      if (SKIP.has(`${i}:${j}`)) continue;
      half.push({ cx: i * PITCH_X, cz: j * PITCH_Z + PITCH_Z / 2, hw: HW, hd: HD });
    }
  }
  // 中央広場(OBJ BRAVO)を塞ぐ庁舎。中央の縦走路を分断して迂回を強いる
  half.push({ cx: 0, cz: -PITCH_Z / 2 - 6, hw: 16, hd: 6 });

  const buildings: Building[] = [];
  const walls: AABB[] = [];
  let id = 1;
  const add = (cx: number, cz: number, hw: number, hd: number): void => {
    const b = makeCorridorBuilding(
      id++,
      { minX: cx - hw, maxX: cx + hw, minZ: cz - hd, maxZ: cz + hd },
      cityDoor(cx, cz),
    );
    buildings.push(b.building);
    walls.push(...b.walls);
  };
  for (const s of half) {
    add(s.cx, s.cz, s.hw, s.hd);
    add(-s.cx, -s.cz, s.hw, s.hd); // 点対称の双子(扉面は cityDoor が自動で反転)
  }

  // 街路の低い遮蔽(塀・車列・植栽)。cz≤0 側を列挙して点対称に複製する。
  // 建物どうしをつなぐ塀で通りの縁を作り、通り抜けを絞って路地・袋小路にする。
  const clutter: Array<{ cx: number; cz: number; hw: number; hd: number }> = [
    // 中央広場の微遮蔽 — OBJ BRAVO が完全な射殺場にならないように
    { cx: 5, cz: 6, hw: 3, hd: 0.5 },
    { cx: -7, cz: 2, hw: 0.5, hd: 3 },
    { cx: 9, cz: -4, hw: 0.5, hd: 2.5 },
    { cx: 20, cz: -9, hw: 0.5, hd: 5 }, // 広場の入口を絞る
    // 庁舎の脇 — 迂回路の角(覗き用の短い遮蔽)
    { cx: 16, cz: -18, hw: 2.5, hd: 0.5 },
    { cx: -4, cz: -33, hw: 6, hd: 0.5 }, // 庁舎南の張り出し塀。正面を左右へ振る
    // 外周の長い南北大通り沿い(選抜射手の射線が通る)
    { cx: 84, cz: -20, hw: 0.5, hd: 11 },
    { cx: 88, cz: -36, hw: 5, hd: 0.5 }, // 大通りの北端を塞ぐ
    // 西の路地 — 倉庫と外周ビルのあいだの通り抜けを1本に絞り、突き当りを袋小路に
    { cx: -68, cz: -13, hw: 0.5, hd: 8 },
    { cx: -78, cz: -6, hw: 5, hd: 0.5 },
    // 中間街区の十字路の角
    { cx: -56, cz: -22, hw: 3, hd: 0.5 },
    { cx: 28, cz: -30, hw: 0.5, hd: 3 },
    { cx: -46, cz: -45, hw: 5, hd: 0.5 }, // 中間街区の建物前の張り出し塀(前進を端へ振る)
    // 火器分隊の展開縦深に低い塀
    { cx: -20, cz: -46, hw: 4, hd: 0.5 },
  ];
  // 位置だけ2倍に引き伸ばす(遮蔽そのものの大きさは人体スケールのまま)。`[v6.3]`
  for (const w of clutter) {
    walls.push({ cx: w.cx * 2, cz: w.cz * 2, hw: w.hw, hd: w.hd });
    walls.push({ cx: -w.cx * 2, cz: -w.cz * 2, hw: w.hw, hd: w.hd });
  }

  // 拠点にする部屋: **西の倉庫**(cx=-42, cz=-11)の最奥の部屋。外扉から最も遠い部屋を
  // 選ぶので、確保するには廊下 → 前室 → 奥室と順に潰していく必要がある。`[v6.2]`
  //
  // どの建物を選ぶかが重要。中隊の担当区域は「把握している脅威 ± 正面幅」で決まるので、
  // 実際に部隊が流れるのは中央寄りの帯になる。そこから外れた建物(盤端の x=±96)へ置くと
  // **誰も入らず永久に中立のまま**になる — 実際に置いて確認した。交戦帯の中に置く。
  const flank = buildings.find(
    (b) =>
      Math.abs((b.bounds.minX + b.bounds.maxX) / 2 + 72) < 0.5 &&
      Math.abs((b.bounds.minZ + b.bounds.maxZ) / 2 + 15) < 0.5,
  );
  if (!flank) throw new Error("symmetricCity: 西の倉庫が見つからない");
  return { walls, buildings, objectiveRoom: deepestRoomCenter(flank) };
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
    objectives: [
      {
        id: 1,
        label: "OBJ FALCON",
        pos: { ...objective },
        radius: OBJECTIVE.RADIUS.small,
        size: "small",
      },
    ],
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
  /** 火器分隊(機関銃班)の squadId(`[v6.1]` 仕様 §2) */
  weaponsSquadId: number,
  center: Vec2,
  dir: Vec2,
  objective: Vec2,
  companyId = 0,
  /**
   * 自軍の中での小隊の通し番号(`[v6.2]` OQ-6)。麾下の分隊へ個体差の種として配る。
   * 両陣営で同じ値を渡すこと — 鏡像の兵士が同じ性格になるための前提(traits.ts)。
   */
  variant = 0,
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
        variant * 4 + i,
      ),
    );
  });
  // 火器分隊はライフル分隊列の少し後方(縦深から支援射撃する位置)
  soldiers.push(
    ...makeWeaponsSquad(
      side,
      platoonId,
      weaponsSquadId,
      { x: center.x - dir.x * 7, z: center.z - dir.z * 7 },
      dir,
      companyId,
      variant * 4 + 3,
    ),
  );
  // 小隊本部は分隊列の後方に置く(仕様 §2/§3②: 小隊長は担当区域全体を見渡す位置)
  soldiers.push(
    ...makePlatoonHq(
      side,
      companyId,
      platoonId,
      { x: center.x - dir.x * 13, z: center.z - dir.z * 13 },
      dir,
    ),
  );
  return {
    soldiers,
    plans: plansFor(
      side,
      platoonId,
      [...squadIds, weaponsSquadId],
      objective,
      dir,
      center,
      companyId,
    ),
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
 * `[v6.1]` 火器分隊(7名)を追加し、3個ライフル分隊(27)+火器分隊(7)+小隊本部(2)= 36名。
 */
export function platoonClashScenario(seed = 1): Scenario {
  resetIds();
  // `[v6.1]` 火器分隊+小隊本部が後方に伸びるぶん、縦深を広げて全員を盤内に収める。
  // `[v6.3]` 射程を仕様 §10 の本来の値へ戻したので盤面を2倍にした。従来の 112×100 では
  // 展開地から敵展開地までライフルの射程内に収まり、両軍が一歩も動かず撃ち合っていた。
  const bounds: Bounds = { minX: -112, maxX: 112, minZ: -100, maxZ: 100 };
  const objective = { x: 0, z: 0 };

  const blue = buildPlatoon("blue", 0, [0, 1, 2], 3, { x: 0, z: -32 }, { x: 0, z: 1 }, objective);
  const red = buildPlatoon("red", 1, [10, 11, 12], 13, { x: 0, z: 32 }, { x: 0, z: -1 }, objective);

  return {
    name: "platoon-clash",
    seed,
    bounds,
    walls: symmetricWalls(),
    soldiers: [...blue.soldiers, ...red.soldiers],
    fireteamPlans: [...blue.plans.fireteamPlans, ...red.plans.fireteamPlans],
    squadPlans: [...blue.plans.squadPlans, ...red.plans.squadPlans],
    platoonPlans: [...blue.plans.platoonPlans, ...red.plans.platoonPlans],
    // 拠点は3つ。過半数(2つ)を維持し続けた側が勝つ(仕様 §12)。
    // 点対称に置いて、どちらの陣営も同じ距離関係で臨めるようにする
    objectives: [
      { id: 1, label: "OBJ ALPHA", pos: { x: -26, z: 0 }, radius: OBJECTIVE.RADIUS.small, size: "small" },
      { id: 2, label: "OBJ BRAVO", pos: { x: 0, z: 0 }, radius: OBJECTIVE.RADIUS.large, size: "large" },
      { id: 3, label: "OBJ CHARLIE", pos: { x: 26, z: 0 }, radius: OBJECTIVE.RADIUS.small, size: "small" },
    ],
    controlMeasures: [{ kind: "OBJ", label: "OBJ FALCON", points: [{ ...objective }] }],
  };
}

/**
 * 1個中隊 vs 1個中隊(各3個小隊 × (3個ライフル分隊+火器分隊+小隊本部) + 中隊本部
 * = 112名、両軍224名)。
 *
 * 仕様 §2 が想定する規模(中隊 = 3〜4個小隊、約130名/中隊)にかなり近づいた。
 *
 * `[v6]` 中隊長のC2・小隊本部・中隊本部・CP・CCPを追加し、5階層が揃った。
 * `[v6.1]` 火器分隊(小隊ごと7名)を追加。
 * `[v6.2]` 盤面を `symmetricWalls()` の意味のない壁片から、点対称の市街地
 * (`symmetricCity()`: 四角い建物の街区・十字路・中央広場・迂回を強いる庁舎ペア)へ差し替え。
 */
export function companyClashScenario(seed = 1): Scenario {
  resetIds();
  // CP(z=±70)とCCP(z=±78)を盤内に収める必要がある。ナビグリッドは bounds から
  // 作られるので、CCPが外に出ると担架班が永久にたどり着けない(実際に描画で発見した)。
  // `[v6.3]` 射程を仕様 §10 の本来の値へ戻したので盤面を2倍にした(従来 220×170)。
  const bounds: Bounds = { minX: -220, maxX: 220, minZ: -170, maxZ: 170 };
  const objective = { x: 0, z: 0 };
  const city = symmetricCity();
  const objRoom = city.objectiveRoom;
  const objRoomMirror = { x: -objRoom.x, z: -objRoom.z };

  /** 小隊の初期展開間隔(m)。分隊3個分の正面幅より広く取る */
  const PLATOON_SPACING = 220;

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
      p * 10 + 3,
      { x: lateral, z: -140 },
      { x: 0, z: 1 },
      objective,
      0,
    );
    // 点対称になるよう座標も向きも反転させる
    const red = buildPlatoon(
      "red",
      100 + p,
      [1000 + p * 10, 1000 + p * 10 + 1, 1000 + p * 10 + 2],
      1000 + p * 10 + 3,
      { x: -lateral, z: 140 },
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
    walls: city.walls,
    buildings: city.buildings,
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
    // `[v6.2]` 3拠点。点対称に置く: 西の倉庫の最奥の一室(OBJ ALPHA)↔ その点対称の
    // 東の倉庫の一室(OBJ CHARLIE)、中央広場(OBJ BRAVO)。判定半径は部屋1つぶん
    // (`OBJECTIVE.ROOM_RADIUS`)まで絞ってある。過半数(2つ)維持で勝利(仕様 §12)。
    objectives: [
      { id: 1, label: "OBJ ALPHA", pos: { ...objRoom }, radius: OBJECTIVE.ROOM_RADIUS, size: "small" },
      { id: 2, label: "OBJ BRAVO", pos: { ...objective }, radius: OBJECTIVE.ROOM_RADIUS, size: "small" },
      { id: 3, label: "OBJ CHARLIE", pos: { ...objRoomMirror }, radius: OBJECTIVE.ROOM_RADIUS, size: "small" },
    ],
    controlMeasures: [
      { kind: "OBJ", label: "OBJ ALPHA", points: [{ ...objRoom }] },
      { kind: "OBJ", label: "OBJ BRAVO", points: [{ ...objective }] },
      { kind: "OBJ", label: "OBJ CHARLIE", points: [{ ...objRoomMirror }] },
    ],
  };
}

/**
 * CQB機構の単体テスト用フィクスチャ(仕様 §7)。`[v6.1]`
 *
 * `urbanAssaultScenario` を非対称の大型市街地へ差し替えたので、スタック→ブリーチ→掃討→
 * 再編成の一連を確実に踏ませる小さな点対称マップをテスト専用に残す(旧 `urban` の内容)。
 * `SCENARIOS` には載せない。
 */
export function urbanCqbFixture(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -40, maxX: 40, minZ: -34, maxZ: 34 };
  const north = makeSimpleBuilding(1, { minX: -7, maxX: 3, minZ: 4, maxZ: 12 }, "south");
  const south = makeSimpleBuilding(2, { minX: -3, maxX: 7, minZ: -12, maxZ: -4 }, "north");
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
  const blueObjective = { x: -2, z: 8 };
  const redObjective = { x: 2, z: -8 };
  const soldiers = [
    ...makeSquad("blue", 0, 0, blueStart, { x: 0, z: 1 }),
    ...makeSquad("red", 1, 1, redStart, { x: 0, z: -1 }),
  ];
  const blue = plansFor("blue", 0, [0], blueObjective, { x: 0, z: 1 }, blueStart);
  const red = plansFor("red", 1, [1], redObjective, { x: 0, z: -1 }, redStart);
  return {
    name: "urban-cqb-fixture",
    seed,
    bounds,
    walls: [...north.walls, ...south.walls, ...streetWalls],
    buildings: [north.building, south.building],
    soldiers,
    fireteamPlans: [...blue.fireteamPlans, ...red.fireteamPlans],
    squadPlans: [...blue.squadPlans, ...red.squadPlans],
    platoonPlans: [...blue.platoonPlans, ...red.platoonPlans],
    ccp: { blue: { x: 0, z: -30 }, red: { x: 0, z: 30 } },
    objectives: [
      { id: 1, label: "OBJ NORTH", pos: { ...blueObjective }, radius: OBJECTIVE.RADIUS.small, size: "small" },
      { id: 2, label: "OBJ SOUTH", pos: { ...redObjective }, radius: OBJECTIVE.RADIUS.small, size: "small" },
    ],
    controlMeasures: [
      { kind: "OBJ", label: "OBJ NORTH", points: [{ ...blueObjective }] },
      { kind: "OBJ", label: "OBJ SOUTH", points: [{ ...redObjective }] },
    ],
  };
}

/**
 * 市街地戦シナリオ。1個小隊 vs 1個小隊で、街区に散らばる3拠点を争奪する(仕様 §7 + §12)。
 *
 * `[v6.1]` それまでの小さな点対称CQBマップ(2棟)を置き換え、**大きめの非対称市街地**にした
 * (初回テストプレイ指摘: 意味のある街区・建物・射線が欲しい)。点対称ではないので
 * `test/symmetry.test.ts` のラベル入替テストからは外す — 本番ミッションマップの扱い。
 *
 * 屋外と屋内はシームレスな1つのマップ(仕様 §7.1)。長い大通りは選抜射手(§10)の射線が
 * 通り、建物内・路地では武器種によらずLOSが頭打ちになる。中央の大きな庁舎(OBJ CENTRE)は
 * 扉が南向きで、青は正面突撃・赤は北側から迂回か突入、という非対称な攻略になる。
 */
export function urbanAssaultScenario(seed = 1): Scenario {
  resetIds();
  const bounds: Bounds = { minX: -84, maxX: 84, minZ: -72, maxZ: 72 };

  // ── 建物。`[v6.2]` 中身は中廊下+区画(奥行があれば前後2室)。非対称に配置する ──
  const b: ReturnType<typeof makeCorridorBuilding>[] = [
    // 中央の庁舎。扉は南向き(青の正面、赤は迂回)
    makeCorridorBuilding(1, { minX: -9, maxX: 9, minZ: -7, maxZ: 9 }, "south"),
    // 西の街区: 倉庫(大)+ 小屋。OBJ WEST を含む
    makeCorridorBuilding(2, { minX: -58, maxX: -40, minZ: -16, maxZ: -2 }, "east"),
    makeCorridorBuilding(3, { minX: -46, maxX: -36, minZ: 10, maxZ: 20 }, "south"),
    // 東の街区: 中規模ビル。OBJ EAST を含む。扉は西向き
    makeCorridorBuilding(4, { minX: 34, maxX: 50, minZ: 4, maxZ: 20 }, "west"),
    makeCorridorBuilding(5, { minX: 40, maxX: 52, minZ: -22, maxZ: -10 }, "north"),
    // 赤側の縦深に1棟、青側の縦深に1棟(それぞれの立て直し用の遮蔽)
    makeCorridorBuilding(6, { minX: -8, maxX: 6, minZ: 34, maxZ: 46 }, "south"),
    makeCorridorBuilding(7, { minX: 10, maxX: 24, minZ: -44, maxZ: -32 }, "north"),
  ];
  // `[v6.2]` 拠点は建物の最奥の一室。中央広場だけは屋外のまま(点の争奪)。
  const objCentre = deepestRoomCenter(b[0]!.building);
  const objWest = deepestRoomCenter(b[1]!.building);
  const objEast = deepestRoomCenter(b[3]!.building);

  // ── 街路の遮蔽(壁・塀・車列に見立てた低い遮蔽)。非対称 ──
  const streetWalls: AABB[] = [
    // 中央広場の南、青の突撃路を絞る横壁
    { cx: -14, cz: -18, hw: 8, hd: 0.5 },
    { cx: 16, cz: -16, hw: 6, hd: 0.5 },
    // 東の大通り沿い(選抜射手の射線が通る長い直線)
    { cx: 30, cz: -2, hw: 0.5, hd: 22 },
    // 西の路地
    { cx: -30, cz: 2, hw: 0.5, hd: 12 },
    { cx: -22, cz: -6, hw: 6, hd: 0.5 },
    // 中央北、赤の展開を分ける縦壁
    { cx: 2, cz: 22, hw: 0.5, hd: 8 },
    { cx: -6, cz: 16, hw: 5, hd: 0.5 },
    // 散在する車列(短い遮蔽)
    { cx: 24, cz: 12, hw: 2.4, hd: 0.5 },
    { cx: -14, cz: 26, hw: 2.4, hd: 0.5 },
    { cx: 8, cz: -8, hw: 0.5, hd: 3 },
    { cx: -40, cz: -24, hw: 3, hd: 0.5 },
  ];

  // ── 部隊: 青は南端、赤は北端から。非対称なので座標は鏡像にしない ──
  const blue = buildPlatoon(
    "blue",
    0,
    [0, 1, 2],
    3,
    { x: -6, z: -54 },
    { x: 0, z: 1 },
    { x: 0, z: 0 },
    0,
  );
  const red = buildPlatoon(
    "red",
    1,
    [10, 11, 12],
    13,
    { x: 8, z: 54 },
    { x: 0, z: -1 },
    { x: 0, z: 0 },
    1,
  );

  return {
    name: "urban-city",
    seed,
    bounds,
    walls: [...b.flatMap((x) => x.walls), ...streetWalls],
    buildings: b.map((x) => x.building),
    soldiers: [...blue.soldiers, ...red.soldiers],
    fireteamPlans: [...blue.plans.fireteamPlans, ...red.plans.fireteamPlans],
    squadPlans: [...blue.plans.squadPlans, ...red.plans.squadPlans],
    platoonPlans: [...blue.plans.platoonPlans, ...red.plans.platoonPlans],
    companyPlans: [
      { side: "blue", companyId: 0, objective: { x: 0, z: 0 }, advanceDir: { x: 0, z: 1 }, rallyPoint: { x: -6, z: -60 } },
      { side: "red", companyId: 1, objective: { x: 0, z: 0 }, advanceDir: { x: 0, z: -1 }, rallyPoint: { x: 8, z: 60 } },
    ],
    ccp: { blue: { x: -6, z: -66 }, red: { x: 8, z: 66 } },
    // 3拠点: 中央庁舎 / 西の倉庫 / 東のビル。いずれも**建物の最奥の一室**で、
    // 判定半径は部屋1つぶん(`[v6.2]`)。過半数(2つ)保持で勝利(仕様 §12)
    objectives: [
      { id: 1, label: "OBJ CENTRE", pos: { ...objCentre }, radius: OBJECTIVE.ROOM_RADIUS, size: "small" },
      { id: 2, label: "OBJ WEST", pos: { ...objWest }, radius: OBJECTIVE.ROOM_RADIUS, size: "small" },
      { id: 3, label: "OBJ EAST", pos: { ...objEast }, radius: OBJECTIVE.ROOM_RADIUS, size: "small" },
    ],
    controlMeasures: [
      { kind: "OBJ", label: "OBJ CENTRE", points: [{ ...objCentre }] },
      { kind: "OBJ", label: "OBJ WEST", points: [{ ...objWest }] },
      { kind: "OBJ", label: "OBJ EAST", points: [{ ...objEast }] },
    ],
  };
}
