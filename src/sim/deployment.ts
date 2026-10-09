/**
 * 配置プラン — 初期展開位置と拠点をプレイヤーが決める(`[v6.4]`)。
 *
 * シナリオ生成器そのものには手を入れず、**生成済みの `Scenario` を変換する**形にした。
 * 生成器は編成・隊形・任務の割り当てを一手に引き受けており、そこへ引数を足していくと
 * 4つのシナリオすべてに同じ分岐が増える。展開位置の変更は本質的に
 * 「その陣営の全員を剛体として動かす」ことなので、後段の変換で足りる。
 *
 * ここが守ること:
 *   - 隊形は崩さない。陣営の重心を基準にした**平行移動+回転**しか行わない
 *     (各兵士を個別に動かすと、生成器が組んだ隊形と隊列間隔が壊れる)
 *   - 指揮所(CP)・負傷者集合点(CCP)・集結地点は部隊と一緒に動く。後方地点なので、
 *     部隊だけ動かすと担架班が盤面を横断することになる
 *   - 任務目標(objective)は動かさない。これは「どこへ向かうか」であって配置ではない。
 *     拠点を置き換えた場合だけ、各階層の任務目標を新しい主拠点へ向け直す
 *   - 盤外へは置けない。ナビグリッドは bounds から作られるので、外に出た地点は
 *     到達不能になる(CCPで実際にそれを踏んだ)
 *
 * **点対称性について(仕様 §2/§13)**: 既定のシナリオは点対称で、それが
 * 「地形由来ではない有利不利が無い」ことの担保になっている。プレイヤーが非対称に
 * 置いた場合その担保は外れるが、それはプレイヤーの選択であって不具合ではない。
 * `isPointSymmetric` で判定できるようにして、UI側で知らせる。
 */

import { clamp } from "./geometry.ts";
import { OBJECTIVE } from "./constants.ts";
import type { BattleMode, Bounds, DefenseEdit, PlanEdit, Scenario, Side, Vec2 } from "./types.ts";

/** 拠点1つぶんの配置指定。 */
export interface ObjectivePlacement {
  label: string;
  pos: Vec2;
  radius: number;
}

/** 陣営1つぶんの展開指定。 */
export interface SpawnPlacement {
  /** 部隊の重心を置く地点 */
  pos: Vec2;
  /** 部隊の正面。単位ベクトルでなくてもよい(正規化する) */
  facing: Vec2;
}

export interface DeploymentPlan {
  /** 指定のある陣営だけ動かす */
  spawn: Partial<Record<Side, SpawnPlacement>>;
  /** null なら既定の拠点をそのまま使う。空配列なら「拠点なし」(戦力枯渇のみで決着) */
  objectives: ObjectivePlacement[] | null;
  /** 戦闘の型(仕様 §12)。未指定は遭遇戦 `[v6.8]` */
  mode?: BattleMode;
  /** 攻防戦の攻撃側。防御側は最初から全拠点を保有する */
  attacker?: Side;
  /** 攻防戦の制限時間(秒) */
  timeLimitSec?: number;
  /**
   * 立案時に人間が置き直した防衛陣地(`[v7.2]` S-1)。初期条件の一部(ロードマップ P3)。
   * 配置エディタで盤面を変えると AI 案の並びが変わるので、そのときは捨てる
   */
  defense?: DefenseEdit[];
  /** 立案時に人間・LLM が書き換えた作戦(`[v7.3]` A-1)。初期条件の一部(P3) */
  plan?: PlanEdit[];
}

/** 展開点を盤内に収めるための余白 m。ナビグリッドの縁に食い込ませない。 */
export const DEPLOY_MARGIN = 12;

function norm(v: Vec2): Vec2 {
  const d = Math.hypot(v.x, v.z);
  return d < 1e-9 ? { x: 0, z: 1 } : { x: v.x / d, z: v.z / d };
}

function clampToBounds(p: Vec2, b: Bounds, margin: number): Vec2 {
  return {
    x: clamp(p.x, b.minX + margin, b.maxX - margin),
    z: clamp(p.z, b.minZ + margin, b.maxZ - margin),
  };
}

/** 陣営の兵士の重心。 */
function sideCentroid(sc: Scenario, side: Side): Vec2 | null {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const s of sc.soldiers) {
    if (s.side !== side) continue;
    x += s.pos.x;
    z += s.pos.z;
    n++;
  }
  return n === 0 ? null : { x: x / n, z: z / n };
}

