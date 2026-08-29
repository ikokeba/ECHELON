/**
 * Zustand ストア — シム状態のReact側ミラーであり、UIの意図(ポーズ/速度/ステップ/選択)を
 * 記録する場所。ランタイムループが毎フレームここから意図を読み、小さなHUDスナップショットを
 * 書き戻す。**毎ティックのシミュレーションデータは決してここに置かない**
 * (design §2、およびモックの「React stateはHUD専用」規則)。
 */

import { create } from "zustand";
import { SPEED_STEPS } from "@sim/constants.ts";
import type { ScenarioKey } from "@sim/scenario.ts";
import type { Side } from "@sim/types.ts";
import type { ControlState } from "@sim/control.ts";

/** 階層ツリーUIが表示する編成の一覧。毎フレームではなく編成が変わったときだけ更新する。 */
export interface RosterSquad {
  squadId: number;
  effective: number;
  total: number;
  /** 指揮継承直後で判断が鈍っている(仕様 §12) */
  degraded: boolean;
}

export interface RosterPlatoon {
  side: Side;
  platoonId: number;
  effective: number;
  total: number;
  /** 指揮継承直後で判断が鈍っている(仕様 §12) */
  degraded: boolean;
  squads: RosterSquad[];
}

export interface RosterCompany {
  side: Side;
  companyId: number;
  effective: number;
  total: number;
  degraded: boolean;
  /** 出払っている後送アセットの台数 / 総数(仕様 §9) */
  assetsBusy: number;
  assetsTotal: number;
  platoons: RosterPlatoon[];
}

/**
 * プレイヤーがいま「どの立場で戦場を見ているか」。
 *
 * 仕様 §5 の中核: 描画は選択した階層の world picture(belief)に基づいて行う。
 * 神視点(ground truth)は開発用のデバッグ表示としてのみ残す。
 */
export type ViewEchelon = "company" | "platoon" | "squad" | "truth";

export interface HudSnapshot {
  tick: number;
  simSeconds: number;
  blueAlive: number;
  redAlive: number;
  blueEffective: number;
  redEffective: number;
  /** 現在の視点階層が把握している敵接触の件数 */
  knownContacts: number;
  /** そのうち確度0まで落ちた「最終目撃情報」の件数 */
  staleContacts: number;
  /** CCPまで後送を完了した人数(仕様 §9)。生存者としてカウントされる */
  blueEvacuated: number;
  redEvacuated: number;
  /** 戦場に倒れたまま後送を待っている人数 */
  blueAwaitingEvac: number;
  redAwaitingEvac: number;
}

interface UiState extends HudSnapshot {
  paused: boolean;
  /** 非ポーズ時の速度を指す SPEED_STEPS のindex */
  speedIdx: number;
  /** ポーズ中に1ステップ実行を要求するためのカウンタ */
  stepNonce: number;
  selectedSoldierId: number | null;

  /** どの陣営の立場で見るか */
  viewSide: Side;
  /** どの階層の world picture を見るか */
  viewEchelon: ViewEchelon;
  /** viewEchelon === "squad" のときに覗く分隊 */
  viewSquadId: number | null;
  /** viewEchelon === "platoon" のときに覗く小隊 */
  viewPlatoonId: number | null;

  /** 実行中のシナリオ。変えるとランタイムごと作り直される */
  scenarioKey: ScenarioKey;

  /** 人間が操作中のノード(仕様 §4)。null なら観戦 */
  control: ControlState | null;
  /** 階層ツリー表示用の編成一覧 */
  roster: RosterCompany[];

  togglePause: () => void;
  cycleSpeed: () => void;
  requestStep: () => void;
  select: (id: number | null) => void;
  setViewSide: (side: Side) => void;
  setViewEchelon: (e: ViewEchelon) => void;
  setViewSquadId: (id: number | null) => void;
  setViewPlatoonId: (id: number | null) => void;
  setScenario: (k: ScenarioKey) => void;
  /** ホットスワップ要求。ランタイムが次フレームでシムへ反映する */
  requestSwap: (c: ControlState | null) => void;
  setRoster: (r: RosterCompany[]) => void;
  pushHud: (snap: HudSnapshot) => void;
}

/** 実行中の速度のみ(SPEED_STEPS[0] の 0 を除く) */
export const RUN_SPEEDS = SPEED_STEPS.filter((s) => s > 0);

export const useSimStore = create<UiState>((set) => ({
  tick: 0,
  simSeconds: 0,
  blueAlive: 0,
  redAlive: 0,
  blueEffective: 0,
  redEffective: 0,
  knownContacts: 0,
  staleContacts: 0,
  blueEvacuated: 0,
  redEvacuated: 0,
  blueAwaitingEvac: 0,
  redAwaitingEvac: 0,

  paused: false,
  speedIdx: RUN_SPEEDS.indexOf(1) >= 0 ? RUN_SPEEDS.indexOf(1) : 0,
  stepNonce: 0,
  selectedSoldierId: null,

  viewSide: "blue",
  viewEchelon: "platoon",
  viewSquadId: null,
  viewPlatoonId: null,
  scenarioKey: "platoon",
  control: null,
  roster: [],

  togglePause: () => set((s) => ({ paused: !s.paused })),
  cycleSpeed: () => set((s) => ({ speedIdx: (s.speedIdx + 1) % RUN_SPEEDS.length })),
  requestStep: () => set((s) => ({ stepNonce: s.stepNonce + 1 })),
  select: (id) => set({ selectedSoldierId: id }),
  setViewSide: (side) => set({ viewSide: side }),
  setViewEchelon: (e) => set({ viewEchelon: e }),
  setViewSquadId: (id) => set({ viewSquadId: id }),
  setViewPlatoonId: (id) => set({ viewPlatoonId: id }),
  /** シナリオを切り替える。世界を作り直すので操作対象と視点も初期化する */
  setScenario: (k) =>
    set({ scenarioKey: k, control: null, viewSquadId: null, viewPlatoonId: null }),
  /**
   * ホットスワップ。操作対象を変えると視点も自動でその階層へ合わせる —
   * 仕様 §5 のとおり、操作している階層が知り得る情報だけが見えるべきなので、
   * 「小隊長を操作しながら分隊長の視界で見る」ことは許さない。
   */
  requestSwap: (c) =>
    set(
      c === null
        ? { control: null }
        : {
            control: c,
            viewSide: c.side,
            viewEchelon:
              c.echelon === "company"
                ? "company"
                : c.echelon === "platoon"
                  ? "platoon"
                  : "squad",
            viewSquadId: c.echelon === "squad" ? c.unitId : null,
            viewPlatoonId: c.echelon === "platoon" ? c.unitId : null,
          },
    ),
  setRoster: (r) => set({ roster: r }),
  pushHud: (snap) => set(snap),
}));

/** 現在の実効時間倍率(ポーズ中は0)。 */
export function currentSpeed(s: Pick<UiState, "paused" | "speedIdx">): number {
  return s.paused ? 0 : (RUN_SPEEDS[s.speedIdx] ?? 1);
}
