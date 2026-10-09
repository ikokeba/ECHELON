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
  FLASH_REPORT,
  POS_ERROR_GROWTH,
  POS_ERROR_MAX,
  RADIO_LATENCY_SEC,
  REPORT_INTERVAL_SEC,
  SIM_HZ,
} from "./constants.ts";
import { forwardOf } from "./c2/flot.ts";
import type {
  Contact,
  FlashReason,
  FlashWatch,
  Report,
  Side,
  SubordinateReport,
  Vec2,
} from "./types.ts";
import type { World } from "./world.ts";

const REPORT_INTERVAL_TICKS = Math.round(REPORT_INTERVAL_SEC * SIM_HZ);
const RADIO_LATENCY_TICKS = Math.round(RADIO_LATENCY_SEC * SIM_HZ);
const FLASH_GAP_TICKS = Math.round(FLASH_REPORT.MIN_GAP_SEC * SIM_HZ);

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

/**
 * 自陣営の前進フレームで最も前に出ている位置(`[v6.16]`)。
 * 「うちの先頭はここ」は部隊が自分で把握している事実なので、報告に載せてよい。
 */
function leadOf(points: readonly Vec2[], advanceDir: Vec2): Vec2 {
  let best = points[0] ?? { x: 0, z: 0 };
  let bestF = -Infinity;
  for (const p of points) {
    const f = forwardOf(advanceDir, p);
    if (f > bestF) {
      bestF = f;
      best = p;
    }
  }
  return { ...best };
}

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
    c.posError = posErrorOf(c, age);
    // 確度0(仕様 §5「180秒で消滅」)でも接触情報自体は消さない。`[v6]` の決定どおり、
    // 最終目撃情報のゴーストとして残置し、AIの索敵対象からのみ除外する
    // (除外の判定は利用側が confidence を見て行う)。
    // ただし10分以上経った完全に無意味な情報だけは、メモリ肥大を避けるため破棄する。
    if (c.confidence < CONFIDENCE_CUTOFF && age > 600) {
      belief.delete(key);
    }
  }
}

/**
 * 接触の位置誤差(m)。見た接触は「ホップ由来の粗さ + 経過時間による拡大」を上限で頭打ち。
 * 聞いた接触(`[v7.3]` A-5)は最初から粗さそのものが誤差で、時間では広げない
 * (音の見積もりの粗さ `heardError` に、無線のホップぶんの粗さ `hopError` を足す)。
 */
