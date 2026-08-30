/**
 * ファイアチームリーダーAI — すなわち命令システム
 * (仕様 §1 [v5] の訂正: このステートマシンこそが仕様のいう「命令システム」である)。
 *
 * v5で検証済みの squad-12v12-3ft-autobattle-mock.jsx `updateSquadOrders` から移植。
 * 構造は保存している:
 *   モード選択(最小滞留時間によるヒステリシス付き) → モードごとの命令発行
 *   ADVANCE / SEARCH : バウンディングオーバーウォッチ(片方の組が躍進、片方が警戒)
 *   CONTACT          : ベース・オブ・ファイア組が制圧、機動組が側面へ回る
 *   FALLBACK         : 集結地点へ後退
 * 目的地キャッシュは到達するまで保持する(モックのばたつき防止規則)。
 *
 * 戦力対称性(仕様 §2/§13): このロジックは両陣営で完全に同一に動作する。
 * ここには `side` を読んで挙動を分岐させる箇所は一切存在しない。
 */

import { collidesWallIndexed, hasLineOfSightIndexed } from "../wallIndex.ts";
import {
  bestCoverPoint,
  bestFlankPoint,
  bestNearbyCover,
  nearestCoverTowards,
  pickSupportedBoundTarget,
} from "../cover.ts";
import {
  CONFIDENCE_CUTOFF,
  CONTACT_DRILL,
  COVER_SEEK,
  DM_DETECT_RANGE,
  MG,
  MORALE,
  WEAPON_RANGE,
  POS_ERROR_GROWTH,
  POS_ERROR_MAX,
  SIM_HZ,
} from "../constants.ts";
import { formationSlots } from "../formation.ts";
import { meanTraits, traitMul } from "../traits.ts";
import { aiSuppressed } from "../control.ts";
import { isCommittedToAid } from "../systems/casualties.ts";
import { isCommittedToLitter, isOffField } from "../systems/litter.ts";
import { exitCqb, runCqb } from "./cqbDrill.ts";
import { decayedConfidence } from "../belief.ts";
import type { Contact, FireteamMode, FireteamState, Soldier, Vec2 } from "../types.ts";
import type { World } from "../world.ts";

// ── チューニング値(モック由来。squad-12v12 の TEAM_DEFS を参照)。
//    仕様 §14 の個体差パラメータは、チーム単位の「性格」ではなくFT単位でこれらを変調する。
const ENGAGE_MIN = 8;
/**
 * 交戦距離帯の上限 m。`[v6.3]` 従来はモック由来の 15m 固定で、これがFT AIに
 * 「敵へ15mまで詰めろ」と言い続けていたため、市街地でも街路の真ん中で殴り合っていた
 * (3回目のテストプレイ指摘「開けた空間で入り乱れていて現実的じゃない」)。
 * 武器の**有効射程帯**(`WEAPON_RANGE.*.effective`)から取るように変えた。
 * 索敵上限(`detect`)ではないことが重要 — そちらを使うと全員が最大射程で
 * 当たらない弾を撃ち続け、近接戦もCQBも起きなくなる。
 */
const ENGAGE_MAX = WEAPON_RANGE.rifle.effective;
const BOUND_MIN_ADV = 3;
const BOUND_MAX_ADV = 7;
/** モードを離れるまでの最小滞留ティック数(モック: 1.2秒)— FALLBACKへの遷移は例外 */
const MODE_DWELL_TICKS = Math.round(1.2 * SIM_HZ);
/** 到達済みの目的地を再選択するまでの待ち時間(モック: 1.5秒) */
const DEST_HOLD_TICKS = Math.round(1.5 * SIM_HZ);
/** 躍進レグ/目的地の「到達」とみなす距離(モック: 1.8 / 1.5m) */
const BOUND_ARRIVE = 1.8;
const DEST_ARRIVE = 1.5;
/** FTリーダーの意思決定周期。毎ティックではない */
const DECIDE_EVERY_TICKS = Math.round(0.3 * SIM_HZ);
/** 潰走の最短持続ティック(仕様 §12 `[v6]`) */
const MIN_ROUT_TICKS = Math.round(MORALE.MIN_ROUT_SEC * SIM_HZ);
/** 回避行動で下がる距離 m。遮蔽が見つからない場合はこの距離をそのまま下がる `[v6]` */
const EVADE_DIST = 6;
/**
 * break contact(FALLBACK)で1回に下がる距離 m。`[v6.1]`
 * **集結地点までの全面後退はしない** — 前線での躍進的な後退に留める。集結地点へ戻すのは
 * 士気崩壊(ROUT)だけ。頭数だけで下がって前線が消える不具合(初回テストプレイ指摘)への対処。
 */
const BREAK_DIST = 12;
/** FALLBACK 判定で「いま実際に撃ち合える敵」とみなす確度と距離。`[v6.1]` */
const NEAR_THREAT_CONF = 0.7;
const NEAR_THREAT_RANGE_MUL = 1.6;

function centroid(units: readonly Soldier[]): Vec2 {
  if (units.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const u of units) {
    x += u.pos.x;
    z += u.pos.z;
  }
  return { x: x / units.length, z: z / units.length };
}

function dirTo(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}

