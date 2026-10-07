/**
 * 初期条件コード(`[v6.18]`)。
 *
 * **1回の戦闘の入力を1本の短い文字列にまとめ、貼れば同じ盤面が再現できるようにする。**
 * Minecraft のワールドシードと同じ役目だが、こちらは種1つでは足りない — 盤面・乱数種に
 * 加えて、陣営ごとの編成・ドクトリン・リスク許容度・共通パラメータ・配置プランまでが
 * 揃って初めて同じ戦闘になる。したがって「シード」ではなく**初期条件そのもの**を畳む。
 *
 * ── 何が再現されるか ──
 *
 * `src/sim` は決定論的(`Math.random`/`Date.now` は lint で禁止、乱数は陣営ごとの
 * seeded ストリーム1本)なので、**同じ初期条件なら第Nティックの状態は必ず同じ**。
 * ティックの進み方は固定タイムステップの累積器なので、機械の速さもフレームレートも
 * 結果を変えない — 遅い端末は同じ列を遅く辿るだけ。
 *
 * **再現されないもの**は、初期条件ではないもの:
 *   - 人間の操作(ホットスワップ、移動命令)。これは入力であって初期条件ではない
 *   - 戦闘の**最中**にデバッグスライダーを動かすこと。動かした瞬間から別の戦闘になる
 *
 * ── 形式 ──
 *
 * `ECH1-<payload>-<checksum>`
 *
 *   payload   既定と違う項目だけを短いキーの JSON にして base64url 化したもの。
 *             既定のままの盤面なら 30文字ほどに収まる
 *   checksum  payload の FNV-1a を base36 4桁。**打ち間違いを弾くためだけ**の
 *             もので、暗号的な意味は無い
 *
 * ── 量子化について ──
 *
 * 座標は 0.01m、係数は 0.001 に丸めて畳む。丸めた値は復元時にそのまま使われるので、
 * **`encode` は「この初期条件はこう畳まれる」という正規化そのもの**でもある。
 * `normalizeSetup` を通した状態から作ったコードは、復元しても同じコードになる
 * (テストで固定している)。丸め幅は 5mm / 0.0005 で、盤面の見た目には現れない。
 */

import { playForce, type ForceSpec } from "./force.ts";
import type { DeploymentPlan } from "./deployment.ts";
import type { Side, Vec2 } from "./types.ts";

/** コードの版。形式を変えたら上げる(古いコードは復元を拒否する) */
const CODE_VERSION = "ECH1";

/** 座標の丸め幅 m と、係数の丸め幅。 */
const POS_STEP = 0.01;
const COEF_STEP = 0.001;

/** 共通パラメータ(デバッグスライダー)の実行時値。UI の `TuningUi` と同じ形。 */
export interface SetupTuning {
  detectRange: number;
  fovDeg: number;
  fireAlignDeg: number;
  moveSpeed: number;
  turnRateDeg: number;
}

/** 1回の戦闘の初期条件。ここに無いものは結果に影響しない(あるいは人間の入力)。 */
export interface BattleSetup {
  /** 盤面 */
  scenario: string;
  /** 乱数種。両陣営に同じ値が入る(仕様 §2/§13) */
  seed: number;
  force: Record<Side, ForceSpec>;
  doctrine: Record<Side, string>;
  /** 陣営別リスク許容度 0..1(`[v6.1]`) */
  risk: Record<Side, number>;
  tuning: SetupTuning;
  /** 配置プラン。null なら盤面の既定をそのまま使う */
  deployment: DeploymentPlan | null;
}

/** 既定の初期条件。コードは**こことの差分だけ**を持つ。 */
export function defaultSetup(scenario: string, tuning: SetupTuning): BattleSetup {
  return {
    scenario,
    seed: 1,
    force: playForce(),
    doctrine: { blue: "regular", red: "regular" },
    risk: { blue: 0.5, red: 0.5 },
    tuning: { ...tuning },
    deployment: null,
  };
}