/** 陣営の平均の向き。既定シナリオでは全員が同じ方向を向いている。 */
function sideFacing(sc: Scenario, side: Side): Vec2 {
  let x = 0;
  let z = 0;
  for (const s of sc.soldiers) {
    if (s.side !== side) continue;
    x += s.facing.x;
    z += s.facing.z;
  }
  return norm({ x, z });
}

/**
 * 現在のシナリオから既定の配置プランを読み取る。UIの初期値に使う。
 */
export function defaultDeploymentOf(sc: Scenario): DeploymentPlan {
  const spawn: Partial<Record<Side, SpawnPlacement>> = {};
  for (const side of ["blue", "red"] as const) {
    const c = sideCentroid(sc, side);
    if (c) spawn[side] = { pos: c, facing: sideFacing(sc, side) };
  }
  return {
    spawn,
    objectives: (sc.objectives ?? []).map((o) => ({
      label: o.label,
      pos: { ...o.pos },
      radius: o.radius,
    })),
    mode: sc.mode ?? "meeting",
    attacker: sc.attacker ?? "blue",
    timeLimitSec: sc.timeLimitSec ?? OBJECTIVE.ASSAULT_TIME_LIMIT_SEC,
  };
}

/** 2つの地点が原点について点対称か(許容誤差 m)。 */
function mirrored(a: Vec2, b: Vec2, eps: number): boolean {
  return Math.abs(a.x + b.x) <= eps && Math.abs(a.z + b.z) <= eps;
}

/**
 * この配置プランが点対称か(仕様 §2/§13)。
 * 非対称でも動くが、「地形由来ではない有利不利が無い」担保は外れる。
 */
export function isPointSymmetric(plan: DeploymentPlan, eps = 1.5): boolean {
  const b = plan.spawn.blue;
  const r = plan.spawn.red;
  if (b && r) {
    if (!mirrored(b.pos, r.pos, eps)) return false;
    const bf = norm(b.facing);
    const rf = norm(r.facing);
    if (Math.abs(bf.x + rf.x) > 0.05 || Math.abs(bf.z + rf.z) > 0.05) return false;
  }
  const objs = plan.objectives;
  if (objs) {
    // 各拠点に、点対称の位置の相方がいること(中央の拠点は自分自身が相方)
    for (const o of objs) {
      if (!objs.some((p) => mirrored(o.pos, p.pos, eps))) return false;
    }
  }
  return true;
}

/** 青の配置を原点対称に写して赤にする(UIの「点対称にする」)。 */
export function mirrorPlan(plan: DeploymentPlan): DeploymentPlan {
  const b = plan.spawn.blue;
  const spawn = { ...plan.spawn };
  if (b) spawn.red = { pos: { x: -b.pos.x, z: -b.pos.z }, facing: { x: -b.facing.x, z: -b.facing.z } };
  return { ...plan, spawn };
}

/**
 * 配置プランをシナリオへ適用した新しいシナリオを返す(引数は破壊しない)。
 */