function rotate(dir: Vec2, theta: number): Vec2 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: dir.x * c + dir.z * s, z: dir.z * c - dir.x * s };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 移動組の隊員が1点に重ならないよう、横方向へずらすオフセット。 */
function offsetPerp(i: number, n: number, spacing: number, dir: Vec2): Vec2 {
  const perp = { x: -dir.z, z: dir.x };
  const k = i - (n - 1) / 2;
  return { x: perp.x * k * spacing, z: perp.z * k * spacing };
}

function issue(
  world: World,
  u: Soldier,
  kind: Soldier["order"]["kind"],
  target: Vec2 | null,
  look: Vec2,
): void {
  // 応急手当に拘束されている隊員へは命令を出さない(仕様 §9: 手当は命令不要の
  // 自律トリガーであり、命令系統の外側で発生する)。ここで上書きすると
  // 0.3秒ごとの命令更新で手当が永久に中断され続ける。
  if (isCommittedToAid(world, u)) return;
  // 担架搬送に就いている隊員も同様。こちらは分隊長の後送命令で拘束されているので、
  // FTリーダーの命令より上位の拘束になる(仕様 §9: 後送は明示的な命令)。
  if (isCommittedToLitter(u)) return;

  // 速度変調は命令を出し直すたびに素の値へ戻す。変調をかけたい呼び出し側は
  // issue のあとに設定する(担架搬送のように命令系統の外で拘束している場合は、
  // 上のガードでここへ来ないので変調が保たれる)。
  u.speedMul = 1;

  const prev = u.order;
  const movingKind = kind === "move" || kind === "maneuver" || kind === "retreat" || kind === "evade";
  const changedTarget =
    movingKind && (!prev.target || !target || dist(prev.target, target) > 0.35);

  u.order = {
    kind,
    ...(target ? { target: { ...target } } : {}),
    facing: { ...look },
    issuedTick: world.tick,
  };
  // 本当に新しい目的地であればキャッシュ済みの経路を破棄する
  if (changedTarget) {
    u.path = [];
    u.pathIdx = 0;
  }
}

/** FT隊員が見ているものをすべてリーダーの world picture へ統合する(仕様 §5 視界の合算)。 */
function updateMemory(world: World, ft: FireteamState, members: readonly Soldier[]): void {
  for (const m of members) {
    for (const id of m.sees) {
      const enemy = world.soldierById.get(id);
      if (!enemy || enemy.status === "kia") continue;
      const key = `s${id}`;
      const existing = ft.memory.get(key);
      const contact: Contact = {
        key,
        side: enemy.side,
        pos: { x: enemy.pos.x, z: enemy.pos.z },
        posError: 0,
        // 直接視認した接触なので無線ホップ由来の粗さはゼロ
        hopError: 0,
        lastSeenTick: world.tick,
        confidence: 1,
        count: 1,
      };
      if (existing) {
        existing.pos = contact.pos;
        existing.lastSeenTick = world.tick;
        existing.confidence = 1;
        existing.posError = 0;
      } else {
        ft.memory.set(key, contact);
      }
    }
  }

  // 減衰と切り捨て。戦死が確認された対象は即座に忘れる(仕様 §9: KIAは記憶からも即消去)
  for (const [key, c] of ft.memory) {
    const enemy = world.soldierById.get(Number(key.slice(1)));
    if (enemy && enemy.status === "kia") {
      ft.memory.delete(key);
      continue;
    }
    const age = (world.tick - c.lastSeenTick) / SIM_HZ;
    c.confidence = decayedConfidence(age);
    c.posError = Math.min(POS_ERROR_MAX, c.hopError + age * POS_ERROR_GROWTH);
    if (c.confidence < CONFIDENCE_CUTOFF) ft.memory.delete(key);
  }
}

/**
 * 崩壊/後退の判定(仕様 §12 補助条件: Morale Break)。
 *
 * 仕様が確定させているのは3点で、そのとおりに実装する:
 *   - **判定単位はファイアチーム**。分隊・小隊レベルでの直接判定は行わない。
 *     上位への波及は麾下FTの崩壊の集積として間接的に表現される
 *   - **トリガーはチーム内の未処置負傷者が50%以上という単一条件**。
 *     損耗率(戦死者の割合)や制圧射撃の蓄積は判定要因から切り離す
 *   - 自軍・敵軍とも同一条件(仕様 §13)
 *
 * `[v6]` 分母は「まだ戦場にいる隊員(健常+負傷)」とする。戦死者まで分母に残すと、
 * 半数が戦死した4名チームは残り2名がどうなろうと永久に潰走しなくなり、
 * 「崩壊」という現象が起きなくなってしまう。
 *
 * `[v6.1]` **未処置WIA比率は「崩壊のトリガー」であって「再編成のゲートではない」。**
 * 最小時間を過ぎ、隊が集結地点付近まで下がって接敵を切れたら立て直す(routed を解除)。
 * これをしないと、下がりきった隊が永久に50%アンカーで固まり、被弾で新たなWIAが出るたびに
 * 潰走が延命して二度と戦列復帰できない(初回テストプレイ指摘: 士気崩壊の回復を明確に)。
 */
/** 立て直しとみなす、集結地点からの距離 m。`[v6.1]` */
const REFORM_RALLY_DIST = 15;

