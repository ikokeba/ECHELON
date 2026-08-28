/**
 * Every spec / prototype-verified number the simulation depends on, in one
 * place, each tagged with its source. Rule inherited from the prototypes: no
 * spec number is ever hardcoded inline, and none changes here without the spec
 * (or a verified prototype) changing too.
 *
 * Tags:
 *   [spec §N]   — stated in docs/spec/...v5統合マスター版.md, section N
 *   [v5 proto]  — a value the v5 prototype pass confirmed (carries a §ref too)
 *   [mock]      — carried over from a prototype's own tuning; NOT spec-anchored,
 *                 free to retune during integration
 *   [OQ-n]      — blocked on an open question in docs/design/00 §6
 */

// ─────────────────────────────────────────────────────────────────────────────
// Simulation clock
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed simulation tick rate. Render is decoupled and interpolates. [design AD-3] */
export const SIM_HZ = 30;
/** Seconds per simulation tick. */
export const SIM_DT = 1 / SIM_HZ;

/** Selectable time-scale multipliers for the loop (0 = paused). [design AD-6] */
export const SPEED_STEPS = [0, 0.25, 0.5, 1, 2, 4] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Movement (common to both forces — spec §2/§13 symmetry)
// ─────────────────────────────────────────────────────────────────────────────

/** Base ground speed, m/s. [v5 proto — squad-12v12, spec §6] */
export const MOVE_SPEED = 2.6;
/** Turn rate, rad/s. [v5 proto — squad-12v12] */
export const TURN_RATE = Math.PI * 1.3;
/** Soldier collision / spacing radius, m. [mock — squad-12v12 collidesWall default] */
export const SOLDIER_RADIUS = 0.35;
/** Indoor movement speed multiplier on room entry. [spec §7 追補5 — 0.7] */
export const ENTRY_SPEED_MUL = 0.7;
/**
 * Corridor-edge safety clamp, m: a soldier's formation slot is pulled inside the
 * passage boundary by at least this margin. [v5 proto — spec §6 line 145]
 */
export const WALL_SAFETY_CLAMP = 0.45;

// ─────────────────────────────────────────────────────────────────────────────
// Vision & detection (spec §5)
// ─────────────────────────────────────────────────────────────────────────────

/** Half-angle of the soldier's forward view cone, rad (≈100° total). [v5 proto — squad-12v12] */
export const FOV_HALF_RAD = (50 * Math.PI) / 180;
/** Detection range, m. [v5 proto — squad-12v12] */
export const DETECT_RANGE = 20;
/** Aim alignment required to actually fire, rad (±9° off view centre). [v5 proto — squad-12v12] */
export const FIRE_ALIGN_RAD = (9 * Math.PI) / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Report confidence decay (spec §5 — "確定値")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 報告確度の減衰。[spec §5 確定値]
 *   30秒 → 0.80、90秒 → 0.50、180秒 → 0(「消滅」)
 * 減衰のトリガーは時間経過のみで、敵の移動は無関係。最終目撃位置には「?」
 * マーカーが残り、不確度円が時間とともに拡大する。
 *
 * `[v6]` カーブ形状は上記3点を通る連続関数(線形補間)で確定。階段状の離散低下は
 * 採用しない(境界をまたぐ瞬間にAIの判断が急変するため)。確度0は情報の削除では
 * なく、グレーのゴーストとして残置しAIの索敵対象からのみ除外する。
 */
export const CONFIDENCE_POINTS: ReadonlyArray<readonly [ageSec: number, confidence: number]> = [
  [0, 1],
  [30, 0.8],
  [90, 0.5],
  [180, 0],
];
/** Below this confidence a contact is dropped from AI targeting. [mock — squad-12v12 CONFIDENCE_CUTOFF] */
export const CONFIDENCE_CUTOFF = 0.02;
/** Growth rate of a stale contact's position-error circle, m per second of age. [mock] */
export const POS_ERROR_GROWTH = 0.15;

// ─────────────────────────────────────────────────────────────────────────────
// Radio / reporting (spec §5)
// ─────────────────────────────────────────────────────────────────────────────

