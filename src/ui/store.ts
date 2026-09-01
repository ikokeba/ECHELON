/**
 * Zustand ストア — シム状態のReact側ミラーであり、UIの意図(ポーズ/速度/ステップ/選択)を
 * 記録する場所。ランタイムループが毎フレームここから意図を読み、小さなHUDスナップショットを
 * 書き戻す。**毎ティックのシミュレーションデータは決してここに置かない**
 * (design §2、およびモックの「React stateはHUD専用」規則)。
 */

import { create } from "zustand";
import {
  DETECT_RANGE,
  FIRE_ALIGN_RAD,
  FOV_HALF_RAD,
  MOVE_SPEED,
  OBJECTIVE,
  SPEED_STEPS,
  TURN_RATE,
} from "@sim/constants.ts";
import { mirrorPlan, type DeploymentPlan, type ObjectivePlacement } from "@sim/deployment.ts";
import type { ScenarioKey } from "@sim/scenario.ts";
import type { PlanRouteView } from "@render/renderer.ts";
import type {
  Echelon,
  PlanTask,
  Posture,
  Side,
  SimPhase,
  Vec2,
  VictoryState,
} from "@sim/types.ts";
import type { ControlState } from "@sim/control.ts";
import { postureFromRisk } from "@sim/tuning.ts";

const RAD2DEG = 180 / Math.PI;

/** 配置エディタで置こうとしているもの(`[v6.4]`)。null なら通常のユニット選択。 */
export type SetupTool = null | "blueSpawn" | "redSpawn" | "objective";

/** 新しく置く拠点の既定半径(仕様 §12 — 建物内の一室ぶん)。 */
const OBJECTIVE_RADIUS = OBJECTIVE.ROOM_RADIUS;

/** 階層ツリーUIが表示する編成の一覧。毎フレームではなく編成が変わったときだけ更新する。 */
export interface RosterSquad {
  squadId: number;
  /** 現在の指揮官の兵士id(§12 の継承結果)。麾下の強調表示に使う `[v6.4]` */
  commanderId: number | null;
  effective: number;
  total: number;
  /** 指揮継承直後で判断が鈍っている(仕様 §12) */
  degraded: boolean;
}

export interface RosterPlatoon {
  side: Side;
  platoonId: number;
  commanderId: number | null;
  effective: number;
  total: number;
  /** 指揮継承直後で判断が鈍っている(仕様 §12) */
  degraded: boolean;
  squads: RosterSquad[];
}

export interface RosterCompany {
  side: Side;
  companyId: number;
  commanderId: number | null;
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

/** HUDに出す拠点の状態(仕様 §12)。 */
export interface HudObjective {
  id: number;
  label: string;
  owner: Side | null;
  progress: number;
  contested: boolean;
}

export interface HudSnapshot {
  tick: number;
  simSeconds: number;
  blueAlive: number;
  redAlive: number;
  /** 編成上の総員(補充兵を含む)。残存率のバーの分母 `[v6.6]` */
  blueTotal: number;
  redTotal: number;
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
  /** いま担架で運ばれている人数(仕様 §9)。損耗の内訳表示に使う `[v6.6]` */
  blueCarrying: number;
  redCarrying: number;
  /** 争奪中の拠点(仕様 §12) */
  objectives: HudObjective[];
  /** 決着。null なら戦闘継続中 */
  victory: VictoryState | null;
}

/** デバッグ表示のトグル(仕様外・開発用。squad-12v12 モックの「デバッグ表示」に対応)。 */
export interface DebugState {
  /** デバッグパネルを開いているか(キー H / ボタンで切替) */
  panelOpen: boolean;
  /** 視界扇形(FOV)をどこまで描くか */
  fov: "off" | "selected" | "side" | "all";
  /** 選択ユニットの計画経路(soldier.path) */
  showPaths: boolean;
  /** 選択ユニット視点の隠蔽率カラーグリッド */
  showConcealment: boolean;
  /** 発砲線(トレーサー) */
  showShotLines: boolean;
  /** 操作中ユニットの移動命令マーカー + 目的地までの線 */
  showOrders: boolean;
  /** 敵接触の不確度円(既存表示) */
  showContactRings: boolean;
}

/** デバッグパネルのスライダーが持つ共通チューニング(表示は度、シムへ渡すときrad化)。 */
export interface TuningUi {
  detectRange: number;
  fovDeg: number;
  fireAlignDeg: number;
  moveSpeed: number;
  turnRateDeg: number;
}

/** FTごとの思考・状態の要約(ThinkingPanel 用。runtime が間引いて書き込む)。 */
export interface ThinkingFT {
  label: string;
  mode: string;
  role: string;
  routed: boolean;
}
export interface ThinkingSquad {
  label: string;
  technique: string;
  cqb: boolean;
  degraded: boolean;
}
export interface ThinkingSelected {
  id: number;
  side: Side;
  role: string;
  hqRole: string | null;
  order: string;
  hasTarget: boolean;
  sees: number;
  /** いずれかの敵の視界扇形の中にいる(=被発見)か */
  observed: boolean;
  suppressed: boolean;
  routed: boolean;
  evac: string;
  squadId: number;
  fireteamId: number;
}
export interface ThinkingSnapshot {
  fireteams: ThinkingFT[];
  squads: ThinkingSquad[];
  selected: ThinkingSelected | null;
}

/**
 * 作戦立案フェーズの表示用スナップショット(`[v6.5]`)。
 * シムの `OperationPlan` を、パネルがそのまま並べられる形に均したもの。
 */
export interface PlanTaskView {
  /** 地図の経路と対応づけるキー `${side}:${platoonId}` */
  key: string;
  name: string;
  role: PlanTask["role"];
  missionKind: PlanTask["mission"]["kind"];
  order: string;
}
export interface PlanView {
  side: Side;
  intent: string;
  tasks: PlanTaskView[];
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

