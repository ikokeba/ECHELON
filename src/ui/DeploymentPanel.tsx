import { useSimStore } from "./store.ts";
import { isPointSymmetric } from "@sim/deployment.ts";
import type { Side } from "@sim/types.ts";

/**
 * 配置エディタ(`[v6.4]`)。陣営の初期展開位置と拠点をプレイヤーが決める。
 *
 * 使い方は「道具を選ぶ → 地図をクリック」。編集中は**計画マーカー**として画面に
 * 重なるだけで、戦闘には反映されない。「この配置で開始」を押した時点で世界を
 * 作り直す(シナリオ切替と同じ扱い)。
 *
 * 点対称かどうかを常に出しているのは、仕様 §2/§13 のため。既定のシナリオが
 * 点対称なのは「地形由来ではない有利不利が無い」ことの担保で、非対称に置くと
 * その担保は外れる。禁止はしない — 非対称な状況を作るのは正当な遊び方なので、
 * **外れたことが分かる**ようにするだけに留める。
 */

const SIDE_LABEL: Record<Side, string> = { blue: "BLUE", red: "RED" };

/** 向きベクトル → 度(0° = +Z、時計回り)。UIの表示と入力に使う。 */
function headingDeg(v: { x: number; z: number }): number {
  const d = (Math.atan2(v.x, v.z) * 180) / Math.PI;
  return Math.round((d + 360) % 360);
}

export function DeploymentPanel() {
  const open = useSimStore((s) => s.deployOpen);
  const draft = useSimStore((s) => s.deploymentDraft);
  const close = useSimStore((s) => s.toggleDeploy);
  const tool = useSimStore((s) => s.setupTool);
  const selIdx = useSimStore((s) => s.selectedObjectiveIdx);
  const setTool = useSimStore((s) => s.setSetupTool);
  const setHeading = useSimStore((s) => s.setSpawnHeading);
  const setObjField = useSimStore((s) => s.setObjectiveField);
  const removeObjective = useSimStore((s) => s.removeObjective);
  const selectObjective = useSimStore((s) => s.selectObjective);
  const mirror = useSimStore((s) => s.mirrorDeployment);
  const commit = useSimStore((s) => s.commitDeployment);
  const reset = useSimStore((s) => s.resetDeployment);

  if (!open || !draft) return null;

  const symmetric = isPointSymmetric(draft);
  const objectives = draft.objectives ?? [];

  return (
    <div className="panel overlay-panel">
      <div className="ov-head">
        <span>配置</span>
        <span className={symmetric ? "dep-sym" : "dep-asym"}>
          {symmetric ? "点対称" : "非対称"}
        </span>
        <button type="button" className="btn-x" onClick={close} title="閉じる (G)">
          ×
        </button>
      </div>

      <div className="ov-sec">
        <div className="dbg-k">
          道具を選んで地図をクリック。適用するまで戦闘には反映されません。
        </div>
        <div className="seg">
          {(
            [
              { v: "blueSpawn" as const, label: "BLUE展開" },
              { v: "redSpawn" as const, label: "RED展開" },
              { v: "objective" as const, label: "拠点" },
            ] satisfies Array<{ v: NonNullable<typeof tool>; label: string }>
          ).map((t) => (
            <button
              key={t.v}
              type="button"
              className={tool === t.v ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => setTool(tool === t.v ? null : t.v)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tool === "objective" && (
          <div className="dbg-k">
            {selIdx === null
              ? "既存の拠点の上をクリック = その拠点を掴む / 何もない所をクリック = 新規追加"
              : `「${objectives[selIdx]?.label ?? ""}」を移動します(もう一度名前を押すと選択解除)`}
          </div>
        )}
        <div className="dbg-k">
          地図上の<b className="dep-legend">薄い印</b>が編集中の予定です。濃い緑のリングは
          いま戦闘中の拠点で、「この配置で立案する」を押すまで置き換わりません。
          押すと盤面を組み直し、中隊長が<b>作戦を立て直します</b>。
        </div>
      </div>

      <div className="ov-sec">
        <div className="ov-sec-title">展開点</div>
        {(["blue", "red"] as Side[]).map((side) => {
          const sp = draft.spawn[side];
          if (!sp) return null;
          return (
            <div key={side} className="dep-spawn">
              <div className="dep-spawn-head">
                <span className={side === "blue" ? "force-blue" : "force-red"}>
                  {SIDE_LABEL[side]}
                </span>
                <span className="mono dbg-k">
                  {sp.pos.x.toFixed(0)}, {sp.pos.z.toFixed(0)}
                </span>
              </div>
              <div className="dbg-slider">
                <div className="dbg-slider-head">
                  <span>正面</span>
                  <span className="mono">{headingDeg(sp.facing)}°</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={headingDeg(sp.facing)}
                  onChange={(e) => setHeading(side, Number(e.target.value))}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="ov-sec">
        <div className="ov-sec-title">拠点(仕様 §12)</div>
        {objectives.length === 0 && <div className="dbg-k">拠点なし — 戦力の枯渇でのみ決着</div>}
        {objectives.map((o, i) => (
          <div key={i} className={i === selIdx ? "dep-obj dep-obj-on" : "dep-obj"}>
            <button
              type="button"
              className="dep-obj-pick"
              onClick={() => selectObjective(i === selIdx ? null : i)}
              title="選んでから地図をクリックすると移動します"
            >
              {o.label}
            </button>
            <span className="mono dbg-k">
              {o.pos.x.toFixed(0)}, {o.pos.z.toFixed(0)}
            </span>
            <label className="dep-obj-r" title="確保判定の半径 m">
              <span className="dbg-k">r</span>
              <input
                type="number"
                min={1}
                max={40}
                step={1}
                value={Math.round(o.radius)}
                onChange={(e) => setObjField(i, { radius: Number(e.target.value) })}
              />
            </label>
            <button type="button" className="btn-x" onClick={() => removeObjective(i)}>
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="ov-sec">
        <button type="button" className="btn" onClick={mirror}>
          BLUEを点対称に写してRED
        </button>
        <button type="button" className="btn dep-apply" onClick={commit}>
          この配置で立案する
        </button>
        <button type="button" className="btn" onClick={reset}>
          既定の配置へ戻す
        </button>
        {!symmetric && (
          <div className="dbg-k">
            非対称な配置です。両陣営のAIは同一のままですが、
            「地形由来ではない有利不利が無い」という担保(仕様 §2/§13)は外れます。
          </div>
        )}
      </div>
    </div>
  );
}