function evaluateMorale(world: World, ft: FireteamState, onField: Soldier[]): boolean {
  if (ft.routedSinceTick !== null) {
    // 一度潰走したら最低時間は続ける。条件のふらつきで点滅させない
    if (world.tick - ft.routedSinceTick < MIN_ROUT_TICKS) return true;
    // 最小時間経過後: 集結地点付近まで下がり、いま制圧も受けていなければ立て直す。
    const mobile = onField.filter((s) => s.status === "ok");
    const reachedRally =
      mobile.length > 0 && dist(centroid(mobile), ft.rallyPoint) < REFORM_RALLY_DIST;
    const stillPinned = mobile.some((s) => s.suppressedUntilTick > world.tick);
    if (reachedRally && !stillPinned) return false;
  }
  if (onField.length === 0) return false;
  const untreated = onField.filter((s) => s.status === "wia" && !s.stabilized).length;
  return untreated / onField.length >= MORALE.UNTREATED_RATIO;
}

/**
 * モード選択。
 *
 * 戦力比較では、このFT単独ではなく**分隊全体**の有効戦力を、当該FTが把握している
 * 脅威数と突き合わせる。FTは設計上「分隊の半分」であり、もう半分の支援を受けて戦う
 * ものだから(仕様 §6 Fire and Movement)。4名を視認できる敵全員と比較してしまうと、
 * 両陣営とも初回接敵で劣勢と判断して後退し、戦闘が一切成立しなくなる。
 */
function selectMode(
  ft: FireteamState,
  squadStrength: number,
  memberCount: number,
  contacts: Contact[],
  routed: boolean,
  fallbackDeficit: number,
  /** 近距離・確度の高い脅威の数(`[v6.1]`)。全メモリ件数ではなくこれで劣勢を測る */
  nearThreats: number,
  /** FT内に制圧/回避中の隊員がいるか(`[v6.1]`)。break contact の必要条件 */
  pinned: boolean,
): FireteamMode {
  // 潰走はあらゆる判断に優先する。指揮ではなく崩壊なので、命令系統の外側にある
  if (routed) return "ROUT";
  // `[v6.1]` break contact は「多数を視認した」だけでは起こさない。
  // ①いま撃ち合える距離の確度の高い脅威に**局所的に**数で圧倒され、かつ
  // ②実際に制圧/回避へ追い込まれている、の両方が揃ったときだけ下がる。
  // 頭数(全メモリ件数)だけで下がると、両軍が初回接敵の直後に後退して前線が消える
  // (初回テストプレイ指摘: 前線を維持せず放棄する)。
  if (memberCount > 0 && pinned && squadStrength + fallbackDeficit < nearThreats) return "FALLBACK";
  // 突入命令を受けている間は室内専用モード。仕様 §7.3 は「室内クリアリング中は
  // 専用モードとして扱い、ADVANCE/CONTACT/SEARCH/FALLBACK のいずれとも異なる」と
  // 明記している。ただし後退判断だけは上位に置く — 崩れているのに突入はしない。
  if (ft.cqbDoorId !== null) return "CQB";
  if (contacts.some((c) => c.confidence > 0.85)) return "CONTACT";
  if (ft.memory.size > 0 || ft.searchPoint) return "SEARCH";
  return "ADVANCE";
}

/**
 * バウンディングオーバーウォッチ: 一方のバディペアが、もう一方のペアの支援射撃範囲内に
 * ある遮蔽位置へ躍進する。到達したら役割を交代する(仕様 §6)。
 */
function runBoundingOverwatch(
  world: World,
  ft: FireteamState,
  alpha: Soldier[],
  bravo: Soldier[],
  forward: Vec2,
  /** 躍進歩幅・最小/最大への乗数(`[v6.1]` 陣営別性格。既定 1 で現行値) */
  boundMinMul = 1,
  boundMaxMul = 1,
): void {
  const members = [...alpha, ...bravo];
  if (members.length === 0) return;
  const boundMin = BOUND_MIN_ADV * boundMinMul;
  const boundMax = BOUND_MAX_ADV * boundMaxMul;

  // 片方のペアが全滅した場合は2組運用が成立しない。硬直させず、生存者全員を1集団として動かす。
  if (alpha.length === 0 || bravo.length === 0) {
    const mc = centroid(members);
    if (!ft.boundTarget || dist(mc, ft.boundTarget) < BOUND_ARRIVE) {
      ft.boundTarget = pickSupportedBoundTarget(
        world.walls,
        world.coverPoints,
        mc,
        forward,
        boundMin,
        boundMax,
      );
    }
    const dest = ft.boundTarget;
    members.forEach((u, i) => {
      const off = offsetPerp(i, members.length, 1.3, forward);
      const look = rotate(forward, ((i % 2 === 0 ? -30 : 30) * Math.PI) / 180);
      if (dest) issue(world, u, "move", { x: dest.x + off.x, z: dest.z + off.z }, look);
      else issue(world, u, "hold", null, look);
    });
    return;
  }

  const moving = ft.boundingLeg === "alpha" ? alpha : bravo;
  const overwatch = ft.boundingLeg === "alpha" ? bravo : alpha;

  if (!ft.boundTarget) {
    ft.boundTarget = pickSupportedBoundTarget(
      world.walls,
      world.coverPoints,
      centroid(moving),
      forward,
      boundMin,
      boundMax,
      centroid(overwatch),
    );
  }
  const dest = ft.boundTarget;

  moving.forEach((u, i) => {
    const off = offsetPerp(i, moving.length, 1.6, forward);
    const look = rotate(forward, ((moving.length === 2 ? (i === 0 ? -25 : 25) : 0) * Math.PI) / 180);
    if (dest) issue(world, u, "move", { x: dest.x + off.x, z: dest.z + off.z }, look);
    else issue(world, u, "hold", null, look);
  });

  if (dest && moving.every((u) => dist(u.pos, dest) < BOUND_ARRIVE + 1.6)) {
    ft.boundingLeg = ft.boundingLeg === "alpha" ? "bravo" : "alpha";
    ft.boundTarget = null; // 次のレグのために再計算させる
  }

  // ドクトリン通り、最低1名は移動側が向かう方向(支援すべき方向)を注視する。
  // 2名いる場合はもう1名が側背面を分担する。
  overwatch.forEach((u, i) => {
    const look = i === 0 ? forward : rotate(forward, (140 * Math.PI) / 180);
    issue(world, u, "hold", null, look);
  });
}

