/**
 * 小隊長AI(仕様 §3 ②)。
 *
 * **この階層は生の視界を一切持たない。** 判断材料は麾下分隊長からの無線報告だけで、
 * それは遅延しており確度も減衰している(仕様 §5)。したがって小隊長は
 * 「やや古い地図」を見ながら数十名を捌くことになる — これが階層構造の遊びの核心。
 *
 * やること(仕様 §3 ②):
 *   - 3個分隊の配置決定(担当区域の割り当て)
 *   - 移動技術の指示(前進 / 警戒前進 / 躍進前進、仕様 §6)
 *   - 分隊間の相互支援の調整
 *
 * 戦力対称性(仕様 §2/§13): 両陣営で完全に同一のロジックが動く。
 */

import { SIM_HZ } from "../constants.ts";
import { aiSuppressed, soldierSeated } from "../control.ts";
import { commandFactor } from "./succession.ts";
import { flotFrom } from "./flot.ts";
import { nextBuildingNearObjective } from "./clearInZone.ts";

/**
 * 逆襲が来ると見ている方角(`[v6.16]` ATP 3-21.8)。
 *
 * **敵を見ない**(仕様 §5)。使うのはその小隊長の belief と前進方向だけで、
 * `world.soldiers` は読まない。
 *   - 接触を把握していれば、拠点から見たその方角
 *   - 何も無ければ前進方向 — 敵は自分が来たのと反対側から来る
 */
function counterattackWatch(pl: PlatoonState, at: Vec2): Vec2 {
  const threat = primaryThreat(pl.belief);
  if (threat) {
    const dx = threat.pos.x - at.x;
    const dz = threat.pos.z - at.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) return { x: dx / d, z: dz / d };
  }
  const d = Math.hypot(pl.advanceDir.x, pl.advanceDir.z) || 1;
  return { x: pl.advanceDir.x / d, z: pl.advanceDir.z / d };
}


import { assignHolders, assignOccupiers, clampToObjective } from "./objectiveHold.ts";
import { sideDoctrine } from "../world.ts";
import {
  clearedDoorSet,
  clearingObjective,
  nextBuildingToClear,
  unfinishedBuildingOf,
} from "./clearInZone.ts";
import { FLANK } from "../constants.ts";
import {
  chooseFlankSide,
  enemyFlankAnchor,
  flankRadius,
  flankSeparationDeg,
  flankWaypoint,
} from "./flank.ts";
import type {
  Contact,
  Mission,
  MovementTechnique,
  Objective,
  PlatoonState,
  SquadState,
  Vec2,
} from "../types.ts";
import type { World } from "../world.ts";

/** 側面攻撃で分隊に割り当てる役割。機動分隊は `goal`(経由点)が null なら突撃 */
type PlatoonFlankRole = { role: "base" } | { role: "maneuver"; goal: Vec2 | null };

/**
 * 小隊の側面攻撃の段取りを決め、分隊ごとの役割を返す(`[v7.0]`)。
 *
 * 見るのは**小隊長の belief(無線報告)と自軍の位置だけ**(仕様 §5)。報告は1ホップ
 * 遅れているので、小隊長の回り込みは分隊長のそれより粗い — それが階層の差。
 *
 * 段取り(誰がベースで誰が回るか、どちらへ回るか)は交戦の最初に1回だけ決め、
 * 脅威を `FLANK.RELEASE_SEC` 見失うか、どちらかの分隊が使えなくなるまで保つ。
 */
