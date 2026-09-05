/**
 * 戦闘前の作戦立案(仕様 §3① / §11、`[v6.5]`)。
 *
 * 米陸軍の**指揮活動手順**(TLP / troop leading procedures、ATP 3-21.10)のうち、
 * 中隊長が実際に紙に書く部分 — 任務分析 → 行動方針の決定 → 命令の下達 — を
 * 1回の関数呼び出しに畳んだもの。出てくるのは作戦命令(OPORD)の第3項に相当する
 * 「機動の要領(scheme of maneuver)」で、次の3つを決める:
 *
 *   1. **主攻(main effort)の指定** — 勝敗を決める拠点はどれか。ADP 3-90 が言う
 *      「主攻へ戦闘力を集中し、他は主攻を支援する」の起点。
 *   2. **各小隊への任務(WHAT)割り当て** — seize / support_by_fire / screen。
 *      仕様 §3① が中隊長の仕事としている「小隊への任務割り当て」そのもの。
 *   3. **接近経路(axis of advance)** — 出発地点から目標までどの街路を通るか。
 *      ナビグリッド上の実経路を折れ線へ単純化して持つ。
 *
 * ── この関数が**見てはいけないもの** ──
 * 敵の位置。立案は戦闘開始前なので belief は空であり、`world.soldiers` から敵を
 * 覗く実装にすると仕様 §5 の情報階層が最初の1手で崩れる。地形(建物・壁・ナビ
 * グリッド)、拠点、自軍の配置だけで組む。結果として「どこに敵がいるか」ではなく
 * 「どこを取るべきか」に基づく計画になる — これは制約ではなく、実際の攻撃計画が
 * まさにそうやって作られるという事実に沿っている。
 *
 * ── 対称性(仕様 §2/§13)──
 * 割り当ての順序はすべて**その陣営自身の前進フレーム**(前方 = advanceDir、
 * 右 = その直交)で決める。世界座標の並び順(拠点配列の順など)で決めると、
 * 点対称の盤面で両陣営が同じ拠点を先に処理してしまい、鏡像にならない。
 * `test/planning.test.ts` がラベル入替で厳密な鏡像になることを検査している。
 */

import { COVER_SEEK, PLANNING } from "../constants.ts";
import { assembleForBattle } from "./assembly.ts";
import { findPathSet } from "../navgrid.ts";
import { bestOverwatchPoint } from "../cover.ts";
import { insideBounds } from "../cqb.ts";
import type {
  CompanyState,
  Mission,
  Objective,
  OperationPlan,
  PlanTask,
  PlatoonState,
  Side,
  Vec2,
} from "../types.ts";
import type { World } from "../world.ts";

/**
 * 支援射撃の射点を探す半径 m。射点の見当(拠点の手前 standoff)のまわりだけを見る。
 * 出発地点から180mを舐めると候補点が数万件になり、立案が体感できるほど遅くなる。
 */
const SUPPORT_SEARCH_RADIUS = 60;

/** その陣営の前進フレーム。順序づけをすべてこの座標系で行うと鏡像が保たれる。 */
interface Frame {
  fwd: Vec2;
  right: Vec2;
}

function frameOf(dir: Vec2): Frame {
  const d = Math.hypot(dir.x, dir.z) || 1;
  const fwd = { x: dir.x / d, z: dir.z / d };
  return { fwd, right: { x: -fwd.z, z: fwd.x } };
}

/** 自陣営フレームでの横位置(右が正)。 */
function lateral(f: Frame, p: Vec2): number {
  return p.x * f.right.x + p.z * f.right.z;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 健在な兵士の重心。1人もいなければ null。 */
function centroidOf(world: World, side: Side, platoonId: number): Vec2 | null {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const s of world.soldiers) {
    if (s.side !== side || s.platoonId !== platoonId || s.status !== "ok") continue;
    x += s.pos.x;
    z += s.pos.z;
    n++;
  }
  return n === 0 ? null : { x: x / n, z: z / n };
}

/**
 * 方位を日本語の八方位で。命令文の「どちらから接近するか」に使う。
 * 画面は +Z が下(南)・+X が右(東)。
 */
const COMPASS = ["南", "南西", "西", "北西", "北", "北東", "東", "南東"] as const;
function compassOf(from: Vec2, to: Vec2): string {
  const a = Math.atan2(to.x - from.x, to.z - from.z); // 0 = +Z = 南
  const i = Math.round((a / (Math.PI / 4) + 8) % 8);
  return COMPASS[i % 8]!;
}

/**
 * 経路を折れ線へ単純化する。ほぼ直進の連なりを1本の脚にまとめ、点数の上限で間引く。
 * A* が返すのはナビグリッドの1mごとの点列なので、そのままでは矢印として読めない。
 */