/**
 * 隊列を組んで進む(仕様 §6 の隊形 + §6.5 の集合・追従)。
 *
 * 先頭の1名だけが経路探索で `dest` へ向かい、残りは**リーダーの現在の向きを基準に
 * 毎ティック再計算される隊形位置へ追従する**。隊形Tierは通路幅から自動選択される
 * ので、路地に入れば縦隊に、広場に出れば横隊に、指示なしで切り替わる。
 *
 * 全員へ別々の固定座標を配ると、狭い通路で横に並ぼうとして壁に張り付く。
 * 追従方式なら「リーダーがどこを歩いているか」に隊形が追随する。
 */
function moveInFormation(
  world: World,
  ft: FireteamState,
  members: Soldier[],
  forward: Vec2,
  dest: Vec2,
): void {
  if (members.length === 0) return;
  const leader = members[0]!;
  const followers = members.slice(1);

  issue(world, leader, "move", dest, forward);

  const slots = formationSlots(world.walls, leader.pos, forward, members.length, {
    contacts: ft.memory.values(),
    coverPoints: world.coverPoints,
    coverPref: world.posture[ft.side].coverPref,
  });
  // 隊形Tierによる速度差(仕様 §6: 縦隊が最速、横隊が最遅)は隊全体に掛ける。
  // リーダーだけ速いと隊列が伸びきってしまう。
  const speedMul = slots[0]?.speedMul ?? 1;
  leader.speedMul = speedMul;

  followers.forEach((u, i) => {
    const slot = slots[i + 1];
    if (!slot) return;
    // 監視方向は隊形内の位置で分担する(仕様 §6「視界カバー範囲は定性的なルールベース」)
    const look = rotate(forward, (((i % 2 === 0 ? -35 : 35) + (i >= 2 ? 90 : 0)) * Math.PI) / 180);
    issue(world, u, "follow", slot.pos, look);
    u.speedMul = speedMul;
  });
}

/**
 * 前進(Traveling、仕様 §6): 接敵の可能性が低く速度優先。
 * 隊列を保ったまま全員が連続移動する。警戒要員を割かないぶん最も速い。
 */
function runTraveling(world: World, ft: FireteamState, members: Soldier[], forward: Vec2): void {
  moveInFormation(world, ft, members, forward, ft.objective);
}

/**
 * 警戒前進(Traveling Overwatch、仕様 §6): 接敵の可能性あり。
 * 先頭組が前進し、後続組は射撃準備を保って一定距離を空けて追従する。
 * 躍進前進と違い後続組も止まらないため、速度と警戒の中間になる。
 */
function runTravelingOverwatch(
  world: World,
  ft: FireteamState,
  alpha: Soldier[],
  bravo: Soldier[],
  forward: Vec2,
): void {
  const members = [...alpha, ...bravo];
  if (members.length === 0) return;
  if (alpha.length === 0 || bravo.length === 0) {
    runTraveling(world, ft, members, forward);
    return;
  }

  const dest = ft.objective;
  /** 先頭組と後続組の間隔(m)。相互支援が届く範囲に収める */
  const TRAIL_GAP = 8;

  // 先頭組は隊形を組んで目標へ、後続組は一定距離を空けて同じ軸を進む。
  // どちらの組も内部では通路幅に応じた隊形(仕様 §6)を保つ。
  moveInFormation(world, ft, alpha, forward, dest);
  moveInFormation(world, ft, bravo, forward, {
    x: dest.x - forward.x * TRAIL_GAP,
    z: dest.z - forward.z * TRAIL_GAP,
  });
}

/** 分隊長から指示された移動技術(仕様 §6)に従って前進する。 */
function runAdvance(
  world: World,
  ft: FireteamState,
  alpha: Soldier[],
  bravo: Soldier[],
  forward: Vec2,
  /** 躍進歩幅・最小/最大への乗数(`[v6.1]` 陣営別性格。既定 1 で現行値) */
  boundMinMul = 1,
  boundMaxMul = 1,
): void {
  switch (ft.technique) {
    case "traveling":
      runTraveling(world, ft, [...alpha, ...bravo], forward);
      return;
    case "traveling_overwatch":
      runTravelingOverwatch(world, ft, alpha, bravo, forward);
      return;
    case "bounding_overwatch":
      runBoundingOverwatch(world, ft, alpha, bravo, forward, boundMinMul, boundMaxMul);
      return;
  }
}

