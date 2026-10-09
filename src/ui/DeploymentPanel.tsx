import { useSimStore } from "./store.ts";
import { SetupCodePanel } from "./SetupCodePanel.tsx";
import { isPointSymmetric } from "@sim/deployment.ts";
import { OBJECTIVE } from "@sim/constants.ts";
import { DOCTRINES, DOCTRINE_KEYS } from "@sim/doctrine.ts";
import {
  DEFAULT_REINFORCEMENT,
  FORCE_SCALES,
  FORCE_SCALE_KEYS,
  forceSize,
} from "@sim/force.ts";
import type { ReinforcementSpec } from "@sim/types.ts";
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
  const addObjective = useSimStore((s) => s.addObjective);
  const setBattleMode = useSimStore((s) => s.setBattleMode);
  const doctrine = useSimStore((s) => s.doctrine);
  const setDoctrine = useSimStore((s) => s.setDoctrine);
  const force = useSimStore((s) => s.force);
  const setForce = useSimStore((s) => s.setForce);
  const removeObjective = useSimStore((s) => s.removeObjective);
  const selectObjective = useSimStore((s) => s.selectObjective);
  const mirror = useSimStore((s) => s.mirrorDeployment);
  const commit = useSimStore((s) => s.commitDeployment);
  const reset = useSimStore((s) => s.resetDeployment);

  if (!open || !draft) return null;

  const symmetric = isPointSymmetric(draft);
  const objectives = draft.objectives ?? [];
  const mode = draft.mode ?? "meeting";
  const attacker = draft.attacker ?? "blue";
  const timeLimitSec = draft.timeLimitSec ?? OBJECTIVE.ASSAULT_TIME_LIMIT_SEC;

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

      {/* `[v6.18]` 初期条件コード。配置と同じ「戦闘を作る」画面に置く */}
      <SetupCodePanel />

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


      {/* ── 陣営の編成(仕様 §2 編成 / §14 MOS)`[v6.9]` ── */}
      <div className="ov-sec">
        <div className="ov-sec-title">陣営の編成</div>
        <div className="dbg-k">
          規模と特技保有者を陣営ごとに決めます。変わるのは<b>盤上に置く駒</b>だけで、
          兵士1名あたりの命中率・耐久はどの編成でも同一です(仕様 §2/§13)。
          規模を変えると展開点は盤面の既定へ戻ります。
        </div>
        {(["blue", "red"] as Side[]).map((side) => {
          const spec = force[side];
          const shape = FORCE_SCALES[spec.scale];
          return (
            <div key={side} className="dep-spawn">
              <div className="dep-spawn-head">
                <span className={side === "blue" ? "force-blue" : "force-red"}>
                  {SIDE_LABEL[side]}
                </span>
                <span className="mono dbg-k">{forceSize(spec)}名</span>
              </div>
              <div className="seg">
                {FORCE_SCALE_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={spec.scale === k ? "seg-btn seg-on" : "seg-btn"}
                    onClick={() => setForce(side, { scale: k })}
                    title={FORCE_SCALES[k].detail}
                  >
                    {FORCE_SCALES[k].label}
                  </button>
                ))}
              </div>
              <div className="dep-opts">
                <label className="dbg-chk" title="分隊に1名。索敵300m・専用の射撃諸元(仕様 §10/§14)">
                  <input
                    type="checkbox"
                    checked={spec.marksman}
                    onChange={(e) => setForce(side, { marksman: e.target.checked })}
                  />
                  <span>選抜射手</span>
                </label>
                <label className="dbg-chk" title="FTに1名。擲弾3発(仕様 §8.1/§14)。外すと分隊から擲弾が消える">
                  <input
                    type="checkbox"
                    checked={spec.grenadier}
                    onChange={(e) => setForce(side, { grenadier: e.target.checked })}
                  />
                  <span>擲弾手</span>
                </label>
                <label
                  className="dbg-chk"
                  title="FTに1名、ライフルマンが防弾盾+拳銃に替わる。盾を先頭にした密集隊形で動き、正面からの被弾を大きく減らす(側面・擲弾には効かない)"
                >
                  <input
                    type="checkbox"
                    checked={spec.shield === true}
                    onChange={(e) => setForce(side, { shield: e.target.checked })}
                  />
                  <span>盾持ち</span>
                </label>
                <label
                  className="dbg-chk"
                  title="対戦車・対構造物火器(`[v7.3]`)。小銃分隊に1名の射手が2発持つ。窓・射撃壕・機関銃陣地にこもった敵を崩す"
                >
                  <input
                    type="checkbox"
                    checked={spec.antiArmor === true}
                    onChange={(e) => setForce(side, { antiArmor: e.target.checked })}
                  />
                  <span>対戦車火器</span>
                </label>
                <label
                  className="dbg-chk"
                  title="後援部隊(暫定仕様)。最上位の指揮官が要請すると、時間をおいて後方に分隊/小隊が現れる"
                >
                  <input
                    type="checkbox"
                    checked={(spec.reinforcement?.calls ?? 0) > 0}
                    onChange={(e) =>
                      setForce(side, {
                        reinforcement: e.target.checked ? { ...DEFAULT_REINFORCEMENT } : undefined,
                      })
                    }
                  />
                  <span>後援部隊</span>
                </label>
                <label
                  className="dbg-chk"
                  title={
                    shape.weapons
                      ? "小隊直轄の機関銃班7名(仕様 §2)"
                      : "分隊規模には火器分隊がありません"
                  }
                >
                  <input
                    type="checkbox"
                    checked={spec.weaponsSquad}
                    disabled={!shape.weapons}
                    onChange={(e) => setForce(side, { weaponsSquad: e.target.checked })}
                  />
                  <span className={shape.weapons ? undefined : "dbg-k"}>火器分隊</span>
                </label>
              </div>
              {spec.reinforcement && (
                <ReinforcementEditor
                  value={spec.reinforcement}
                  onChange={(patch) =>
                    setForce(side, { reinforcement: { ...spec.reinforcement!, ...patch } })
                  }
                />
              )}
              <div className="dbg-k">{FORCE_SCALES[spec.scale].detail}</div>
            </div>
          );
        })}
        {force.blue.scale !== force.red.scale && (
          <div className="dbg-k">
            左右で規模が違います。頭数の差はそのまま戦力差なので、
            点対称の担保(仕様 §2/§13)はこの編成では意味を持ちません。
          </div>
        )}
      </div>

      {/* ── 陣営のドクトリン(仕様 §13)`[v6.8]` ── */}
      <div className="ov-sec">
        <div className="ov-sec-title">陣営のドクトリン</div>
        <div className="dbg-k">
          切り替わるのは兵士の能力ではなく<b>指揮系統の効き方</b>です
          — 判断の周期、無線の遅れ、下位がどれだけ自分の判断で動くか。
        </div>
        {(["blue", "red"] as Side[]).map((side) => (
          <div key={side} className="dep-spawn">
            <div className="dep-spawn-head">
              <span className={side === "blue" ? "force-blue" : "force-red"}>
                {SIDE_LABEL[side]}
              </span>
            </div>
            <div className="seg">
              {DOCTRINE_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={doctrine[side] === k ? "seg-btn seg-on" : "seg-btn"}
                  onClick={() => setDoctrine(side, k)}
                  title={DOCTRINES[k].detail}
                >
                  {DOCTRINES[k].label}
                </button>
              ))}
            </div>
            <div className="dbg-k">{DOCTRINES[doctrine[side]].detail}</div>
          </div>
        ))}
        {doctrine.blue !== doctrine.red && (
          <div className="dbg-k">
            左右でドクトリンが違います。両陣営のAIは同一の機構のままですが、
            <b>統制の効き方が非対称</b>になります(仕様 §2/§13 の担保は
            「同じ機構で動く」ことであって「同じ組織である」ことではありません)。
          </div>
        )}
      </div>

      {/* ── 戦闘の型(仕様 §12「モード別の追加条件」)`[v6.8]` ── */}
      <div className="ov-sec">
        <div className="ov-sec-title">戦闘の型</div>
        <div className="seg">
          <button
            type="button"
            className={mode === "meeting" ? "seg-btn seg-on" : "seg-btn"}
            onClick={() => setBattleMode({ mode: "meeting" })}
            title="全拠点が中立から始まり、過半数を保持した側が勝つ"
          >
            遭遇戦
          </button>
          <button
            type="button"
            className={mode === "assault" ? "seg-btn seg-on" : "seg-btn"}
            onClick={() => setBattleMode({ mode: "assault" })}
            title="防御側が全拠点を保有。攻撃側は制限時間内に奪わなければ負け"
          >
            攻防戦
          </button>
        </div>
        {mode === "assault" && (
          <>
            <div className="seg-row">
              <span className="seg-label">攻撃</span>
              <div className="seg">
                <button
                  type="button"
                  className={attacker === "blue" ? "seg-btn seg-on seg-blue" : "seg-btn"}
                  onClick={() => setBattleMode({ attacker: "blue" })}
                >
                  BLUE
                </button>
                <button
                  type="button"
                  className={attacker === "red" ? "seg-btn seg-on seg-red" : "seg-btn"}
                  onClick={() => setBattleMode({ attacker: "red" })}
                >
                  RED
                </button>
              </div>
            </div>
            <div className="dbg-slider">
              <div className="dbg-slider-head">
                <span>制限時間</span>
                <span className="mono">
                  {Math.floor(timeLimitSec / 60)}分{String(timeLimitSec % 60).padStart(2, "0")}秒
                </span>
              </div>
              <input
                type="range"
                min={180}
                max={1800}
                step={60}
                value={timeLimitSec}
                onChange={(e) => setBattleMode({ timeLimitSec: Number(e.target.value) })}
              />
            </div>
            <div className="dbg-k">
              <b>{attacker === "blue" ? "RED" : "BLUE"}</b> が防御側で、開始時点で全拠点を
              保有します。攻撃側は制限時間内に過半数を奪って保持しなければ負けです。
              勝利条件が左右で違う唯一の型なので、点対称の担保(仕様 §2/§13)は
              この型では意味を持ちません。
            </div>
          </>
        )}
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
        <div className="ov-sec-title">
          拠点(仕様 §12)
          <span className="dbg-k"> {objectives.length}個</span>
        </div>
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
            <label className="dep-obj-r" title="確保判定の半径 m(小さすぎると誰も円を踏めない)">
              <span className="dbg-k">r</span>
              <input
                type="number"
                min={2}
                max={40}
                step={1}
                value={Math.round(o.radius)}
                onChange={(e) => setObjField(i, { radius: Number(e.target.value) })}
              />
            </label>
            <button
              type="button"
              className="btn-x"
              onClick={() => removeObjective(i)}
              title={`${o.label} を削除`}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => addObjective()}>
          ＋ 拠点を追加
        </button>
        <div className="dbg-k">
          追加した拠点は掴んだ状態になります。そのまま地図をクリックすると移動、
          <b>×</b> で削除。半径は確保判定の円で、既定は小拠点の6mです。
        </div>
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

