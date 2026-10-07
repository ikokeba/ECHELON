import { useSimStore, type DebugState } from "./store.ts";
import { COMMON_SLIDERS, POSTURE_KNOBS } from "./tuningDefs.ts";
import { LlmPanel } from "./LlmPanel.tsx";
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

export function DebugPanel() {
  const debug = useSimStore((s) => s.debug);
  const tuning = useSimStore((s) => s.tuning);
  const posture = useSimStore((s) => s.posture);
  const setDebug = useSimStore((s) => s.setDebug);
  const setTuning = useSimStore((s) => s.setTuning);
  const setPostureRisk = useSimStore((s) => s.setPostureRisk);
  const setPostureKnob = useSimStore((s) => s.setPostureKnob);
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
    <div className="panel overlay-panel">
      <div className="ov-head">
        <span>デバッグ</span>
        <button type="button" className="btn-x" onClick={() => setDebug({ panelOpen: false })}>
          ×
        </button>
      </div>

      <div className="ov-sec">
        <div className="ov-sec-title">デバッグ表示</div>
        <div className="dbg-slider">
          <span className="dbg-k">視界(FOV)</span>
          <div className="seg">
            {FOV_MODES.map((m) => (
              <button
                key={m.v}
                type="button"
                className={debug.fov === m.v ? "seg-btn seg-on" : "seg-btn"}
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
        {chk("showFlot", "中隊長の前線と火力統制線")}
      </div>

      <div className="ov-sec">
        <div className="ov-sec-title">両陣営共通パラメータ</div>
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

      <div className="ov-sec">
        <div className="ov-sec-title">陣営別 性格パラメータ</div>
        <div className="dbg-k">
          リスク許容度はマスター(高いほど交戦距離を詰め、前進歩幅が大きく、劣勢でも粘り、
          露出を厭わない)。動かすと下の個別値も一括で再計算。0.5 で全て既定。
        </div>
        {(["blue", "red"] as Side[]).map((side) => (
          <details key={side} className="dbg-posture">
            <summary>
              <span className={side === "blue" ? "dbg-blue" : "dbg-red"}>
                {side.toUpperCase()} リスク許容度
              </span>
              <span className="mono">{posture[side].riskTolerance.toFixed(2)}</span>
            </summary>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={posture[side].riskTolerance}
              onChange={(e) => setPostureRisk(side, Number(e.target.value))}
            />
            {POSTURE_KNOBS.map((k) => (
              <div key={k.key} className="dbg-slider dbg-slider-sub">
                <div className="dbg-slider-head">
                  <span>{k.label}</span>
                  <span className="mono">{posture[side][k.key].toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={k.min}
                  max={k.max}
                  step={k.step}
                  value={posture[side][k.key]}
                  onChange={(e) => setPostureKnob(side, { [k.key]: Number(e.target.value) })}
                />
              </div>
            ))}
          </details>
        ))}
      </div>

      <button type="button" className="btn" onClick={resetTuning}>
        パラメータを既定へ戻す
      </button>

      <LlmPanel />

      {/*
        兵士の色・階級章・拠点などの通常の凡例は画面下の `Legend`(キー L)へ移した
        (`[v6.5]`)。ここにはデバッグ表示だけで使う記号を残す — 2箇所に同じ凡例が
        あると、色を変えたときに片方だけ直して食い違う。
      */}
      <div className="ov-sec hint">
        <div>
          <span className="lg-g lg-fill" style={{ background: "var(--rank)" }} />
          発砲線（明=命中 / 暗=外れ）・擲弾は橙の拡大円
        </div>
        <div>
          <span className="lg-g lg-fill" style={{ background: "var(--red)" }} />
          隠蔽グリッド: 赤=選択ユニットから見える / 緑=見えない
        </div>
        <div>他の記号は画面下の凡例（キー L）を参照。</div>
      </div>
    </div>
  );
}