function planPlatoonFlank(
  world: World,
  pl: PlatoonState,
  ctx: {
    threat: Contact | null;
    /** 新しく段取りを組むときに使ってよい分隊(占領・掃討・守備に就いていない) */
    eligible: SquadState[];
    /** 組み終えた段取りを続けてよい分隊(守備・占領に就いた分隊は引き剥がさない) */
    retainable: SquadState[];
    enabled: boolean;
    centroidOf: (sq: SquadState) => Vec2 | null;
  },
): Map<number, PlatoonFlankRole> {
  const roles = new Map<number, PlatoonFlankRole>();
  const { threat, eligible } = ctx;
  if (!ctx.enabled) {
    pl.flank = null;
    return roles;
  }
  if (!threat) {
    if (pl.flank && world.tick - pl.flank.lastThreatTick > FLANK.RELEASE_SEC * SIM_HZ) {
      pl.flank = null;
    }
    return roles;
  }
  const centersOf = (list: SquadState[]): Map<number, Vec2> => {
    const m = new Map<number, Vec2>();
    for (const sq of list) {
      const c = ctx.centroidOf(sq);
      if (c) m.set(sq.squadId, c);
    }
    return m;
  };
  // **組んだ段取りは、建物掃討の割り当てが変わっても解かない。** 割り当ては分隊の
  // 位置で毎周期引き直されるので、それに連動させると段取りが数秒ごとに作り直され、
  // 機動分隊が回り込みの途中で毎回引き返す(計測: 3戦で46回の組み直し)。
  // 守備・占領だけは例外で、そちらに指名されたら段取りを解く。
  let plan = pl.flank;
  const kept = centersOf(ctx.retainable);
  if (plan && (!kept.has(plan.baseKey) || !kept.has(plan.maneuverKey))) plan = null;
  if (
    plan?.doneTick != null &&
    world.tick - plan.doneTick > FLANK.PLATOON_ASSAULT_SEC * SIM_HZ
  ) {
    plan = null;
  }
  let centers = kept;
  if (!plan) {
    centers = centersOf(eligible);
    if (centers.size < 2) {
      pl.flank = null;
      return roles;
    }
    // ベース = 脅威に最も近い分隊(既に射撃位置に就いている可能性が高い)
    const ranked = [...centers.entries()].sort(
      (a, b) => dist(a[1], threat.pos) - dist(b[1], threat.pos) || a[0] - b[0],
    );
    const [baseKey, baseC] = ranked[0]!;
    // 回る側を決めてから、その側の90°の点に最も近い分隊を機動にする
    const others = ranked.slice(1);
    const nearestOther = others[0]!;
    const radius = flankRadius(threat.pos, nearestOther[1], FLANK.PLATOON_RADIUS);
    const dirSide = chooseFlankSide({
      centerOf: (d) => enemyFlankAnchor(threat.pos, baseC, d, pl.belief.values(), FLANK.LINE_REACH),
      threat: threat.pos,
      base: baseC,
      maneuver: nearestOther[1],
      objective: pl.objective,
      contacts: pl.belief.values(),
      radius,
      cover: world.coverIndex,
      wallIndex: world.wallIndex,
      bounds: world.bounds,
    });
    const anchor0 = enemyFlankAnchor(threat.pos, baseC, dirSide, pl.belief.values(), FLANK.LINE_REACH);
    const target = flankWaypoint(anchor0, baseC, baseC, dirSide, radius);
    let man = nearestOther;
    for (const o of others) {
      if (dist(o[1], target) < dist(man[1], target) - 1e-9) man = o;
    }
    plan = {
      baseKey,
      maneuverKey: man[0],
      dir: dirSide,
      sinceTick: world.tick,
      lastThreatTick: world.tick,
      done: false,
      doneTick: null,
    };
    pl.flank = plan;
  }
  plan.lastThreatTick = world.tick;

  const baseC = centers.get(plan.baseKey)!;
  const manC = centers.get(plan.maneuverKey)!;
  // 回り込みの中心は主脅威ではなく、決めた側の敵戦列の端
  const anchor = enemyFlankAnchor(threat.pos, baseC, plan.dir, pl.belief.values(), FLANK.LINE_REACH);
  if (!plan.done) {
    const sep = flankSeparationDeg(anchor, baseC, manC);
    const timedOut = world.tick - plan.sinceTick > FLANK.PLATOON_TIMEOUT_SEC * SIM_HZ;
    if (sep >= FLANK.DONE_DEG || timedOut) {
      plan.done = true;
      plan.doneTick = world.tick;
    }
  }
  roles.set(plan.baseKey, { role: "base" });
  roles.set(plan.maneuverKey, {
    role: "maneuver",
    goal: plan.done
      ? null
      : flankWaypoint(
          anchor,
          baseC,
          manC,
          plan.dir,
          flankRadius(anchor, manC, FLANK.PLATOON_RADIUS),
        ),
  });
  return roles;
}