/** Seconds between a child's routine status reports up the chain. [mock — tune vs platoon-command-report] */
export const REPORT_INTERVAL_SEC = 5;
/** One-hop radio delivery latency, seconds. [mock] */
export const RADIO_LATENCY_SEC = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Combat resolution (spec §8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-second lethal-fire and suppression-trigger rates against a valid,
 * in-LOS target. The mos-balance mock expressed these per 0.2s tick
 * (0.015 and 0.04); divided out to per-second here and re-quantised per tick
 * via rng.ratePerTick(). [mock — mos-balance 6.2, spec §8]
 */
export const HIT_RATE_PER_SEC = 0.015 / 0.2;
export const SUPPRESS_TRIGGER_RATE_PER_SEC = 0.04 / 0.2;
/** Grenadier: per-second attempt rate while charges remain. [mock — mos-balance] */
export const GRENADE_ATTEMPT_RATE_PER_SEC = 0.01 / 0.2;

/** Suppression accuracy penalty, applied as a flat multiplier while suppressed. [spec §8.6 — −40%] */
export const SUPPRESSION_ACC_PENALTY = 0.4;
/** Reduced penalty for the squad's selected marksman. [spec §8.6 [v5] — ≈−10%] */
export const SUPPRESSION_ACC_PENALTY_MARKSMAN = 0.1;
/**
 * Suppression has NO residue: it clears the instant the suppressor stops firing
 * (spec §8.6). Implementation: the combat system re-stamps suppressedUntilTick
 * to (tick + this) every tick suppression is active, so it lapses within one
 * tick of fire ceasing. Not a lingering timer.
 */
export const SUPPRESSION_GRACE_TICKS = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Casualties (spec §9)
// ─────────────────────────────────────────────────────────────────────────────

/** A resolved hit is KIA with this probability, else WIA. [spec §9 — 30% / 70%] */
export const KIA_ON_HIT_CHANCE = 0.3;
/** WIA bleed-out timer, seconds; reaching 0 untreated ⇒ KIA. [spec §9 — 45s] */
export const BLEED_OUT_SEC = 45;
/**
 * A soldier acting as aider abandons suppressing fire for treatment once the
 * casualty's bleed timer drops below this. [v5 proto — casevac-wia, spec §9 — 15s]
 */
export const AID_SWITCH_BLEED_REMAIN_SEC = 15;

/**
 * バディエイド処置時間。[spec §9, §14 `[v6]` 確定]
 *
 * かつて分隊単位3段階モデル(衛生兵4秒/CLS 6秒/未取得8秒)と併記され未決定
 * だったが、編成モデル自体が分隊レベルからFTレベルへ移行済みであることに合わせ、
 * **FT単位MOS 2段階モデルを正式値として確定**した(3段階モデルは破棄)。
 *
 * 注: 3秒は §9 が狙う「戦術的トレードオフ」としては軽い可能性があり、バランス
 * 調整フェーズで延長を検討する。ただしそれは秒数のチューニングであって、
 * モデル構造の変更ではない。
 */
export const BUDDY_AID_SEC = {
  /** 通常の隊員 */
  normal: 3,
  /** MOS「ライフルマン(衛生要員兼任)」 */
  crossTrained: 1.5,
} as const;

/** 応急手当を実行できる負傷者からの距離、m。[spec §9 — 2.0m] */
export const AID_RADIUS = 2.0;

/** 処置中の処置者の露出度上昇(負傷者側は対象外)。[spec §9 — +50%] */
export const AID_EXPOSURE_BONUS = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// CQB (spec §7 追補5)
// ─────────────────────────────────────────────────────────────────────────────

export const CQB = {
  /** stack formation distance from the door, m [spec §7 — 1.5] */
  STACK_DIST: 1.5,
  /** per-soldier corner-clear sector on entry, deg [spec §7 — 90] */
  CORNER_ANGLE_DEG: 90,
  /** single-file entry interval after breach, s/soldier [spec §7 — 0.6] */
  ENTRY_STAGGER_SEC: 0.6,
  /** fine nav-grid resolution inside buildings, m [v5 proto — cqb-minimal] */
  NAV_STEP: 0.3,
  /** nav margin (≈ soldier radius) for the fine grid, m [v5 proto — cqb-minimal] */
  NAV_MARGIN: 0.3,
} as const;

/** Outdoor nav-grid resolution, m. [design §4.2] */
export const NAV_STEP_OUTDOOR = 1.0;
/** Outdoor nav margin, m. [design §4.2] */
export const NAV_MARGIN_OUTDOOR = 0.4;

// ─────────────────────────────────────────────────────────────────────────────
// Command succession / decapitation (spec §12, §13) — placeholder, OQ-4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When a leader is neutralised, subordinate decision cadence is slowed by
 * DEGRADE_FACTOR for DEGRADE_SEC[echelon], recovering linearly. Numbers are
 * placeholders pending OQ-4.
 */
export const DEGRADE_FACTOR = 0.5;
export const DEGRADE_SEC: Record<"squad" | "platoon" | "company", number> = {
  squad: 20,
  platoon: 40,
  company: 80,
};