export function posErrorOf(c: Contact, ageSec: number): number {
  if (c.heard) return (c.heardError ?? 0) + c.hopError;
  return Math.min(POS_ERROR_MAX, c.hopError + ageSec * POS_ERROR_GROWTH);
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
      if (r.flash) logFlash(world, r);
      if (r.fromEchelon === "soldier") {
        // 観測ドローンの操縦手 → 中隊長(`[v7.3]` A-2)。接触だけを統合する(部下の状況ではない)
        const co = world.companies.find((c) => c.side === r.side && c.companyId === r.toUnitId);
        if (co) for (const c of r.contacts) mergeContact(co.belief, c);
      } else if (r.fromEchelon === "squad") {
        const pl = world.platoons.find((p) => p.side === r.side && p.platoonId === r.toUnitId);
        if (pl) {
          for (const c of r.contacts) mergeContact(pl.belief, c);
          storeSubordinate(pl.squadReports, r.fromUnitId, r);
        }
      } else if (r.fromEchelon === "platoon") {
        const co = world.companies.find((c) => c.side === r.side && c.companyId === r.toUnitId);
        if (co) {
          for (const c of r.contacts) mergeContact(co.belief, c);
          storeSubordinate(co.platoonReports, r.fromUnitId, r);
        }
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
  for (const d of world.drones) {
    decayBelief(d.belief, world.tick);
  }

  // ── 4. 定時報告の生成: 分隊長 → 小隊長 ──
  for (const sq of world.squads) {
    // ドクトリンで報告が疎になる(仕様 §13)。正規軍は倍率1で現行と一致 `[v6.8]`
    const doc = sideDoctrine(world, sq.side);
    // 臨時報告(`[v7.3]` A-8)。重要な変化があれば定時を待たずに今送る
    const flash = flashReasons(world, sq.flashWatch, {
      contact: hasFirmContact(sq.belief),
      commanderId: sq.commanderId,
      routed: routedFireteams(world, sq.side, (squadId) => squadId === sq.squadId),
    });
    if (!flash && world.tick - sq.lastReportTick < REPORT_INTERVAL_TICKS * doc.reportIntervalMul) {
      continue;
    }
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
      ...(flash ? { flash } : {}),
      ownStatus: {
        effective: effective.length,
        total: members.length,
        posCentroid: centroidOf(effective.map((s) => s.pos)),
        posLead: leadOf(effective.map((s) => s.pos), sq.advanceDir),
      },
    });
  }

  // ── 5. 定時報告の生成: 小隊長 → 中隊長 ──
  //    ここで2ホップ目の遅延と粒度低下が乗る。中隊長が持つのは
  //    「分隊長が見たものを、小隊長が受け取って、さらに転送したもの」であり、
  //    仕様 §5 の「さらに遅延・粒度が粗くなる」が構造的に成立する。
  for (const pl of world.platoons) {
    const plDoc = sideDoctrine(world, pl.side);
    // 小隊長の臨時報告(`[v7.3]`)。接敵は分隊の臨時報告が届いて小隊長の像に確かな接触が
    // 載った時点で立つので、分隊 → 小隊 → 中隊と1ホップずつ遅れて伝わる(仕様 §5)
    const squadIds = new Set(
      world.squads
        .filter((q) => q.side === pl.side && q.platoonId === pl.platoonId)
        .map((q) => q.squadId),
    );
    const flash = flashReasons(world, pl.flashWatch, {
      contact: hasFirmContact(pl.belief),
      commanderId: pl.commanderId,
      routed: routedFireteams(world, pl.side, (squadId) => squadIds.has(squadId)),
    });
    if (!flash && world.tick - pl.lastReportTick < REPORT_INTERVAL_TICKS * plDoc.reportIntervalMul) {
      continue;
    }
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
      ...(flash ? { flash } : {}),
      ownStatus: {
        effective: effective.length,
        total: members.length,
        posCentroid: centroidOf(effective.map((s) => s.pos)),
        posLead: leadOf(effective.map((s) => s.pos), pl.advanceDir),
      },
    });
  }

  // ── 6. 観測ドローンの操縦手 → 中隊長(`[v7.3]` A-2) ──
  droneReports(world);
}

/**
 * 観測ドローンの操縦手 → 中隊長の報告(`[v7.3]` ロードマップ A-2)。分隊長 → 小隊長と同じ作法:
 * 5秒ごとの定時と、新しく確かな接触を見たときの臨時報告。遅延・粒度の低下・減衰も同じに掛かる
 */
function droneReports(world: World): void {
  for (const d of world.drones) {
    const op = world.soldierById.get(d.operatorId);
    if (!op || op.status !== "ok" || d.belief.size === 0) continue;
    const doc = sideDoctrine(world, d.side);
    const flash = flashReasons(world, d.flashWatch, {
      contact: hasFirmContact(d.belief),
      commanderId: d.flashWatch.commanderId,
      routed: 0,
    });
    if (!flash && world.tick - d.lastReportTick < REPORT_INTERVAL_TICKS * doc.reportIntervalMul) continue;
    d.lastReportTick = world.tick;
    world.reports.push({
      fromEchelon: "soldier",
      fromUnitId: op.id,
      toUnitId: d.companyId,
      side: d.side,
      sentTick: world.tick,
      deliverTick: world.tick + Math.round(RADIO_LATENCY_TICKS * doc.radioLatencyMul),
      contacts: selectContactsForReport(d.belief),
      ...(flash ? { flash } : {}),
      ownStatus: { effective: 1, total: 1, posCentroid: { ...op.pos }, posLead: { ...op.pos } },
    });
  }
}