function q(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function qVec(v: Vec2): Vec2 {
  return { x: q(v.x, POS_STEP), z: q(v.z, POS_STEP) };
}

/**
 * 初期条件を「コードで表せる精度」へ丸める。
 *
 * `encode` が内部で必ず通すので、**画面の状態をこれに通してから戦闘を作れば、
 * 出したコードと実際に走る戦闘が厳密に一致する**。通さないと 5mm ぶんずれた戦闘を
 * 走らせながら、丸めたコードを配ることになる。
 */
export function normalizeSetup(s: BattleSetup): BattleSetup {
  const sides: Side[] = ["blue", "red"];
  const risk = {} as Record<Side, number>;
  for (const side of sides) risk[side] = q(s.risk[side], COEF_STEP);
  return {
    scenario: s.scenario,
    seed: Math.round(s.seed),
    force: { blue: { ...s.force.blue }, red: { ...s.force.red } },
    doctrine: { ...s.doctrine },
    risk,
    tuning: quantizeTuning(s.tuning),
    deployment: s.deployment ? quantizeDeployment(s.deployment) : null,
  };
}

/** 係数(スライダー由来の値)を、コードが運べる精度へ丸める。 */
export function quantizeRisk(v: number): number {
  return q(v, COEF_STEP);
}

/** 共通パラメータを、コードが運べる精度へ丸める。 */
export function quantizeTuning(t: SetupTuning): SetupTuning {
  return {
    detectRange: q(t.detectRange, COEF_STEP),
    fovDeg: q(t.fovDeg, COEF_STEP),
    fireAlignDeg: q(t.fireAlignDeg, COEF_STEP),
    moveSpeed: q(t.moveSpeed, COEF_STEP),
    turnRateDeg: q(t.turnRateDeg, COEF_STEP),
  };
}

/** 配置プランを、コードが運べる精度(座標 0.01m)へ丸める。 */
export function quantizeDeployment(d: DeploymentPlan): DeploymentPlan {
  const spawn: DeploymentPlan["spawn"] = {};
  for (const side of ["blue", "red"] as Side[]) {
    const sp = d.spawn[side];
    if (sp) spawn[side] = { pos: qVec(sp.pos), facing: qVec(sp.facing) };
  }
  return {
    spawn,
    objectives:
      d.objectives?.map((o) => ({
        label: o.label,
        pos: qVec(o.pos),
        radius: q(o.radius, POS_STEP),
      })) ?? null,
    ...(d.mode !== undefined ? { mode: d.mode } : {}),
    ...(d.attacker !== undefined ? { attacker: d.attacker } : {}),
    ...(d.timeLimitSec !== undefined ? { timeLimitSec: Math.round(d.timeLimitSec) } : {}),
  };
}

// ── base64url(Node にも browser にも同じ実装で載せる。どちらの API にも寄らない)──

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toB64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

function fromB64url(s: string): Uint8Array | null {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** FNV-1a 32bit。打ち間違いを弾くためだけのもの。 */
function checksum(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(4, "0").slice(-4);
}

/** 既定と違うときだけ値を残す。 */
function diff<T>(value: T, base: T): T | undefined {
  return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
}

/**
 * 初期条件をコードへ畳む。**既定との差分だけ**を持つので、素の盤面なら短い。
 *
 * @param tuningDefault 差分の基準になる共通パラメータの既定値
 */
export function encodeSetup(setup: BattleSetup, tuningDefault: SetupTuning): string {
  const s = normalizeSetup(setup);
  const base = defaultSetup(s.scenario, tuningDefault);
  const body: Record<string, unknown> = { s: s.scenario };
  const put = (k: string, v: unknown): void => {
    if (v !== undefined) body[k] = v;
  };
  put("d", diff(s.seed, base.seed));
  put("f", diff(s.force, base.force));
  put("c", diff(s.doctrine, base.doctrine));
  put("r", diff(s.risk, base.risk));
  put("t", diff(s.tuning, base.tuning));
  put("p", diff(s.deployment, base.deployment));

  const payload = toB64url(enc.encode(JSON.stringify(body)));
  return `${CODE_VERSION}-${payload}-${checksum(payload)}`;
}

/**
 * コードを初期条件へ戻す。読めなければ `null`(理由は問わない — 打ち間違い・
 * 版違い・途中で切れた、のどれでも呼び出し側の対応は同じ)。
 */
export function decodeSetup(code: string, tuningDefault: SetupTuning): BattleSetup | null {
  const parts = code.trim().split("-");
  // payload に `-` が含まれる(base64url の文字集合に入っている)ので、
  // 版とチェックサムを両端から剥がして残りを繋ぎ直す
  if (parts.length < 3) return null;
  const version = parts[0]!;
  const sum = parts[parts.length - 1]!;
  const payload = parts.slice(1, -1).join("-");
  if (version !== CODE_VERSION) return null;
  if (checksum(payload) !== sum) return null;

  const bytes = fromB64url(payload);
  if (!bytes) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(dec.decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof body.s !== "string") return null;

  const base = defaultSetup(body.s, tuningDefault);
  const merged: BattleSetup = {
    scenario: body.s,
    seed: typeof body.d === "number" ? body.d : base.seed,
    force: (body.f as BattleSetup["force"]) ?? base.force,
    doctrine: (body.c as BattleSetup["doctrine"]) ?? base.doctrine,
    risk: (body.r as BattleSetup["risk"]) ?? base.risk,
    tuning: (body.t as SetupTuning) ?? base.tuning,
    deployment: (body.p as DeploymentPlan | undefined) ?? null,
  };
  return normalizeSetup(merged);
}