/** 小隊長の意思決定周期。分隊長(0.3秒)より遅く、階層が上がるほど判断は粗く遅くなる。 */
const DECIDE_EVERY_TICKS = Math.round(2.0 * SIM_HZ);

/** 小隊本部が分隊列の重心から後退している距離 m。前線には出ない(仕様 §3②)。 */
const PLATOON_HQ_TRAIL = 14;

/**
 * 移動技術の選択しきい値(仕様 §6)。
 * 小隊長が把握している「最も確度の高い接敵情報」までの距離で決める。
 * 仕様の脅威評価スコアをそのまま選択ロジックに使う、という §6 の方針に沿った実装。
 */
const TECHNIQUE_THRESHOLDS = {
  /** この距離より近い接敵情報があれば躍進前進(接敵が予想される) */
  boundingWithin: 45,
  /** この距離より近ければ警戒前進(接敵の可能性あり) */
  travelingOverwatchWithin: 90,
} as const;

/**
 * 分隊を横に展開させる間隔(m)。小隊長が3個分隊に担当区域を割り当てる際の幅。
 * 相互支援が届く範囲に収める必要があるため、視界距離(20m)の2倍程度に留める。
 */
const SQUAD_FRONTAGE = 26;
/**
 * clear in zone(`[v6.3]`)で担当区域とみなす、前進軸からの横幅 m。
 * 小隊の正面幅(分隊3個 × 26m)におおむね合わせ、軸から大きく外れた建物までは追わない。
 */
const CLEAR_ZONE_RADIUS = 40;
/**
 * 統合・再編中に掃討して回る、拠点からの半径 m(`[v6.16]`)。
 * 「拠点を見下ろせる建物」の範囲。広げると小隊が拠点から離れて統合の意味が消える。
 */
const CONSOLIDATE_CLEAR_RADIUS = 46;
/** 警戒方向の目印を置く距離 m(`[v6.16]`)。向きを表すためだけの点で、そこへは行かない */
const WATCH_MARK_DIST = 70;
/**
 * 統合・再編中、戦列を拠点の**どれだけ前**に張るか m(`[v6.16]`)。
 * 0 にすると全分隊が判定円に重なって戦列が消える(`[v6.9]` F-9 で計測済みの失敗)。
 * 拠点を見下ろせる距離に置き、拠点そのものは占領分隊が押さえる。
 */
const HASTY_STANDOFF = 24;
/**
 * 拠点を守る分隊の持ち場を、拠点中心からこれだけは広げてよい m。`[v6.2]`
 * 拠点が1室(半径3m)でも、分隊9名は部屋と入口まわりの遮蔽に散って守る。
 *
 * **ただし判定半径を超えてはいけない(`[v6.7]`)。** ここが拠点の半径より大きいと、
 * 守備に付いた分隊の持ち場が拠点の**外**に置かれ、誰も判定円を踏まないまま
 * 「守っているのに確保が進まない」状態で固まる。拠点が建物の一室(半径3m)まで
 * 小さくなった `[v6.2]` 以降、8m のこの値は常に半径より大きかった。
 * 実測: 240秒間、3拠点とも半径内に誰かがいた時間が0%。
 */