/**
 * 後援部隊の設定(`[v7.0]`)。**暫定仕様** — 数・規模・出現位置は相談のうえ確定する前提で、
 * いまは値を自由に変えて試せるようにしてある。
 */
function ReinforcementEditor({
  value,
  onChange,
}: {
  value: ReinforcementSpec;
  onChange: (patch: Partial<ReinforcementSpec>) => void;
}) {
  return (
    <div className="dep-reinf">
      <div className="dbg-slider">
        <span className="dbg-k">回数 {value.calls}</span>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={value.calls}
          onChange={(e) => onChange({ calls: Number(e.target.value) })}
        />
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">規模</span>
        <div className="seg">
          {(["squad", "platoon"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={value.size === k ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => onChange({ size: k })}
            >
              {k === "squad" ? "分隊(9名)" : "小隊(29名)"}
            </button>
          ))}
        </div>
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">到着まで {value.delaySec}秒</span>
        <input
          type="range"
          min={15}
          max={300}
          step={15}
          value={value.delaySec}
          onChange={(e) => onChange({ delaySec: Number(e.target.value) })}
        />
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">出現位置</span>
        <div className="seg">
          {(["rear", "edge"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={value.entry === k ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => onChange({ entry: k })}
              title={k === "rear" ? "中隊の指揮所(無ければ負傷者集合点)" : "自陣側の盤の縁"}
            >
              {k === "rear" ? "後方" : "盤端"}
            </button>
          ))}
        </div>
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">
          AIの要請 {value.autoCallBelow > 0 ? `戦力${Math.round(value.autoCallBelow * 100)}%割れ` : "しない"}
        </span>
        <input
          type="range"
          min={0}
          max={0.9}
          step={0.05}
          value={value.autoCallBelow}
          onChange={(e) => onChange({ autoCallBelow: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
