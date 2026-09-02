/**
 * 無線報告システム(仕様 §5 情報の階層化)。
 *
 * 仕様の中核ルール: **分隊間・小隊間は生の視界を共有しない**。上位階層への情報伝達は
 * 無線報告のみで、遅延と確度減衰を伴う。
 *
 * 各階層が情報を得る経路は次の通り:
 *   一兵卒     : 自分の扇形視界(perception.ts)
 *   FTリーダー : チーム4名の視界の合算(c2/fireteam.ts の memory)
 *   分隊長     : 麾下2FTの視界の合算 ← ここまでは無線を介さない直接参照
 *   小隊長     : 各分隊長からの**報告のみ**(遅延・確度減衰あり) ← ここから無線
 *   中隊長     : 各小隊長からの報告の集約(さらに遅延・粒度が粗い)
 *
 * 実装上の要点は「報告は送信時点のスナップショットである」こと。受信側のbeliefへ
 * 統合されたあとも確度は減衰し続けるため、上位ほど古く粗い像を持つ。これは欠陥ではなく
 * 仕様が意図した非対称性そのもの。
 */

import { decayedConfidence } from "./belief.ts";
import { isDegraded } from "./c2/succession.ts";
import { sideDoctrine } from "./world.ts";
import {
  CONFIDENCE_CUTOFF,
  DEGRADED_RADIO_LATENCY_MUL,
  POS_ERROR_GROWTH,
  POS_ERROR_MAX,
  RADIO_LATENCY_SEC,
  REPORT_INTERVAL_SEC,
  SIM_HZ,
} from "./constants.ts";
import type { Contact, Report, Side, Vec2 } from "./types.ts";
import type { World } from "./world.ts";

const REPORT_INTERVAL_TICKS = Math.round(REPORT_INTERVAL_SEC * SIM_HZ);
const RADIO_LATENCY_TICKS = Math.round(RADIO_LATENCY_SEC * SIM_HZ);

/**
 * 報告に載せる接触情報の確度の下限。これを下回る古い情報は、無線の帯域を無駄に
 * 使うだけなので報告しない(現実の無線交話でも「もう分からない」情報は流さない)。
 */
const REPORT_CONFIDENCE_FLOOR = 0.25;

/**
 * 上位階層へ報告する際、位置情報に加算される粒度の粗さ(m)。
 * 仕様 §5「中隊長は各小隊長からの報告の集約(さらに遅延・粒度が粗くなる)」を、
 * 1ホップごとの位置誤差の増加として表現する。
 */
const HOP_POS_ERROR = 1.5;

function centroidOf(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    z += p.z;
  }
  return { x: x / points.length, z: z / points.length };
}

/** 接触情報を1件、受信側のbeliefへ統合する。より新しい観測のみが勝つ。 */
function mergeContact(belief: Map<string, Contact>, incoming: Contact): void {
  const existing = belief.get(incoming.key);
  // 受信側が既により新しい情報を持っているなら、古い報告で上書きしない
  if (existing && existing.lastSeenTick >= incoming.lastSeenTick) return;
  belief.set(incoming.key, {
    ...incoming,
    pos: { ...incoming.pos },
  });
}

/**
 * ある belief 全体の確度と不確度円を、現在ティック基準で再計算する。
 * `posError` は「ホップ由来の粗さ + 経過時間による拡大」として毎回組み立て直す
 * (加算し続けると単調に膨張してしまうため)。
 */
export function decayBelief(belief: Map<string, Contact>, tick: number): void {
  for (const [key, c] of belief) {
    const age = (tick - c.lastSeenTick) / SIM_HZ;
    c.confidence = decayedConfidence(age);
    c.posError = Math.min(POS_ERROR_MAX, c.hopError + age * POS_ERROR_GROWTH);
    // 確度0(仕様 §5「180秒で消滅」)でも接触情報自体は消さない。`[v6]` の決定どおり、
    // 最終目撃情報のゴーストとして残置し、AIの索敵対象からのみ除外する
    // (除外の判定は利用側が confidence を見て行う)。
    // ただし10分以上経った完全に無意味な情報だけは、メモリ肥大を避けるため破棄する。
    if (c.confidence < CONFIDENCE_CUTOFF && age > 600) {
      belief.delete(key);
    }
  }
}

/** 報告に載せるべき接触情報を選び、1ホップ分の粒度低下を加える。 */
function selectContactsForReport(belief: Map<string, Contact>): Contact[] {
  const out: Contact[] = [];
  for (const c of belief.values()) {
    if (c.confidence < REPORT_CONFIDENCE_FLOOR) continue;
    out.push({
      ...c,
      pos: { ...c.pos },
      hopError: c.hopError + HOP_POS_ERROR,
    });
  }
  return out;
}

function livingSoldiersOfSquad(world: World, side: Side, squadId: number) {
  return world.soldiers.filter((s) => s.side === side && s.squadId === squadId);
}