function simplifyRoute(path: readonly Vec2[]): Vec2[] {
  if (path.length <= 2) return path.map((p) => ({ ...p }));
  const merge = (PLANNING.ROUTE_MERGE_DEG * Math.PI) / 180;
  const out: Vec2[] = [{ ...path[0]! }];
  let dirA = Math.atan2(path[1]!.x - path[0]!.x, path[1]!.z - path[0]!.z);
  for (let i = 1; i < path.length - 1; i++) {
    const d = Math.atan2(path[i + 1]!.x - path[i]!.x, path[i + 1]!.z - path[i]!.z);
    let diff = Math.abs(d - dirA);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff >= merge) {
      out.push({ ...path[i]! });
      dirA = d;
    }
  }
  out.push({ ...path[path.length - 1]! });
  // 上限を超えたら、端は残して中間を等間隔で間引く
  if (out.length <= PLANNING.ROUTE_MAX_POINTS) return out;
  const keep: Vec2[] = [out[0]!];
  const inner = PLANNING.ROUTE_MAX_POINTS - 2;
  for (let k = 1; k <= inner; k++) {
    keep.push(out[Math.round((k * (out.length - 1)) / (inner + 1))]!);
  }
  keep.push(out[out.length - 1]!);
  return keep;
}

/** 出発地点から目標までの接近経路。到達不能なら直線2点で返す。 */
function routeTo(world: World, from: Vec2, to: Vec2): Vec2[] {
  const path = findPathSet(world.nav, from.x, from.z, to.x, to.z);
  if (!path || path.length === 0) return [{ ...from }, { ...to }];
  return simplifyRoute([from, ...path]);
}

/** その拠点が建物の中にあるか。命令文で「屋内掃討を伴う」と添えるために見る。 */
function indoorObjective(world: World, o: Objective): boolean {
  return world.buildings.some((b) => insideBounds(b.bounds, o.pos));
}

/**
 * 中隊長が1回だけ行う立案。戻り値は作戦命令であって、世界を変更はしない。
 * 反映は `applyPlan` の仕事(立案と下達を分けておくと、将来プレイヤーが計画を
 * 差し替えてから下達する、という §4 の筋が素直に通る)。
 */