/** 兵士の目的地を決める。ばたつき防止の保持時間を尊重する。 */
function cachedDest(
  world: World,
  ft: FireteamState,
  u: Soldier,
  compute: () => Vec2 | null,
): Vec2 | null {
  const cur = ft.unitDest.get(u.id);
  const since = ft.unitDestSince.get(u.id) ?? -Infinity;
  const stale = world.tick - since >= DEST_HOLD_TICKS;
  if (!cur || (dist(u.pos, cur) < DEST_ARRIVE && stale)) {
    const p = compute();
    if (p) {
      ft.unitDest.set(u.id, p);
      ft.unitDestSince.set(u.id, world.tick);
      return p;
    }
  }
  return cur ?? null;
}

export function fireteamAI(world: World): void {
  for (const ft of world.fireteams) {
    const members = world.soldiers.filter(
      (s) => s.side === ft.side && s.squadId === ft.squadId && s.fireteamId === ft.ftIndex,
    );
    const living = members.filter((s) => s.status === "ok");

    // world picture の更新は操作中でも必ず走らせる。人間が操作していても、
    // そのFTが「何を見ているか」は変わらないため(仕様 §4: 能力を追加しない)。
    updateMemory(world, ft, living);
    if (living.length === 0) continue;

    // 人間がこのFTリーダーを操作しているなら、AIの命令発行は行わない(仕様 §4)
    const ftLeader = living.find((s) => s.isFireteamLeader);
    if (ftLeader && aiSuppressed(world, "fireteam", ft.side, ftLeader.id)) continue;

    if (world.tick % DECIDE_EVERY_TICKS !== 0) continue;

    // 陣営別の性格パラメータ(`[v6.1]`)。既定では乗数1・絶対値は定数と一致する。
    const pos = world.posture[ft.side];
    const engageMin = ENGAGE_MIN * pos.engageMinMul;
    const engageMax = ENGAGE_MAX * pos.engageMaxMul;
    const fallbackDeficit = pos.fallbackDeficit;

    const contacts = [...ft.memory.values()];
    const squadStrength = world.soldiers.filter(
      (s) => s.side === ft.side && s.squadId === ft.squadId && s.status === "ok",
    ).length;

    // `[v6.1]` FALLBACK 判定用の材料。全メモリ件数ではなく「いま撃ち合える敵」と
    // 「実際に押されているか」で測る(前線オシレーションの対処)。
    const ftCenter = centroid(living);
    const nearBand = engageMax * NEAR_THREAT_RANGE_MUL;
    let nearThreats = 0;
    for (const c of contacts) {
      if (c.confidence < NEAR_THREAT_CONF) continue;
      if (dist(c.pos, ftCenter) > nearBand) continue;
      nearThreats += 1;
    }
    const pinned = living.some(
      (u) => u.suppressedUntilTick > world.tick || u.evadeUntilTick > world.tick,
    );

    // 崩壊/後退の判定(仕様 §12)。戦死者を除いた「まだ戦場にいる隊員」で見る
    const onField = members.filter((s) => s.status !== "kia" && !isOffField(s));
    const prevRouted = ft.routedSinceTick !== null;
    const routed = evaluateMorale(world, ft, onField);
    if (routed && ft.routedSinceTick === null) ft.routedSinceTick = world.tick;
    if (!routed) ft.routedSinceTick = null;
    for (const u of members) {
      // プレイヤーが直接操作している兵士は潰走を拒否できる(仕様 §12)。
      // 「操作中の1人だけ踏みとどまり、周囲は崩れる」状況が起こり得る
      u.routed = routed && !aiSuppressed(world, "soldier", u.side, u.id);
    }

    const prevMode = ft.mode;
    const next = selectMode(
      ft,
      squadStrength,
      living.length,
      contacts,
      routed,
      fallbackDeficit,
      nearThreats,
      pinned,
    );
    if (next !== ft.mode) {
      // FALLBACK / ROUT への遷移は最小滞留時間を無視する(「判断」ではなく崩れた事実への反応)。
      // ただし `[v6.1]` FALLBACK から**復帰する**ときは長めに落ち着かせる — 短い滞留だと
      // 前進 → 再接敵 → 再後退 のポンプ運動が止まらない(初回テストプレイ指摘)。
      const dwell = prevMode === "FALLBACK" ? MODE_DWELL_TICKS * 3 : MODE_DWELL_TICKS;
      if (next === "FALLBACK" || next === "ROUT" || world.tick - ft.modeSince >= dwell) {
        ft.mode = next;
        ft.modeSince = world.tick;
      }
    }
    // `[v6.1]` ROUT から立て直した直後は、いきなり前進へ戻さず**再編成のひと呼吸**を挟む
    // (指摘: 士気崩壊の回復を明確に)。FALLBACK 相当 = 直近の脅威から離れて遮蔽で立て直す
    // 短い動き + 復帰まで 3.6 秒の滞留。回復自体は「未処置WIAが50%を下回った」ときにしか
    // 起きないので、衛生の追いつき → 再編成 → 前線復帰、という段取りになる。
    if (prevRouted && !routed && ft.mode !== "ROUT" && ft.mode !== "CQB") {
      ft.mode = "FALLBACK";
      ft.modeSince = world.tick;
    }
    if (prevMode !== ft.mode) {
      ft.boundTarget = null;
      ft.unitDest.clear();
      ft.unitDestSince.clear();
      if (ft.mode === "CQB") ft.cqbStageSince = world.tick;
      // CQBから抜けたら突入状態も畳む(FALLBACKへ落ちた場合など)
      if (prevMode === "CQB") exitCqb(ft);
      if (ft.mode === "SEARCH") {
        const freshest = contacts.reduce<Contact | null>(
          (a, c) => (!a || c.lastSeenTick > a.lastSeenTick ? c : a),
          null,
        );
        ft.searchPoint = freshest ? { ...freshest.pos } : ft.objective;
      }
    }

    // FT内のバディペア(モック: i<2 が alpha、それ以外が bravo)
    const alpha = living.filter((_, i) => i < Math.ceil(living.length / 2));
    const bravo = living.filter((_, i) => i >= Math.ceil(living.length / 2));
    const mc = centroid(living);

    // 協調一斉射の火力溜め(F-6)は CONTACT の中だけで管理する。他モードでは古い hold を消す。
    if (ft.mode !== "CONTACT") for (const u of living) u.holdFireUntilTick = 0;

    if (ft.mode === "ROUT") {
      // 潰走(仕様 §12): 隊形も役割も崩れ、各自が集結地点へ走る。
      // 潰走を拒否した(=操作中の)兵士だけは、この命令の対象から外れる
      const freshest = contacts.reduce<Contact | null>(
        (a, c) => (!a || c.lastSeenTick > a.lastSeenTick ? c : a),
        null,
      );
      for (const u of living) {
        if (!u.routed) continue;
        const look = freshest ? dirTo(u.pos, freshest.pos) : ft.advanceDir;
        issue(world, u, "retreat", ft.rallyPoint, look);
      }
    } else if (ft.mode === "CQB") {
      // 突入待機命令の3段階(仕様 §7.3)。命令発行はここと同じ issue を通すので、
      // 応急手当・担架搬送による拘束は室内でもそのまま尊重される
      runCqb(world, ft, living, (u, kind, target, look) => issue(world, u, kind, target, look));
    } else if (ft.mode === "CONTACT") {
      // 交戦で狙う相手は「いま実際に撃ち合える近さ」を優先する。選抜射手が遠方
      // (最大300m)の敵を報告してくるので、素の確度順だと FT 全体が遠くの1点へ
      // 引きずられて足元の戦闘を放棄してしまう(仕様 §10 の副作用)。
      const CLOSE_BAND = engageMax * 2;
      const near = contacts.filter((c) => dist(mc, c.pos) <= CLOSE_BAND);
      const pool = near.length > 0 ? near : contacts;
      let primary = pool[0];
      for (const c of pool) {
        if (!primary) primary = c;
        else if (c.confidence > primary.confidence + 0.001) primary = c;
        else if (
          Math.abs(c.confidence - primary.confidence) <= 0.001 &&
          dist(mc, c.pos) < dist(mc, primary.pos)
        ) {
          primary = c;
        }
      }
      if (!primary) {
        runAdvance(world, ft, alpha, bravo, dirTo(mc, ft.objective), pos.boundMinMul, pos.boundMaxMul);
        continue;
      }
      const enemy = primary.pos;

      // 分隊長からFT単位の役割(base / maneuver)が下りている場合、FT内の2ペアは
      // 分割せず全員でその役割に専念する。分隊長が健在で指示を出せている状況では、
      // 火力と機動の分割は分隊長の責務(仕様 §6)であってFTの裁量ではない。
      let base: Soldier[];
      let maneuver: Soldier[];
      if (ft.assignedRole === "base") {
        base = living;
        maneuver = [];
      } else if (ft.assignedRole === "maneuver") {
        base = [];
        maneuver = living;
      } else {
        // 指示がない(分隊長不在・未接敵扱い)場合はFT内で自律的に分割する。
        // すでに敵を視認できている側のペアがベース・オブ・ファイアを担当する
        const alphaLOS = alpha.some((u) =>
          hasLineOfSightIndexed(world.wallIndex, u.pos.x, u.pos.z, enemy.x, enemy.z),
        );
        const bravoLOS = bravo.some((u) =>
          hasLineOfSightIndexed(world.wallIndex, u.pos.x, u.pos.z, enemy.x, enemy.z),
        );
        if (alphaLOS && !bravoLOS) {
          base = alpha;
          maneuver = bravo;
        } else if (bravoLOS && !alphaLOS) {
          base = bravo;
          maneuver = alpha;
        } else {
          base = ft.baseElement === "bravo" ? bravo : alpha;
          maneuver = base === alpha ? bravo : alpha;
        }
        ft.baseElement = base === alpha ? "alpha" : "bravo";
      }

      // 接敵反応ドクトリン(F-6, 仕様 §6 `[v6.1]`)。
      // ベース組は常に即応射撃。deliberate な溜めが許されるのは「FT内の誰も敵の視界に
      // 入っておらず、まだ撃たれてもいない」機動組が側面へ回り込む間だけ。
      const ftDetected =
        living.some((u) => u.observedByEnemy) ||
        living.some((u) => u.suppressedUntilTick > world.tick) ||
        world.tick - ft.modeSince > Math.round(CONTACT_DRILL.VOLLEY_MAX_SEC * SIM_HZ);
      const volleyHold = Math.round(CONTACT_DRILL.VOLLEY_SETUP_SEC * SIM_HZ);
      const assaultTicks = Math.round(CONTACT_DRILL.ASSAULT_SEC * SIM_HZ);

      for (const u of base) {
        u.holdFireUntilTick = 0;
        const d = dist(u.pos, enemy);
        const los = hasLineOfSightIndexed(world.wallIndex, u.pos.x, u.pos.z, enemy.x, enemy.z);
        // 選抜射手(仕様 §10): 射線が通っていれば交戦距離帯の外からでもその場で撃つ。
        // FT AI に「距離を詰めろ」と言われて長射程の利を捨てないため。
        const dmEngageFromRange = u.quals.designatedMarksman && los && d <= DM_DETECT_RANGE;
        // 機関銃(`[v6.1]` §2): 交戦距離帯を広く取り、据えて長めの距離を制圧する。
        const eMax = engageMax * (u.role === "mg" ? MG.ENGAGE_RANGE_MUL : 1);
        const inPosition = (los && d >= engageMin - 2 && d <= eMax + 2) || dmEngageFromRange;
        if (inPosition) {
          // `[v6.2]` 撃てる位置にいても**開豁地に突っ立ったままにはしない**。
          // 射線と交戦距離を保ったまま、すぐ隣の遮蔽(壁際・建物の角)へ身を寄せる
          // (仕様 §6。2回目のテストプレイ指摘「敵を見つけたら即座にカバーを探す」)。
          // 露出判定は「近くに壁があるか」の1問い合わせで済ませる。`coverBonus` は
          // 全壁走査なので、交戦中の全兵士ぶん毎周期呼ぶと市街地マップで破綻する
          const sheltered = collidesWallIndexed(
            world.wallIndex,
            u.pos.x,
            u.pos.z,
            // `[v6.2]` OQ-6: この半径内に壁があれば「遮蔽が取れている」とみなす。
            // 慎重な兵ほど**半径を小さく**取る = より壁に密着していないと納得せず、
            // 結果として早めに遮蔽へ寄る。t=0.5 で倍率1.0(=定数どおり)。
            COVER_SEEK.IN_COVER_DIST * traitMul(1 - u.traits.caution, 0.4),
          );
          const shelter = sheltered
            ? null
            : cachedDest(world, ft, u, () =>
                bestNearbyCover(
                  world.wallIndex,
                  world.coverPoints,
                  u.pos,
                  enemy,
                  engageMin,
                  eMax,
                  COVER_SEEK.MAX_MOVE,
                  COVER_SEEK.TARGET_COVER,
                  COVER_SEEK.MAX_YIELD,
                ),
              );
          if (shelter) {
            // 移動中も撃ち続ける。制圧を切らすと §8 の交戦で不利になる(AD-28)
            issue(world, u, "suppress", shelter, dirTo(u.pos, enemy));
          } else {
            ft.unitDest.delete(u.id);
            issue(world, u, "suppress", null, dirTo(u.pos, enemy));
          }
        } else {
          const p = cachedDest(world, ft, u, () =>
            bestCoverPoint(world.walls, world.coverPoints, u.pos, enemy, engageMin, engageMax),
          );
          if (p) {
            issue(world, u, "suppress", p, dirTo(u.pos, enemy));
          } else {
            // 射撃位置の候補が見つからない = いまいる場所からは敵を撃てない。
            // その場に留まると射線も通らないまま永久に硬直するため、交戦距離帯の
            // 外縁まで詰めて射線を回復しにいく。
            const toEnemy = dirTo(u.pos, enemy);
            issue(
              world,
              u,
              "maneuver",
              { x: enemy.x - toEnemy.x * engageMax, z: enemy.z - toEnemy.z * engageMax },
              toEnemy,
            );
          }
        }
      }

      const baseCentroid = centroid(base);
      // FT単位で決まる事柄(躍進の歩幅、押し出しの早さ)には隊員の平均を使う
      const ftTraits = meanTraits(living);
      // `[v6.2]` 突撃の継続(F-10 (a))。接敵が続いていて、かつ自分たちが釘付けに
      // されていなければ、機動組は側面確保をやめて**任務目標へ躍進を継続**する。
      // これが無いと接敵した部隊は敵のまわりを回るだけで目標へ一歩も近づかない。
      // 判定に使うのは自軍の状態だけ — 敵の制圧状態を覗くのは §5 の情報階層の迂回になる。
      const pinnedNow = living.some(
        (u) => u.suppressedUntilTick > world.tick || u.evadeUntilTick > world.tick,
      );
      const pushing =
        !pinnedNow &&
        world.tick - ft.modeSince >
          Math.round(
            CONTACT_DRILL.PUSH_AFTER_SEC *
              SIM_HZ *
              traitMul(1 - ftTraits.aggressiveness, 0.35),
          ) &&
        dist(mc, ft.objective) > engageMax;
      for (const u of maneuver) {
        const p = pushing
          ? // 目標へ向けた躍進。オーバーウォッチ(ベース組)の支援内に留まる(仕様 §6)
            cachedDest(world, ft, u, () =>
              pickSupportedBoundTarget(
                world.walls,
                world.coverPoints,
                u.pos,
                dirTo(u.pos, ft.objective),
                // `[v6.2]` OQ-6: 大胆なFTほど一度の躍進で長く出る
                BOUND_MIN_ADV * pos.boundMinMul,
                BOUND_MAX_ADV * pos.boundMaxMul * traitMul(ftTraits.boldness, 0.35),
                baseCentroid,
              ),
            )
          : cachedDest(world, ft, u, () =>
              bestFlankPoint(
                world.coverPoints,
                u.pos,
                enemy,
                baseCentroid,
                engageMin,
                engageMax,
                ft.objective,
              ),
            );
        const fallback = { x: u.pos.x + (enemy.x - u.pos.x) * 0.2, z: u.pos.z + (enemy.z - u.pos.z) * 0.2 };
        issue(world, u, "maneuver", p ?? fallback, dirTo(u.pos, enemy));

        // 突撃フェーズ(A): 近接まで詰めたら数秒 ASSAULT 状態(命中率上昇)
        const dToEnemy = dist(u.pos, enemy);
        // `[v6.2]` OQ-6: 積極的な兵ほど遠めから突撃へ踏み切る
        if (dToEnemy <= CONTACT_DRILL.ASSAULT_RANGE * traitMul(u.traits.aggressiveness, 0.35)) {
          u.assaultingUntilTick = world.tick + assaultTicks;
        }
        // 協調一斉射(B): 未発見のまま側面位置へ向かっている間だけ発砲を控える。
        // 就いた(経路終了)/ 見つかった / 突撃に入った瞬間に開く。
        const stalking =
          !ftDetected &&
          !u.observedByEnemy &&
          u.assaultingUntilTick <= world.tick &&
          u.pathIdx < u.path.length;
        u.holdFireUntilTick = stalking ? world.tick + volleyHold : 0;
      }
    } else if (ft.mode === "FALLBACK") {
      // `[v6.1]` break contact は集結地点までの全面後退ではなく、直近の脅威から離れる向きへ
      // 短く1回下がって遮蔽に入るだけ。前線そのものは放棄しない(全面後退は ROUT のみ)。
      const freshest = contacts.reduce<Contact | null>(
        (a, c) => (!a || c.lastSeenTick > a.lastSeenTick ? c : a),
        null,
      );
      const away = freshest
        ? dirTo(freshest.pos, mc)
        : { x: -ft.advanceDir.x, z: -ft.advanceDir.z };
      if (!ft.boundTarget) {
        ft.boundTarget =
          nearestCoverTowards(world.walls, world.coverPoints, mc, away, 6, BREAK_DIST + 6) ?? {
            x: mc.x + away.x * BREAK_DIST,
            z: mc.z + away.z * BREAK_DIST,
          };
      }
      const dest = ft.boundTarget;
      living.forEach((u, i) => {
        const off = offsetPerp(i, living.length, 1.8, ft.advanceDir);
        // 下がりながらも脅威の方を警戒し続ける(背中を見せて棒立ちで走らない)
        const look = freshest ? dirTo(u.pos, freshest.pos) : ft.advanceDir;
        issue(world, u, "retreat", { x: dest.x + off.x, z: dest.z + off.z }, look);
      });
      // 全員が下がり切ったら目的地を捨て、次の判断周期で改めて評価させる
      if (living.every((u) => dist(u.pos, dest) < 3)) ft.boundTarget = null;
    } else if (ft.mode === "SEARCH") {
      // 最終接敵位置へ向けて掃討する。見失った直後は危険度が高いので、
      // 小隊長の指示に関係なく躍進前進で慎重に進む。
      const aim = ft.searchPoint ?? ft.objective;
      if (ft.searchPoint && dist(mc, ft.searchPoint) < 3) {
        // 最終目撃地点まで掃討して何も見つからなければ、前進を再開する
        ft.searchPoint = null;
        ft.memory.clear();
      }
      runBoundingOverwatch(world, ft, alpha, bravo, dirTo(mc, aim), pos.boundMinMul, pos.boundMaxMul);
    } else {
      // ADVANCE — 分隊長(ひいては小隊長)が指示した移動技術で任務目標へ向かう(仕様 §6)
      runAdvance(world, ft, alpha, bravo, dirTo(mc, ft.objective), pos.boundMinMul, pos.boundMaxMul);
    }

    // 制圧が誘発した回避行動(仕様 §14)は、モードごとの命令より優先する。
    // 遮蔽へ飛び込む動作は指揮判断ではなく反射なので、命令系統の外側に置く。
    // SAW手の制圧はこの誘発率が1.5倍で、そこがSAWの戦術的な値打ちになる。
    //
    // ただし**室内クリアリング中は適用しない**(仕様 §7.3 は CQB を専用モードとして
    // 他と切り分けている)。突入の最中に反射的に後退すると、扉の前で出たり入ったりして
    // ドリルが永久に完了しなくなる。狭所では前へ抜けるのがドクトリンでもある。
    if (ft.mode === "CQB") continue;

    const threatPos = contacts.reduce<Contact | null>(
      (a, c) => (!a || c.confidence > a.confidence ? c : a),
      null,
    )?.pos;
    for (const u of living) {
      if (u.evadeUntilTick <= world.tick) continue;
      const away = threatPos
        ? { x: u.pos.x - threatPos.x, z: u.pos.z - threatPos.z }
        : { x: -ft.advanceDir.x, z: -ft.advanceDir.z };
      const d = Math.hypot(away.x, away.z) || 1;
      const dir = { x: away.x / d, z: away.z / d };
      const dest =
        nearestCoverTowards(world.walls, world.coverPoints, u.pos, dir, 1, EVADE_DIST) ??
        { x: u.pos.x + dir.x * EVADE_DIST, z: u.pos.z + dir.z * EVADE_DIST };
      const look = threatPos ? dirTo(u.pos, threatPos) : ft.advanceDir;
      issue(world, u, "evade", dest, look);
    }
  }
}