  // ── 配置エディタ(`[v6.4]`)──
  /**
   * 編集中の配置プラン。ランタイムが起動時にシナリオの既定値を入れる。
   * 「適用」するまで戦闘には反映されず、画面には計画マーカーとして出るだけ。
   */
  deploymentDraft: DeploymentPlan | null;
  /** 適用済みの配置。null なら既定のシナリオそのまま */
  deployment: DeploymentPlan | null;
  /** これが変わるとランタイムごと作り直す(シナリオ切替と同じ扱い) */
  deploymentNonce: number;
  /** いま配置エディタで置こうとしているもの。null なら通常の選択操作 */
  setupTool: SetupTool;
  /** 編集対象の拠点(拠点リストで選ぶ) */
  selectedObjectiveIdx: number | null;
  /** 配置パネルを開いているか(キー G / ボタンで切替)。デバッグパネルと同じ枠を使う */
  deployOpen: boolean;

  // ── 作戦立案フェーズ(`[v6.5]`)──
  /** いまが立案中か戦闘中か。ランタイムがシムの `world.phase` と同期させる */
  phase: SimPhase;
  /** 表示している陣営の作戦(神視点なら両陣営ぶん) */
  plans: PlanView[];
  /** 地図に重ねる接近経路 */
  planRoutes: PlanRouteView[];
  /** パネルでカーソルを乗せている項目。地図側でその1本だけ強調する */
  hoveredPlanKey: string | null;
  /** 凡例パネルを開いているか(キー L / ボタンで切替) */
  legendOpen: boolean;

  /** 人間が操作中のノード(仕様 §4)。null なら観戦 */
  control: ControlState | null;
  /** 階層ツリー表示用の編成一覧 */
  roster: RosterCompany[];

  /** 直近に出した移動命令(OrderToast 用)。tick は発行時のシムtick */
  lastOrder: { target: Vec2; tick: number; echelon: Echelon } | null;
  /** 表示側の思考・状態の要約(ThinkingPanel 用) */
  thinking: ThinkingSnapshot;
  /** デバッグ表示トグル */
  debug: DebugState;
  /** デバッグ用スライダー(共通チューニング) */
  tuning: TuningUi;
  /** デバッグ用スライダー(陣営別リスク許容度 0..1) */
  /** デバッグ用スライダー(陣営別の性格パラメータ)。riskTolerance はマスター */
  posture: Record<Side, Posture>;