export function planOperation(world: World, co: CompanyState): OperationPlan {
  const frame = frameOf(co.advanceDir);
  const platoons = world.platoons
    .filter((p) => p.side === co.side && p.companyId === co.companyId)
    .map((pl) => ({ pl, centroid: centroidOf(world, co.side, pl.platoonId) }))
    .filter((e): e is { pl: PlatoonState; centroid: Vec2 } => e.centroid !== null)
    // 自陣営フレームの左から右へ並べる。世界座標の x で並べると鏡像で順序が反転する
    .sort((a, b) => lateral(frame, a.centroid) - lateral(frame, b.centroid));

  const objectives = world.objectives;

  // 拠点が無い戦闘(戦力の枯渇のみで決着)。全小隊を任務目標へ向けて横に展開させる。
  if (objectives.length === 0 || platoons.length === 0) {
    return {
      side: co.side,
      companyId: co.companyId,
      mainObjectiveId: null,
      tasks: platoons.map(({ pl, centroid }) => ({
        platoonId: pl.platoonId,
        role: "supporting" as const,
        mission: { kind: "seize" as const, target: { ...co.objective } },
        objectiveId: null,
        route: routeTo(world, centroid, co.objective),
        order: `${platoonName(pl.platoonId)} — 目標方向へ前進し、接敵したら撃破せよ`,
      })),
      intent: "拠点は設定されていない。敵戦力の撃破をもって決着とする。",
    };
  }

  // ── 1. 争奪の中心 = 全拠点の重心。ここに最も近い拠点が勝敗を分ける ──
  // 敵の位置は見ない。「どこで争いになるか」は拠点の配置だけから決まる。
  const centre = { x: 0, z: 0 };
  for (const o of objectives) {
    centre.x += o.pos.x / objectives.length;
    centre.z += o.pos.z / objectives.length;
  }

  // 争奪の中心に近い順。同距離なら自陣営フレームの左から(点対称の盤面では
  // ALPHA と CHARLIE が中心から等距離になるので、ここが鏡像性の要になる)
  const ranked = [...objectives].sort((a, b) => {
    const d = dist(a.pos, centre) - dist(b.pos, centre);
    if (Math.abs(d) > 1e-6) return d;
    return lateral(frame, a.pos) - lateral(frame, b.pos);
  });
  const main = ranked[0]!;

  // ── 2. 拠点 ← 小隊の割り当て(貪欲。主攻の拠点から順に最寄りを取る) ──
  const taken = new Set<number>();
  const assign = new Map<number, Objective>(); // platoonId → 拠点
  for (const o of ranked) {
    let best: (typeof platoons)[number] | null = null;
    let bestD = Infinity;
    for (const e of platoons) {
      if (taken.has(e.pl.platoonId)) continue;
      const d = dist(e.centroid, o.pos);
      if (d < bestD - 1e-6) {
        bestD = d;
        best = e;
      }
    }
    if (!best) break; // 小隊より拠点が多い。残りは戦況を見て拾う(companyAI の既存経路)
    taken.add(best.pl.platoonId);
    assign.set(best.pl.platoonId, o);
  }

  // ── 3. 任務へ翻訳 ──
  const tasks: PlanTask[] = [];
  for (const { pl, centroid } of platoons) {
    const o = assign.get(pl.platoonId) ?? null;
    const name = platoonName(pl.platoonId);

    if (o) {
      const isMain = o.id === main.id;
      const target = { ...o.pos };
      const route = routeTo(world, centroid, target);
      const via = compassOf(centroid, target);
      const indoor = indoorObjective(world, o) ? "、屋内掃討を伴う" : "";
      // 攻防戦の防御側は「取りに行く」のではなく「持ちこたえる」(仕様 §12)`[v6.8]`
      const defending = isDefender(world, co.side);
      tasks.push({
        platoonId: pl.platoonId,
        role: isMain ? "main" : "supporting",
        mission: { kind: "seize", target },
        objectiveId: o.id,
        route,
        order: defending
          ? `${name} — ${isMain ? "主陣地" : "支撑点"}。${o.label} を占領・保持し、` +
            `${via}からの接近を阻止せよ(${Math.round(dist(centroid, target))}m${indoor})`
          : `${name} — ${isMain ? "主攻" : "助攻"}。${o.label} を確保せよ` +
            `(${via}へ ${Math.round(dist(centroid, target))}m${indoor})`,
      });
      continue;
    }

    // 拠点が行き渡らなかった小隊 = 余力。主攻の拠点へ**支援射撃**に就ける。
    // 射線の通る遮蔽が見つからなければ予備として後方(集結地点)に留める。
    //
    // 射点は「自分の側から見て拠点の手前、standoff だけ離れた地点」のまわりで探す。
    // 出発地点のまわりを半径180mで舐めると候補点が数万件になり、立案が重くなる。
    const dx = main.pos.x - centroid.x;
    const dz = main.pos.z - centroid.z;
    const dLen = Math.hypot(dx, dz) || 1;
    const standoff = (PLANNING.SUPPORT_MIN_RANGE + PLANNING.SUPPORT_MAX_RANGE) / 2;
    const anchor = {
      x: main.pos.x - (dx / dLen) * standoff,
      z: main.pos.z - (dz / dLen) * standoff,
    };
    const sbf = bestOverwatchPoint(
      world.wallIndex,
      world.coverIndex,
      anchor,
      main.pos,
      PLANNING.SUPPORT_MIN_RANGE,
      PLANNING.SUPPORT_MAX_RANGE,
      SUPPORT_SEARCH_RADIUS,
      COVER_SEEK.TARGET_COVER,
    );
    if (sbf) {
      const mission: Mission = { kind: "support_by_fire", target: { ...main.pos } };
      tasks.push({
        platoonId: pl.platoonId,
        role: "supporting",
        mission,
        objectiveId: main.id,
        route: routeTo(world, centroid, sbf),
        order:
          `${name} — 助攻。${main.label} へ射線の通る位置に就き、主攻を支援せよ` +
          `(射距離 ${Math.round(dist(sbf, main.pos))}m)`,
      });
    } else {
      tasks.push({
        platoonId: pl.platoonId,
        role: "reserve",
        mission: { kind: "screen", target: { ...co.rallyPoint } },
        objectiveId: null,
        route: routeTo(world, centroid, co.rallyPoint),
        order: `${name} — 予備。集結地点で待機し、命令により投入する`,
      });
    }
  }

  const mainTask = tasks.find((t) => t.role === "main");
  const need = Math.floor(objectives.length / 2) + 1;
  const leftovers = objectives.length - assign.size;
  const intent = isDefender(world, co.side)
    ? `${objectives.length}個の拠点のうち${need}個を制限時間まで保持すれば勝利する。` +
      (mainTask ? `主陣地は${platoonName(mainTask.platoonId)}(${main.label})。` : "") +
      `各小隊は担当拠点を占領し、その場で持久する。`
    : `${objectives.length}個の拠点のうち${need}個を確保して勝利する。` +
      (mainTask ? `主攻は${platoonName(mainTask.platoonId)}(${main.label})。` : "") +
      `他は各正面の拠点を確保しつつ主攻の側面を掩護する。` +
      (leftovers > 0 ? `残る${leftovers}個の拠点は戦況を見て拾う。` : "");

  return { side: co.side, companyId: co.companyId, mainObjectiveId: main.id, tasks, intent };
}

