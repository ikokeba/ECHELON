import { useSimStore, type DebugState, type TuningUi } from "./store.ts";
import type { Side } from "@sim/types.ts";

/**
 * デバッグUI(初回テストプレイ指摘)。squad-12v12 モックの右サイドパネルを踏襲する:
 *   - デバッグ表示トグル（視界・移動予定・隠蔽グリッド・発砲線・命令ライン・不確度円）
 *   - 両陣営共通パラメータのスライダー（索敵距離・視界角・正対角・移動速度・旋回速度）
 *   - 陣営固有パラメータのスライダー（リスク許容度）
 *
 * ここで動かした値は `world.tuning` / `world.posture` へ即時反映される（`runtime.ts`）。
 * 既定値のままなら現行の挙動と完全に一致し、対称性・決定論テストにも影響しない。
 * キー `H` かヘッダの×で開閉する。
 */

const FOV_MODES: Array<{ v: DebugState["fov"]; label: string }> = [
  { v: "off", label: "なし" },
  { v: "selected", label: "選択のみ" },
  { v: "side", label: "自陣営" },
  { v: "all", label: "全員" },
];

interface SliderDef {
  key: keyof TuningUi;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt?: (n: number) => string;
}
const COMMON_SLIDERS: SliderDef[] = [
  { key: "detectRange", label: "索敵距離 (m)", min: 5, max: 40, step: 1 },
  { key: "fovDeg", label: "視界角 (度・正面中心)", min: 30, max: 200, step: 5 },
  { key: "fireAlignDeg", label: "実射の正対角 (±度)", min: 2, max: 45, step: 1 },
  { key: "moveSpeed", label: "移動速度 (m/s)", min: 0.5, max: 6, step: 0.1, fmt: (n) => n.toFixed(1) },
  { key: "turnRateDeg", label: "旋回速度 (度/秒)", min: 60, max: 720, step: 10 },
];

export function DebugPanel() {
  const debug = useSimStore((s) => s.debug);
  const tuning = useSimStore((s) => s.tuning);
  const posture = useSimStore((s) => s.posture);
  const setDebug = useSimStore((s) => s.setDebug);
  const setTuning = useSimStore((s) => s.setTuning);
  const setPosture = useSimStore((s) => s.setPosture);
  const resetTuning = useSimStore((s) => s.resetTuning);

  if (!debug.panelOpen) return null;

  const chk = (key: keyof DebugState, label: string) => (
    <label className="dbg-chk">
      <input
        type="checkbox"
        checked={debug[key] as boolean}
        onChange={(e) => setDebug({ [key]: e.target.checked })}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="debug-panel">
      <div className="dbg-head">
        <span>デバッグ</span>
        <button type="button" className="dbg-x" onClick={() => setDebug({ panelOpen: false })}>
          ×
        </button>
      </div>

      <div className="dbg-sec">
        <div className="dbg-sec-title">デバッグ表示</div>
        <div className="dbg-row">
          <span className="dbg-k">視界(FOV)</span>
          <div className="dbg-seg">
            {FOV_MODES.map((m) => (
              <button
                key={m.v}
                type="button"
                className={debug.fov === m.v ? "dbg-seg-btn dbg-on" : "dbg-seg-btn"}
                onClick={() => setDebug({ fov: m.v })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {chk("showPaths", "選択ユニットの移動予定")}
        {chk("showConcealment", "選択ユニット視点の隠蔽率グリッド")}
        {chk("showShotLines", "発砲線")}
        {chk("showOrders", "操作中ユニットの移動命令ライン")}
        {chk("showContactRings", "敵接触の不確度円")}
      </div>

      <div className="dbg-sec">
        <div className="dbg-sec-title">両陣営共通パラメータ</div>
        {COMMON_SLIDERS.map((s) => (
          <div key={s.key} className="dbg-slider">
            <div className="dbg-slider-head">
              <span>{s.label}</span>
              <span className="mono">{(s.fmt ?? ((n: number) => String(n)))(tuning[s.key])}</span>
            </div>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={tuning[s.key]}
              onChange={(e) => setTuning({ [s.key]: Number(e.target.value) })}
            />
          </div>
        ))}
      </div>

      <div className="dbg-sec">
        <div className="dbg-sec-title">陣営固有パラメータ</div>
        <div className="dbg-note">
          リスク許容度: 高いほど交戦距離を詰め、前進歩幅が大きく、劣勢でも粘る。0.5 で既定。
        </div>
        {(["blue", "red"] as Side[]).map((side) => (
          <div key={side} className="dbg-slider">
            <div className="dbg-slider-head">
              <span className={side === "blue" ? "dbg-blue" : "dbg-red"}>
                {side.toUpperCase()} リスク許容度
              </span>
              <span className="mono">{posture[side].riskTolerance.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={posture[side].riskTolerance}
              onChange={(e) => setPosture(side, Number(e.target.value))}
            />
          </div>
        ))}
      </div>

      <button type="button" className="dbg-reset" onClick={resetTuning}>
        パラメータを既定へ戻す
      </button>

      <div className="dbg-legend">
        <div>
          <span className="lg-swatch" style={{ background: "#f5d84a" }} />
          金リング/マーカー = 操作中ユニットと移動命令先
        </div>
        <div>
          <span className="lg-swatch" style={{ background: "#7ff0ff" }} />
          水色リング = 選択ユニット
        </div>
        <div>
          <span className="lg-swatch" style={{ background: "#ffe08a" }} />
          発砲線（明=命中 / 暗=外れ）・擲弾は橙の拡大円
        </div>
        <div>
          <span className="lg-swatch" style={{ background: "#f04a38" }} />
          隠蔽グリッド: 赤=選択ユニットから見える / 緑=見えない
        </div>
      </div>
    </div>
  );
}