const SQUAD_HOLD_SPREAD = 8;
/** 持ち場を拠点の内側に収めるための、半径に対する比。1.0だと縁に立つので少し内側へ */
const SQUAD_HOLD_FRAC = 0.6;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** belief の中で最も確度の高い接触。確度0のゴーストは判断に使わない。 */
function primaryThreat(belief: Map<string, Contact>, includeHeard = false): Contact | null {
  let best: Contact | null = null;
  for (const c of belief.values()) {
    if (c.confidence <= 0) continue; // ゴーストは索敵対象外(仕様 §5 `[v6]`)
    // `[v7.3]` 聞いただけの接触(A-5)は移動技術の選択にだけ使う。機動の向きは見た敵で決める
    if (c.heard && !includeHeard) continue;
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
}

function selectTechnique(pl: PlatoonState, from: Vec2, rangeMul: number): MovementTechnique {
  // 近くで銃声がすれば、見えていなくても警戒前進へ(`[v7.3]` A-5)
  const threat = primaryThreat(pl.belief, true);
  if (!threat) return "traveling";
  const d = dist(from, threat.pos);
  // リスク許容度(`[v6.1]`)でしきい距離を伸縮する。既定(0.5)では rangeMul === 1。
  if (d <= TECHNIQUE_THRESHOLDS.boundingWithin * rangeMul) return "bounding_overwatch";
  if (d <= TECHNIQUE_THRESHOLDS.travelingOverwatchWithin * rangeMul) return "traveling_overwatch";
  return "traveling";
}

/**
 * 小隊本部の位置取り(仕様 §2/§3②)。
 *
 * 小隊長は担当区域全体を見渡せる位置に構えるが、前線には出ない。分隊列の重心から
 * 脅威と反対方向へ下がった位置を持ち場とし、無線手はその隣に付く。
 * 身体を持つことで §12 の指揮官排除が成立する。
 */
function postPlatoonHq(world: World, pl: PlatoonState, anchor: Vec2, forward: Vec2): void {
  const hq = world.soldiers.filter(
    (s) =>
      s.side === pl.side &&
      s.platoonId === pl.platoonId &&
      (s.hqRole === "pl" || s.hqRole === "plRto") &&
      s.status === "ok",
  );
  const right = { x: -forward.z, z: forward.x };
  hq.forEach((s, i) => {
    // 小隊長本人を人間が操作している間はAIの位置取りを止める(仕様 §4)
    // `[v7.3]` 無線手も含め、本部要員に一兵卒として座っている間は止める(A-7)
    if (soldierSeated(world, s)) return;
    const post = {
      x: anchor.x - forward.x * PLATOON_HQ_TRAIL + right.x * (i * 1.8 - 0.9),
      z: anchor.z - forward.z * PLATOON_HQ_TRAIL + right.z * (i * 1.8 - 0.9),
    };
    const arrived = dist(s.pos, post) < 1.5;
    s.order = arrived
      ? { kind: "hold", facing: { ...forward }, issuedTick: world.tick }
      : { kind: "move", target: post, facing: { ...forward }, issuedTick: world.tick };
    if (!arrived) {
      const prev = s.order.target;
      if (!prev || dist(prev, post) > 1.5) {
        s.path = [];
        s.pathIdx = 0;
      }
    }
  });
}

export function platoonAI(world: World): void {
  for (const pl of world.platoons) {
    // 人間がこの小隊長を操作しているなら、AIの意思決定は行わない(仕様 §4)。
    // 配管(belief の更新・報告の送受信)はそのまま動き続ける — 人間は
    // 意思決定者を置き換えるだけで、情報の流れ方は変わらない。
    if (aiSuppressed(world, "platoon", pl.side, pl.platoonId)) continue;
    // 指揮継承直後は判断周期が伸びる(仕様 §12)。分隊より影響が長く続く
    const factor = commandFactor(pl, world.tick, "platoon");
    const doctrine = sideDoctrine(world, pl.side);
    // ドクトリンで判断周期が伸びる(仕様 §13)。正規軍は倍率1で現行と一致 `[v6.8]`
    if (
      world.tick - pl.lastDecisionTick <
      Math.round((DECIDE_EVERY_TICKS * doctrine.decideMul.platoon) / factor)
    ) {
      continue;
    }
    pl.lastDecisionTick = world.tick;
    if (pl.commanderId === null) continue; // 指揮を執れる者がいない

    const squads = world.squads.filter((s) => s.side === pl.side && s.platoonId === pl.platoonId);
    if (squads.length === 0) continue;

    // 小隊の現在位置は「報告された分隊重心の平均」で近似する。
    // 小隊長は麾下の正確な位置すら報告経由でしか知らない点に注意。
    const livingSquads = squads.filter((sq) =>
      world.soldiers.some(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
      ),
    );
    if (livingSquads.length === 0) continue;

    // 各分隊の重心を出し、その平均を小隊の位置とする(分隊ごとの人数差で重み付けしない
    // ことで、損耗した分隊に引きずられない)。
    // 火器分隊(support_by_fire で縦深に留まる)は maneuver 線の位置ではないので除く。
    const lineSquads = livingSquads.filter(
      (sq) =>
        !world.soldiers.some(
          (s) => s.side === sq.side && s.squadId === sq.squadId && s.role === "mg",
        ),
    );
    const anchorSquads = lineSquads.length > 0 ? lineSquads : livingSquads;
    const anchor = { x: 0, z: 0 };
    for (const sq of anchorSquads) {
      const members = world.soldiers.filter(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
      );
      let sx = 0;
      let sz = 0;
      for (const m of members) {
        sx += m.pos.x;
        sz += m.pos.z;
      }
      anchor.x += sx / members.length;
      anchor.z += sz / members.length;
    }
    anchor.x /= anchorSquads.length;
    anchor.z /= anchorSquads.length;

    // ── 前線(FLOT、`[v6.16]` 仕様 §5/§6)──
    // 麾下分隊からの**報告だけ**で引く。無線1ホップぶん古いが、それが小隊長の
    // 持っている前線像そのもの(仕様 §5)。
    pl.flot = flotFrom(pl.squadReports.values(), pl.advanceDir, world.tick);

    const technique = selectTechnique(pl, anchor, world.posture[pl.side].techniqueRangeMul);
    const threat = primaryThreat(pl.belief);

    // 目標軸に対して直交する方向へ分隊を並べ、担当区域を割り当てる。
    // 接敵情報があればそちらへ、なければ小隊の任務目標へ向かう。
    //
    // `[v6.7]` **ここを「接敵しても目標を向き続ける」に変えたら悪化したので戻した。**
    // 「接敵で任務は変わらない(ATP 3-21.8)」という理屈は正しいが、実測では
    // 拠点内滞在 28→0秒、BLUE生存 74→62名。担当区域が敵と無関係に置かれると、
    // 分隊は戦列を作らずに目標へ歩き、隊形が伸びたところを各個に撃たれる。
    // 敵の位置は**戦列をどこに作るか**を決めており、それを外すと火力の集中が消える。
    // 拠点ごとに守備へ付くのは最寄りの1個分隊だけ(`[v6.2]`、c2/objectiveHold.ts)
    const sqCentroidOf = (sq: (typeof livingSquads)[number]): Vec2 | null => {
      const men = world.soldiers.filter(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.status === "ok",
      );
      if (men.length === 0) return null;
      let sx = 0;
      let sz = 0;
      for (const m of men) {
        sx += m.pos.x;
        sz += m.pos.z;
      }
      return { x: sx / men.length, z: sz / men.length };
    };
    const holders = assignHolders(
      world,
      pl.side,
      livingSquads
        .map((sq) => ({ key: sq.squadId, centroid: sqCentroidOf(sq) }))
        .filter((e): e is { key: number; centroid: Vec2 } => e.centroid !== null),
    );

    // ── 統合・再編に入るか(consolidation & reorganization、ATP 3-21.8)`[v6.16]` ──
    //
    // **拠点は奪った瞬間が最も脆い。** ドクトリンは奪取の直後を独立した段階として
    // 扱う: 部隊は前進を止め、逆襲の予想方向へ正対した応急の防御に就き、隣接する
    // 未掃討の建物を潰す。これが無いと部隊は拠点を「通過」してしまう。
    //
    // 入る条件は既存の守備割当をそのまま使う — **自軍所有の拠点に、麾下のどれかの
    // 分隊が守備として付いている**なら、その小隊は統合中。専用の状態機械を増やさない。
    const ownHeld = [...holders.values()].find((o) => o.owner === pl.side) ?? null;
    if (ownHeld) {
      const watch = counterattackWatch(pl, ownHeld.pos);
      pl.consolidation =
        pl.consolidation?.objectiveId === ownHeld.id
          ? { ...pl.consolidation, watch }
          : { objectiveId: ownHeld.id, sinceTick: world.tick, watch };
    } else {
      pl.consolidation = null;
    }

    //
    // `[v6.16]` **統合・再編中(ATP 3-21.8)は別の置き方をする。** 奪った拠点に
    // 留まる小隊は、前進軸の延長ではなく**拠点を中心に、逆襲の予想方向へ正対して**
    // 戦列を張る(hasty defence)。上の `[v6.7]` の教訓はそのまま生きている —
    // 戦列そのものは作る。作る**場所**が前進軸上ではなく拠点まわりになるだけ。
    const consolidating = pl.consolidation;
    const consObjective = consolidating
      ? (world.objectives.find((o) => o.id === consolidating.objectiveId)?.pos ?? null)
      : null;
    const aim =
      consolidating && consObjective
        ? {
            x: consObjective.x + consolidating.watch.x * HASTY_STANDOFF,
            z: consObjective.z + consolidating.watch.z * HASTY_STANDOFF,
          }
        : threat
          ? threat.pos
          : pl.objective;
    // 戦列の起点。統合中は拠点そのもの(いま立っている場所ではなく守る場所が基準)
    const base = consObjective ?? anchor;
    const dx = aim.x - base.x;
    const dz = aim.z - base.z;
    const d = Math.hypot(dx, dz) || 1;
    const forward = { x: dx / d, z: dz / d };
    const right = { x: -forward.z, z: forward.x };

    postPlatoonHq(world, pl, anchor, forward);

    // 小隊の任務(WHAT。`[v6.1]` §3①)を麾下分隊へ翻訳する。
    //   seize          : 3個ライフル分隊が担当区域を確保、火器分隊は support_by_fire で支援
    //   support_by_fire : 全分隊が制圧目標へ射線の通る位置に就く(踏み込まない)
    //   screen         : 全分隊を掩護軸に沿って広く展開(踏み込まない)
    const plMission = pl.mission;
    const isWeaponsSquad = (sq: (typeof livingSquads)[number]): boolean =>
      world.soldiers.some(
        (s) => s.side === sq.side && s.squadId === sq.squadId && s.role === "mg",
      );
    // screen は正面幅を広く取って薄く展開する
    const frontage = plMission.kind === "screen" ? SQUAD_FRONTAGE * 1.8 : SQUAD_FRONTAGE;

    // ── 占領する分隊の指名(`[v6.9]` F-9、仕様 §12)──
    //
    // `assignHolders` は「すでに自分のもの」しか見ないので、**中立の拠点には誰も
    // 指名されない**(守備に付くには進捗が要り、進捗を出すには守備が要る、という
    // デッドロック。実測: 進捗ゼロなら300秒・両陣営で守備割当0秒)。
    // 占領はその逆で「まだ自分のものではないから行く」。
    //
    // 指名するのは拠点ごとに1個分隊だけ。全員を吸い寄せると戦線が消える。
    const occupiers =
      plMission.kind === "seize"
        ? assignOccupiers(
            world,
            livingSquads
              .filter((sq) => !isWeaponsSquad(sq)) // 火器分隊は支援。突入させない
              .map((sq) => ({
                key: sq.squadId,
                centroid: sqCentroidOf(sq),
                target: plMission.target,
              }))
              .filter((e): e is { key: number; centroid: Vec2; target: Vec2 } =>
                e.centroid !== null,
              ),
          )
        : new Map<number, Objective>();

    // clear in zone(ATP 3-06.11 / `[v6.3]`)。担当区域内に未掃討の建物があれば、
    // 前進軸に沿って**最も手前のもの**から各分隊へ割り当てる。掃討を終えるまで
    // その建物が分隊の任務目標になり、終われば次の建物・最終的に本来の目標へ進む。
    // これが無いと分隊は建物を素通りし、未掃討の建物を側背に残したまま前進する。
    const clearAssign = new Map<number, Vec2>();
    if (plMission.kind === "seize" && world.buildings.length > 0) {
      const taken = new Set<number>();
      const cleared = clearedDoorSet(world, pl.side);
      for (const sq of livingSquads) {
        if (isWeaponsSquad(sq)) continue; // 火器分隊は支援射撃。突入させない
        const c = sqCentroidOf(sq);
        if (!c) continue;
        // `[v6.4]` 自分が破孔を開けた建物が未完なら、まずそれを終わらせる
        // (ATP 3-06.11: 未掃討の部屋を側背に残さない)。接敵で前進軸が振れると
        // 掃討途中の建物が担当区域から外れ、二度と戻らないまま放置されていた。
        const own = unfinishedBuildingOf(world, cleared, sq.clearedDoorIds);
        // `[v6.16]` 統合・再編中は前進軸ではなく**拠点のまわり**を掃討する。
        // 「前線を下げないように前線付近の建物をクリアリングする」の実体で、
        // 前進中にこれをやると分隊が振り返って往復するので(実測: 掃討済が
        // 4面すべてで減少)、止まっている小隊にだけ許す。
        const b =
          own && !taken.has(own.id)
            ? own
            : consolidating
              ? nextBuildingNearObjective(
                  world,
                  world.objectives.find((o) => o.id === consolidating.objectiveId)?.pos ?? aim,
                  CONSOLIDATE_CLEAR_RADIUS,
                  taken,
                  cleared,
                )
              : nextBuildingToClear(world, pl.side, c, aim, CLEAR_ZONE_RADIUS, taken, cleared);
        if (!b) continue;
        taken.add(b.id);
        clearAssign.set(sq.squadId, clearingObjective(b));
      }
    }

    // ── 小隊の側面攻撃(`[v7.0]` ATP 3-21.8 Battle Drill 1 の小隊版)──
    // 敵に近い1個分隊をベース・オブ・ファイアとして制圧に就け、別の1個分隊を
    // 丸ごと敵の側面へ回す。以前の小隊長は分隊を横一列に並べるだけで、側面機動は
    // 分隊内のFT単位にしか存在しなかった(計測: 小隊戦で敵から見た角度差 平均9.5°)。
    const flankRoles = planPlatoonFlank(world, pl, {
      threat,
      eligible: livingSquads.filter(
        (sq) =>
          !isWeaponsSquad(sq) &&
          !holders.has(sq.squadId) &&
          !occupiers.has(sq.squadId) &&
          !clearAssign.has(sq.squadId),
      ),
      // 拠点の守備・占領に指名された分隊は引き剥がさない(拠点の確保が勝敗を決める、§12)
      retainable: livingSquads.filter(
        (sq) => !isWeaponsSquad(sq) && !holders.has(sq.squadId) && !occupiers.has(sq.squadId),
      ),
      enabled: plMission.kind === "seize" && !consolidating,
      centroidOf: sqCentroidOf,
    });

    livingSquads.forEach((sq, i) => {
      const lateral = (i - (livingSquads.length - 1) / 2) * frontage;
      let objective: Vec2 = clearAssign.get(sq.squadId) ?? {
        x: aim.x + right.x * lateral,
        z: aim.z + right.z * lateral,
      };

      // この分隊の任務種別。
      // **火器分隊は小隊の任務によらず常に support_by_fire**(`[v6.3]` 修正)。
      // 従来は seize 小隊のときだけ support_by_fire にしており、小隊が screen を
      // 受けると火器分隊まで screen になっていた。機関銃班は掩護でも「据えて撃つ」
      // のであって薄く展開して監視するのではない(仕様 §2)。
      const sqKind: Mission["kind"] = isWeaponsSquad(sq)
        ? "support_by_fire"
        : plMission.kind;

      // ── 警戒方向を分隊へ下ろす(`[v6.16]` ATP 3-21.8)──
      // 統合・再編中だけ非 null。分隊はこれをFTへ流し、FTは接触が無いときの
      // 「どちらの銃眼に就くか」をこれで決める。
      sq.watch = consolidating
        ? {
            x: objective.x + consolidating.watch.x * WATCH_MARK_DIST,
            z: objective.z + consolidating.watch.z * WATCH_MARK_DIST,
          }
        : null;

      // 確保済み拠点の保持(`[v6.1]`、`[v6.2]` で最寄り1個分隊に限定)。
      // 0.7: 拠点の縁寄りまで許して守備隊を中心に固めず、拠点内の遮蔽へ分散させる
      // (`[v6.1]` 指摘: 守備隊は拠点内の遮蔽に散る)。
      // 下限 SQUAD_HOLD_SPREAD: 拠点が1室でも分隊9名が点に固まらないだけの床を残す。
      const held = holders.get(sq.squadId) ?? null;
      if (held) {
        // 下限は**拠点の内側**に収める(`[v6.7]`)。分隊の重心が判定円の中に入れば、
        // 隊形で散った隊員のうち何名かが確保に数えられる(仕様 §12)
        const spread = Math.min(SQUAD_HOLD_SPREAD, held.radius * SQUAD_HOLD_FRAC);
        objective = clampToObjective(objective, held, 0.7, spread);
      }

      // 占領に指名された分隊は**正面幅のオフセットを受けない**(`[v6.9]`)。
      // 拠点は「戦列の起点」ではなく「立つ場所」なので、そこへ直接向かわせる。
      // `clearAssign`(掃討中の建物)より優先する — 拠点がその建物の中にあるなら
      // 分隊AIが扉経由の接近に振り替えるので、素通りにはならない。
      const occupied = occupiers.get(sq.squadId) ?? null;
      if (occupied) objective = { ...occupied.pos };

      let sqMission: Mission = {
        kind: sqKind,
        target: sqKind === "seize" ? { ...objective } : { ...aim },
      };
      let sqTechnique = technique;

      // 側面攻撃の役割(`[v7.0]`)。ベース分隊は脅威へ射線の通る位置で制圧に就き、
      // 機動分隊は弧の上の経由点へ(側面を取ったら脅威の位置そのものへ)向かう。
      const fr = flankRoles.get(sq.squadId) ?? null;
      let flankGoal: Vec2 | null = null;
      let flankAssault = false;
      if (fr && threat) {
        if (fr.role === "base") {
          objective = { ...threat.pos };
          sqMission = { kind: "support_by_fire", target: { ...threat.pos } };
        } else if (fr.goal) {
          objective = { ...fr.goal };
          sqMission = { kind: "seize", target: { ...fr.goal } };
          flankGoal = { ...fr.goal };
          // 回り込みは速さが命。躍進前進では弧を回りきる前に時間切れになる
          sqTechnique = "traveling_overwatch";
        } else {
          objective = { ...threat.pos };
          sqMission = { kind: "seize", target: { ...threat.pos } };
          flankAssault = true;
        }
      }
      pl.squadObjectives.set(sq.squadId, objective);
      pl.squadMissions.set(sq.squadId, sqMission);
      pl.squadTechniques.set(sq.squadId, sqTechnique);

      // 人間が操作している分隊には再割り当てを行わない(仕様 §4)。
      //
      // この分隊の意思決定者は既に人間へ置き換わっている。AIの小隊長が2秒ごとに
      // 目標を上書きすると、プレイヤーの出した命令が握り潰され「操作できない操作」に
      // なってしまう。現実の分隊長も上級部隊の意図から逸脱しうる(仕様 §3⑤の
      // アンカー+リーシュが個人レベルで認めているのと同じ性質)。
      //
      // 将来の精緻化: 小隊長は「任務(WHAT)」を与え、人間の分隊長はその範囲内で
      // 自由に実行する、という二段構えにするのが本来の姿。現状は任務と目標地点が
      // 未分化なため、単純に再割り当てを止めている。
      if (aiSuppressed(world, "squad", sq.side, sq.squadId)) return;

      // 小隊長の命令を分隊長へ渡す。これが階層間の下向きの情報流。
      sq.objective = objective;
      sq.mission = sqMission;
      sq.technique = sqTechnique;
      sq.flankGoal = flankGoal;
      sq.flankAssault = flankAssault;
    });
  }
}