/**
 * 攻防戦(仕様 §12)の防御側か。`[v6.8]`
 *
 * 防御側は開始時点で全拠点を保有しているので、「保有したら任務完了」という
 * 攻撃側の規則をそのまま当てると**開始と同時に全部隊が任務を失う**。
 * 防御の任務は保有し続けることなので、完了しない。
 */
export function isDefender(world: World, side: Side): boolean {
  return world.mode === "assault" && world.attacker !== side;
}

/** 小隊の呼称。小隊idは陣営ごとに採番が違うので、下2桁を通し番号として使う。 */
export function platoonName(platoonId: number): string {
  return `${(platoonId % 100) + 1}小隊`;
}

/**
 * 立てた作戦を麾下へ下達する(OPORDの下達に相当)。
 * 各小隊の任務・任務目標・前進軸をここで書き換える。以後 `companyAI` は
 * 拠点を取り終えるまでこの割り当てを維持する。
 */
export function applyPlan(world: World, co: CompanyState): void {
  const plan = co.plan;
  if (!plan) return;

  const mainObj = world.objectives.find((o) => o.id === plan.mainObjectiveId);
  if (mainObj) co.objective = { ...mainObj.pos };

  for (const t of plan.tasks) {
    const pl = world.platoons.find(
      (p) => p.side === co.side && p.companyId === co.companyId && p.platoonId === t.platoonId,
    );
    if (!pl) continue;
    co.platoonObjectives.set(pl.platoonId, { ...t.mission.target });
    co.platoonMissions.set(pl.platoonId, { ...t.mission, target: { ...t.mission.target } });
    pl.objective = { ...t.mission.target };
    pl.mission = { ...t.mission, target: { ...t.mission.target } };
    // 前進軸は接近経路の第1脚。街路に沿って出るので、初手から建物へ突っ込まない
    if (t.route.length >= 2) {
      const a = t.route[0]!;
      const b = t.route[1]!;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > 1e-6) pl.advanceDir = { x: (b.x - a.x) / d, z: (b.z - a.z) / d };
    }
  }
}

/**
 * 立案フェーズへ入る。時間を止め、両中隊ぶんの作戦を立てて下達する。
 *
 * `createWorld` はこれを呼ばない — ヘッドレステストやバランスハーネスは
 * 立案を挟まず即座に戦闘を始めるべきで、既定は `battle` のままにしてある。
 */
export function beginPlanning(world: World): void {
  world.phase = "planning";
  // `[v6.13]` **まず集結地を取り、そこから計画を立てる**(仕様 §3① / §11)。
  //
  // 開けた土地に整列したまま戦闘を始めるのは指揮の結果ではなく、シナリオが展開線を
  // 直値(z=±140)で持っていて、そこが盤面の市街地より手前の何も無い場所だったから。
  //
  // 順序が重要。立案のあとに動かすと、接近経路も「目標まで何m」も**動く前の位置**から
  // 計算されてしまい、命令書と部隊の居場所が食い違う。実際に一度そう書いて、
  // 34m前進したのに命令が「南へ143m」のままになった。
  assembleForBattle(world);
  for (const co of world.companies) {
    co.plan = planOperation(world, co);
    applyPlan(world, co);
  }
}

/** 立案フェーズを抜けて戦闘を始める。作戦は破棄せず、以後の任務割り当ての土台になる。 */
export function beginBattle(world: World): void {
  world.phase = "battle";
}

/**
 * `companyAI` が読む「この小隊に計画で与えられている任務」。
 * 対象の拠点を確保し終えた任務は**完了**として null を返し、以後は戦況に基づく
 * 通常の割り当て(担当区域・攻勢分遣)へ戻す。これが FRAGO に当たる。
 */
export function activeTaskOf(world: World, co: CompanyState, platoonId: number): PlanTask | null {
  const t = co.plan?.tasks.find((x) => x.platoonId === platoonId);
  if (!t) return null;
  if (t.objectiveId === null) return t;
  const o = world.objectives.find((x) => x.id === t.objectiveId);
  if (!o) return null;
  // 自軍が確保しきったら任務完了。保持は objectiveHold(最寄り1個小隊)の担当へ移る
  // 防御側は保有していること自体が任務なので完了しない(仕様 §12 攻防戦)`[v6.8]`
  if (o.owner === co.side && !isDefender(world, co.side)) return null;
  return t;
}