/** 確かな接触(確度が FTの CONTACT 判定と同じ線を超える)を1件でも持っているか */
function hasFirmContact(belief: Map<string, Contact>): boolean {
  for (const c of belief.values()) if (c.confidence >= FLASH_REPORT.CONTACT_CONF) return true;
  return false;
}

/** 条件に合う分隊に属するFTのうち、潰走しているものの数 */
function routedFireteams(world: World, side: Side, inUnit: (squadId: number) => boolean): number {
  let n = 0;
  for (const ft of world.fireteams) {
    if (ft.side === side && ft.routedSinceTick !== null && inUnit(ft.squadId)) n++;
  }
  return n;
}

/**
 * 臨時報告を出すべきか(`[v7.3]` ロードマップ A-8)。出すならきっかけの一覧、出さないなら null。
 *
 * 前回覚えた状態(`watch`)といまの状態を比べ、**変わったときだけ**立てる。
 *   - 接敵: 確かな接触が「無い → ある」。消えたほうは報告しない(定時で足りる)
 *   - 指揮官: 継いだ者が変わった。最初に席に着いたとき(前が null)は変化ではない
 *   - 潰走: 潰走しているFTが増えた
 * 間隔の下限(`MIN_GAP_SEC`)の内側で起きた変化は、`watch` を更新しないまま次に持ち越す。
 * 取りこぼさず、かつ撃ち合いのあいだ無線を埋めない。
 */
function flashReasons(
  world: World,
  watch: FlashWatch,
  now: { contact: boolean; commanderId: number | null; routed: number },
): FlashReason[] | null {
  const reasons: FlashReason[] = [];
  if (now.contact && !watch.contact) reasons.push("contact");
  if (watch.commanderId !== null && now.commanderId !== watch.commanderId) {
    reasons.push("commander");
  }
  if (now.routed > watch.routed) reasons.push("rout");

  if (reasons.length > 0 && world.tick - watch.lastFlashTick < FLASH_GAP_TICKS) return null;

  // 送るか、知らせるほどでもない変化(接触が消えた・潰走が減った)なら、いまの状態を覚える
  watch.contact = now.contact;
  watch.commanderId = now.commanderId;
  watch.routed = now.routed;
  if (reasons.length === 0) return null;
  watch.lastFlashTick = world.tick;
  return reasons;
}

/** 受信した臨時報告を UI 用の記録へ残す(`[v7.3]`)。シムの判断には使わない */
function logFlash(world: World, r: Report): void {
  world.flashLog.unshift({
    side: r.side,
    tick: world.tick,
    sentTick: r.sentTick,
    fromEchelon: r.fromEchelon,
    fromUnitId: r.fromUnitId,
    reasons: [...(r.flash ?? [])],
    contacts: r.contacts.length,
  });
  if (world.flashLog.length > FLASH_REPORT.LOG_KEEP) world.flashLog.length = FLASH_REPORT.LOG_KEEP;
}

/**
 * 到着した報告の `ownStatus` を、上位が持つ「部下の最新状況」へ留め置く(`[v6.16]`)。
 * 前線(FLOT)はここに溜まったものだけから引く — 盤面を見ない、が要点(仕様 §5)。
 */
export function storeSubordinate(
  into: Map<number, SubordinateReport>,
  fromUnitId: number,
  r: Report,
): void {
  const prev = into.get(fromUnitId);
  // 遅延の揺れで古い報告が後から届くことがある。新しいほうだけを残す
  if (prev && prev.sentTick >= r.sentTick) return;
  into.set(fromUnitId, {
    unitId: fromUnitId,
    pos: { ...r.ownStatus.posCentroid },
    posLead: { ...r.ownStatus.posLead },
    effective: r.ownStatus.effective,
    total: r.ownStatus.total,
    sentTick: r.sentTick,
  });
}