export function applyDeployment(sc: Scenario, plan: DeploymentPlan): Scenario {
  const out: Scenario = {
    ...sc,
    // 戦闘の型はプレイヤーの指定をそのまま持ち込む(仕様 §12)`[v6.8]`
    mode: plan.mode ?? sc.mode ?? "meeting",
    attacker: plan.attacker ?? sc.attacker ?? "blue",
    timeLimitSec: plan.timeLimitSec ?? sc.timeLimitSec ?? OBJECTIVE.ASSAULT_TIME_LIMIT_SEC,
    ...(plan.defense && plan.defense.length > 0
      ? { defenseEdits: plan.defense.map((e) => ({ ...e, pos: { ...e.pos } })) }
      : {}),
    ...(plan.plan && plan.plan.length > 0
      ? { planEdits: plan.plan.map((e) => JSON.parse(JSON.stringify(e)) as PlanEdit) }
      : {}),
    soldiers: sc.soldiers.map((s) => ({
      ...s,
      pos: { ...s.pos },
      facing: { ...s.facing },
      eye: { ...s.eye },
      order: {
        ...s.order,
        ...(s.order.target ? { target: { ...s.order.target } } : {}),
        ...(s.order.facing ? { facing: { ...s.order.facing } } : {}),
      },
    })),
  };

  // ── 1. 陣営ごとの剛体変換 ──
  for (const side of ["blue", "red"] as const) {
    const want = plan.spawn[side];
    if (!want) continue;
    const from = sideCentroid(sc, side);
    if (!from) continue;

    const to = clampToBounds(want.pos, sc.bounds, DEPLOY_MARGIN);
    const f0 = sideFacing(sc, side);
    const f1 = norm(want.facing);
    // f0 → f1 の回転(2次元の複素数積)。重心を中心に回してから平行移動する
    const cos = f0.x * f1.x + f0.z * f1.z;
    const sin = f0.x * f1.z - f0.z * f1.x;

    const move = (p: Vec2): Vec2 => {
      const dx = p.x - from.x;
      const dz = p.z - from.z;
      return { x: to.x + dx * cos - dz * sin, z: to.z + dx * sin + dz * cos };
    };
    const turn = (v: Vec2): Vec2 => ({ x: v.x * cos - v.z * sin, z: v.x * sin + v.z * cos });

    for (const s of out.soldiers) {
      if (s.side !== side) continue;
      s.pos = clampToBounds(move(s.pos), sc.bounds, 1);
      s.facing = turn(s.facing);
      s.eye = { ...s.pos };
      if (s.order.target) s.order.target = move(s.order.target);
      if (s.order.facing) s.order.facing = turn(s.order.facing);
    }

    // 後方地点(CCP・CP・集結地点)は部隊と一緒に動く
    if (out.ccp) {
      out.ccp = { ...out.ccp, [side]: clampToBounds(move(out.ccp[side]), sc.bounds, DEPLOY_MARGIN) };
    }
    out.companyPlans = (out.companyPlans ?? []).map((c) =>
      c.side === side
        ? {
            ...c,
            rallyPoint: clampToBounds(move(c.rallyPoint), sc.bounds, DEPLOY_MARGIN),
            ...(c.cp ? { cp: clampToBounds(move(c.cp), sc.bounds, DEPLOY_MARGIN) } : {}),
            advanceDir: turn(c.advanceDir),
          }
        : c,
    );
    out.platoonPlans = (out.platoonPlans ?? []).map((p) =>
      p.side === side
        ? { ...p, rallyPoint: move(p.rallyPoint), advanceDir: turn(p.advanceDir) }
        : p,
    );
    out.squadPlans = (out.squadPlans ?? []).map((p) =>
      p.side === side
        ? { ...p, rallyPoint: move(p.rallyPoint), advanceDir: turn(p.advanceDir) }
        : p,
    );
    out.fireteamPlans = (out.fireteamPlans ?? []).map((p) =>
      p.side === side
        ? { ...p, rallyPoint: move(p.rallyPoint), advanceDir: turn(p.advanceDir) }
        : p,
    );
  }

  // ── 2. 拠点の置き換え ──
  if (plan.objectives) {
    const objs = plan.objectives.map((o, i) => ({
      id: i + 1,
      label: o.label,
      pos: clampToBounds(o.pos, sc.bounds, 1),
      radius: o.radius,
      size: "small" as const,
    }));
    out.objectives = objs;
    out.controlMeasures = objs.map((o) => ({
      kind: "OBJ" as const,
      label: o.label,
      points: [{ ...o.pos }],
    }));

    // 各階層の任務目標を「自分に最も近い拠点」へ向け直す。拠点を動かしたのに
    // 部隊が元の座標へ向かって歩き出すと、配置を変えた意味がなくなる。
    const aimFor = (p: Vec2): Vec2 => {
      if (objs.length === 0) return { x: 0, z: 0 };
      let best = objs[0]!;
      let bestD = Infinity;
      for (const o of objs) {
        const d = Math.hypot(o.pos.x - p.x, o.pos.z - p.z);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      return { ...best.pos };
    };
    out.companyPlans = (out.companyPlans ?? []).map((c) => ({
      ...c,
      objective: aimFor(c.cp ?? c.rallyPoint),
    }));
    out.platoonPlans = (out.platoonPlans ?? []).map((p) => ({
      ...p,
      objective: aimFor(p.rallyPoint),
    }));
    out.squadPlans = (out.squadPlans ?? []).map((p) => ({
      ...p,
      objective: aimFor(p.rallyPoint),
    }));
    out.fireteamPlans = (out.fireteamPlans ?? []).map((p) => ({
      ...p,
      objective: aimFor(p.rallyPoint),
    }));
  }

  return out;
}