  togglePause: () => void;
  cycleSpeed: () => void;
  /** 速度を直接選ぶ(倍率ボタンを横並びにしたので `[v6.6]`)。選ぶとポーズも解ける */
  setSpeedIdx: (i: number) => void;
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
  /** ランタイムが立案結果を流し込む(世界を作り直したとき) */
  enterPlanning: (plans: PlanView[], routes: PlanRouteView[]) => void;
  /** 立案の表示だけ差し替える(視点を切り替えたとき) */
  setPlanView: (plans: PlanView[], routes: PlanRouteView[]) => void;
  setHoveredPlan: (key: string | null) => void;
  /** 「戦闘開始」。ランタイムが次フレームでシムへ反映する */
  startBattle: () => void;
  toggleLegend: () => void;
  pushHud: (snap: HudSnapshot) => void;
  setLastOrder: (o: { target: Vec2; tick: number; echelon: Echelon }) => void;
  pushThinking: (t: ThinkingSnapshot) => void;
  /** ランタイムがシナリオの既定配置を流し込む(編集の出発点) */
  initDeployment: (plan: DeploymentPlan) => void;
  setSetupTool: (t: SetupTool) => void;
  toggleDeploy: () => void;
  /** 配置エディタで地図をクリックしたときの着地点 */
  placeAt: (p: Vec2) => void;
  setObjectiveField: (idx: number, patch: Partial<ObjectivePlacement>) => void;
  removeObjective: (idx: number) => void;
  selectObjective: (idx: number | null) => void;
  /** 陣営の向きを度で設定する(0° = +Z、時計回り) */
  setSpawnHeading: (side: Side, deg: number) => void;
  /** 青の配置を点対称に写して赤へ(仕様 §2/§13 の担保を取り戻す) */
  mirrorDeployment: () => void;
  /** 編集中の配置で戦闘を作り直す */
  commitDeployment: () => void;
  /** シナリオ既定の配置へ戻して作り直す */
  resetDeployment: () => void;
  setDebug: (patch: Partial<DebugState>) => void;
  setTuning: (patch: Partial<TuningUi>) => void;
  /** マスター(リスク許容度)。個別値もこの値から一括で再計算する */
  setPostureRisk: (side: Side, riskTolerance: number) => void;
  /** 個別の性格パラメータを上書きする */
  setPostureKnob: (side: Side, patch: Partial<Posture>) => void;
  /** 共通チューニングとリスク許容度を仕様の既定値へ戻す */
  resetTuning: () => void;
}

/** constants.ts そのままの表示用チューニング値(スライダーの初期値・リセット先)。 */
export const DEFAULT_TUNING_UI: TuningUi = {
  detectRange: DETECT_RANGE,
  fovDeg: Math.round(FOV_HALF_RAD * 2 * RAD2DEG),
  fireAlignDeg: Math.round(FIRE_ALIGN_RAD * RAD2DEG),
  moveSpeed: MOVE_SPEED,
  turnRateDeg: Math.round(TURN_RATE * RAD2DEG),
};

/** 実行中の速度のみ(SPEED_STEPS[0] の 0 を除く) */
export const RUN_SPEEDS = SPEED_STEPS.filter((s) => s > 0);

export const useSimStore = create<UiState>((set) => ({
  tick: 0,
  simSeconds: 0,
  blueAlive: 0,
  redAlive: 0,
  blueTotal: 0,
  redTotal: 0,
  blueEffective: 0,
  redEffective: 0,
  knownContacts: 0,
  staleContacts: 0,
  blueEvacuated: 0,
  redEvacuated: 0,
  blueAwaitingEvac: 0,
  redAwaitingEvac: 0,
  blueCarrying: 0,
  redCarrying: 0,
  objectives: [],
  victory: null,

  paused: false,
  speedIdx: RUN_SPEEDS.indexOf(1) >= 0 ? RUN_SPEEDS.indexOf(1) : 0,
  stepNonce: 0,
  selectedSoldierId: null,

  viewSide: "blue",
  viewEchelon: "platoon",
  viewSquadId: null,
  viewPlatoonId: null,
  scenarioKey: "platoon",
  phase: "battle",
  plans: [],
  planRoutes: [],
  hoveredPlanKey: null,
  legendOpen: true,
  control: null,
  roster: [],

  deploymentDraft: null,
  deployment: null,
  deploymentNonce: 0,
  setupTool: null,
  selectedObjectiveIdx: null,
  deployOpen: false,

  lastOrder: null,
  thinking: { fireteams: [], squads: [], selected: null },
  debug: {
    panelOpen: false,
    fov: "off",
    showPaths: true,
    showConcealment: false,
    showShotLines: true,
    showOrders: true,
    showContactRings: true,
  },
  tuning: { ...DEFAULT_TUNING_UI },
  posture: {
    blue: { riskTolerance: 0.5, ...postureFromRisk(0.5) },
    red: { riskTolerance: 0.5, ...postureFromRisk(0.5) },
  },

  togglePause: () => set((s) => ({ paused: !s.paused })),
  cycleSpeed: () => set((s) => ({ speedIdx: (s.speedIdx + 1) % RUN_SPEEDS.length })),
  setSpeedIdx: (i) => set({ speedIdx: Math.max(0, Math.min(RUN_SPEEDS.length - 1, i)), paused: false }),
  requestStep: () => set((s) => ({ stepNonce: s.stepNonce + 1 })),
  select: (id) => set({ selectedSoldierId: id }),
  setViewSide: (side) => set({ viewSide: side }),
  setViewEchelon: (e) => set({ viewEchelon: e }),
  setViewSquadId: (id) => set({ viewSquadId: id }),
  setViewPlatoonId: (id) => set({ viewPlatoonId: id }),
  /** シナリオを切り替える。世界を作り直すので操作対象と視点も初期化する */
  setScenario: (k) =>
    set({
      scenarioKey: k,
      control: null,
      viewSquadId: null,
      viewPlatoonId: null,
      // 配置はシナリオごとの座標系に依存するので持ち越さない
      deployment: null,
      deploymentDraft: null,
      setupTool: null,
      selectedObjectiveIdx: null,
    }),

  // ── 配置エディタ(`[v6.4]`)──
  initDeployment: (plan) => set((s) => (s.deploymentDraft ? {} : { deploymentDraft: plan })),
  setSetupTool: (t) => set({ setupTool: t }),
  // デバッグパネルと同じ枠に出るので、開いたらもう片方は閉じる
  toggleDeploy: () =>
    set((st) => ({
      deployOpen: !st.deployOpen,
      setupTool: st.deployOpen ? null : st.setupTool,
      debug: { ...st.debug, panelOpen: st.deployOpen ? st.debug.panelOpen : false },
    })),
  placeAt: (p) =>
    set((s) => {
      const d = s.deploymentDraft;
      if (!d || !s.setupTool) return {};
      if (s.setupTool === "objective") {
        const objs = [...(d.objectives ?? [])];
        // `[v6.4]` **既存の拠点の上をクリックしたら、それを掴んで動かす**。
        // 以前はリストで選んでからでないと動かせず、そのままクリックすると
        // 新しい拠点が増えるだけだったので、元の拠点が「動かない」ように見えた
        // (4回目のテストプレイ指摘)。
        let grabbed = -1;
        let bestD = Infinity;
        objs.forEach((o, i) => {
          const dd = Math.hypot(o.pos.x - p.x, o.pos.z - p.z);
          if (dd <= Math.max(o.radius, 6) && dd < bestD) {
            bestD = dd;
            grabbed = i;
          }
        });
        if (grabbed >= 0) return { selectedObjectiveIdx: grabbed };

        const idx = s.selectedObjectiveIdx;
        // 選択中の拠点があれば動かす。無ければ新規に置く
        if (idx !== null && objs[idx]) {
          objs[idx] = { ...objs[idx]!, pos: { ...p } };
          return { deploymentDraft: { ...d, objectives: objs } };
        }
        objs.push({ label: `OBJ ${objs.length + 1}`, pos: { ...p }, radius: OBJECTIVE_RADIUS });
        return {
          deploymentDraft: { ...d, objectives: objs },
          selectedObjectiveIdx: objs.length - 1,
        };
      }
      const side: Side = s.setupTool === "blueSpawn" ? "blue" : "red";
      const prev = d.spawn[side];
      // 向きは据え置き。初回だけ「最寄りの拠点(なければ原点)を向く」で決める
      const facing =
        prev?.facing ??
        (() => {
          const t = (d.objectives ?? [])[0]?.pos ?? { x: 0, z: 0 };
          const dx = t.x - p.x;
          const dz = t.z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          return { x: dx / len, z: dz / len };
        })();
      return {
        deploymentDraft: { ...d, spawn: { ...d.spawn, [side]: { pos: { ...p }, facing } } },
      };
    }),
  setObjectiveField: (idx, patch) =>
    set((s) => {
      const d = s.deploymentDraft;
      if (!d) return {};
      const objs = [...(d.objectives ?? [])];
      if (!objs[idx]) return {};
      objs[idx] = { ...objs[idx]!, ...patch };
      return { deploymentDraft: { ...d, objectives: objs } };
    }),
  removeObjective: (idx) =>
    set((s) => {
      const d = s.deploymentDraft;
      if (!d) return {};
      const objs = (d.objectives ?? []).filter((_, i) => i !== idx);
      return { deploymentDraft: { ...d, objectives: objs }, selectedObjectiveIdx: null };
    }),
  selectObjective: (idx) => set({ selectedObjectiveIdx: idx }),
  setSpawnHeading: (side, deg) =>
    set((s) => {
      const d = s.deploymentDraft;
      const cur = d?.spawn[side];
      if (!d || !cur) return {};
      const rad = (deg * Math.PI) / 180;
      // 0° = +Z(画面下向き)を基準に時計回り
      const facing = { x: Math.sin(rad), z: Math.cos(rad) };
      return { deploymentDraft: { ...d, spawn: { ...d.spawn, [side]: { ...cur, facing } } } };
    }),
  mirrorDeployment: () =>
    set((s) => (s.deploymentDraft ? { deploymentDraft: mirrorPlan(s.deploymentDraft) } : {})),
  commitDeployment: () =>
    set((s) => ({
      deployment: s.deploymentDraft,
      deploymentNonce: s.deploymentNonce + 1,
      setupTool: null,
      control: null,
      selectedSoldierId: null,
    })),
  resetDeployment: () =>
    set((s) => ({
      deployment: null,
      deploymentDraft: null,
      deploymentNonce: s.deploymentNonce + 1,
      setupTool: null,
      selectedObjectiveIdx: null,
      control: null,
      selectedSoldierId: null,
    })),
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
  // 立案へ入るときは操作対象と選択を初期化する。世界が作り直されているので
  // 前の盤面の兵士idを握ったままだと、別人を指したハイライトが残る
  enterPlanning: (plans, routes) =>
    set({
      phase: "planning",
      plans,
      planRoutes: routes,
      hoveredPlanKey: null,
      control: null,
      selectedSoldierId: null,
    }),
  setPlanView: (plans, routes) => set({ plans, planRoutes: routes }),
  setHoveredPlan: (key) => set({ hoveredPlanKey: key }),
  startBattle: () => set({ phase: "battle", planRoutes: [], hoveredPlanKey: null }),
  toggleLegend: () => set((s) => ({ legendOpen: !s.legendOpen })),
  pushHud: (snap) => set(snap),
  setLastOrder: (o) => set({ lastOrder: o }),
  pushThinking: (t) => set({ thinking: t }),
  setDebug: (patch) =>
    set((s) => ({
      debug: { ...s.debug, ...patch },
      // 同じ枠を使うので、デバッグパネルを開いたら配置パネルは閉じる
      ...(patch.panelOpen ? { deployOpen: false, setupTool: null } : {}),
    })),
  setTuning: (patch) => set((s) => ({ tuning: { ...s.tuning, ...patch } })),
  setPostureRisk: (side, riskTolerance) =>
    set((s) => ({
      posture: {
        ...s.posture,
        [side]: { riskTolerance, ...postureFromRisk(riskTolerance) },
      },
    })),
  setPostureKnob: (side, patch) =>
    set((s) => ({
      posture: { ...s.posture, [side]: { ...s.posture[side], ...patch } },
    })),
  resetTuning: () =>
    set({
      tuning: { ...DEFAULT_TUNING_UI },
      posture: {
        blue: { riskTolerance: 0.5, ...postureFromRisk(0.5) },
        red: { riskTolerance: 0.5, ...postureFromRisk(0.5) },
      },
    }),
}));

/** 現在の実効時間倍率(ポーズ中は0)。 */
export function currentSpeed(s: Pick<UiState, "paused" | "speedIdx">): number {
  return s.paused ? 0 : (RUN_SPEEDS[s.speedIdx] ?? 1);
}