/**
 * 無線システム本体。step.ts から毎ティック呼ばれる。
 * 順序が重要: 到達 → 減衰 → 送信 の順にすることで、送信する情報が
 * 「このティック時点で最新の、正しく減衰済みの像」になる。
 */
export function radioSystem(world: World): void {
  // ── 1. 到達済みの報告を受信側のbeliefへ統合する ──
  if (world.reports.length > 0) {
    const stillInFlight: Report[] = [];
    for (const r of world.reports) {
      if (world.tick < r.deliverTick) {
        stillInFlight.push(r);
        continue;
      }
      if (r.fromEchelon === "squad") {
        const pl = world.platoons.find((p) => p.side === r.side && p.platoonId === r.toUnitId);
        if (pl) for (const c of r.contacts) mergeContact(pl.belief, c);
      } else if (r.fromEchelon === "platoon") {
        const co = world.companies.find((c) => c.side === r.side && c.companyId === r.toUnitId);
        if (co) for (const c of r.contacts) mergeContact(co.belief, c);
      }
    }
    world.reports = stillInFlight;
  }

  // ── 2. 分隊長のbeliefを、麾下FTの視界の合算として組み直す(仕様 §5) ──
  //    分隊長だけは無線を介さず直接見える。ここが「生の視界」の上限。
  for (const sq of world.squads) {
    const fireteams = world.fireteams.filter(
      (f) => f.side === sq.side && f.squadId === sq.squadId,
    );
    for (const ft of fireteams) {
      for (const c of ft.memory.values()) mergeContact(sq.belief, c);
    }
    decayBelief(sq.belief, world.tick);
  }

  // ── 3. 小隊長・中隊長のbeliefを減衰させる(中身は無線経由でしか増えない) ──
  for (const pl of world.platoons) {
    decayBelief(pl.belief, world.tick);
  }
  for (const co of world.companies) {
    decayBelief(co.belief, world.tick);
  }

  // ── 4. 定時報告の生成: 分隊長 → 小隊長 ──
  for (const sq of world.squads) {
    // ドクトリンで報告が疎になる(仕様 §13)。正規軍は倍率1で現行と一致 `[v6.8]`
    const doc = sideDoctrine(world, sq.side);
    if (world.tick - sq.lastReportTick < REPORT_INTERVAL_TICKS * doc.reportIntervalMul) continue;
    sq.lastReportTick = world.tick;

    const members = livingSoldiersOfSquad(world, sq.side, sq.squadId);
    const effective = members.filter((s) => s.status === "ok");
    if (effective.length === 0) continue; // 全滅した分隊は報告を送れない

    world.reports.push({
      fromEchelon: "squad",
      fromUnitId: sq.squadId,
      toUnitId: sq.platoonId,
      side: sq.side,
      sentTick: world.tick,
      deliverTick: world.tick + Math.round(RADIO_LATENCY_TICKS * doc.radioLatencyMul),
      contacts: selectContactsForReport(sq.belief),
      ownStatus: {
        effective: effective.length,
        total: members.length,
        posCentroid: centroidOf(effective.map((s) => s.pos)),
      },
    });
  }

  // ── 5. 定時報告の生成: 小隊長 → 中隊長 ──
  //    ここで2ホップ目の遅延と粒度低下が乗る。中隊長が持つのは
  //    「分隊長が見たものを、小隊長が受け取って、さらに転送したもの」であり、
  //    仕様 §5 の「さらに遅延・粒度が粗くなる」が構造的に成立する。
  for (const pl of world.platoons) {
    const plDoc = sideDoctrine(world, pl.side);
    if (world.tick - pl.lastReportTick < REPORT_INTERVAL_TICKS * plDoc.reportIntervalMul) continue;
    pl.lastReportTick = world.tick;

    const members = world.soldiers.filter(
      (s) => s.side === pl.side && s.platoonId === pl.platoonId,
    );
    const effective = members.filter((s) => s.status === "ok");
    if (effective.length === 0) continue;

    // 中隊長が無力化されている間は報告が遅延する(仕様 §11「報告遅延…C2の一時的な混乱」)
    const co = world.companies.find((c) => c.side === pl.side && c.companyId === pl.companyId);
    const latencyMul = co && isDegraded(co) ? DEGRADED_RADIO_LATENCY_MUL : 1;

    world.reports.push({
      fromEchelon: "platoon",
      fromUnitId: pl.platoonId,
      toUnitId: pl.companyId,
      side: pl.side,
      sentTick: world.tick,
      deliverTick:
        world.tick + Math.round(RADIO_LATENCY_TICKS * latencyMul * plDoc.radioLatencyMul),
      contacts: selectContactsForReport(pl.belief),
      ownStatus: {
        effective: effective.length,
        total: members.length,
        posCentroid: centroidOf(effective.map((s) => s.pos)),
      },
    });
  }
}
