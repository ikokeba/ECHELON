import { useState } from "react";
import { useLlmStore } from "./llmStore.ts";
import { listModels } from "../llm/lmstudio.ts";
import { AGENT_ECHELONS } from "../llm/protocol.ts";
import { SIM_HZ } from "@sim/constants.ts";

/**
 * LLM 接続(`[v7.0]`)。LM Studio のローカルLLMに、指定した指揮官の座席を任せる。
 * 設計は docs/LLM連携_設計.md。デバッグパネルの1区画として出す。
 *
 * 座席に就いた指揮官はAIが止まり、LLM が人間と同じ命令だけを出す(仕様 §4)。
 * 問い合わせ中も時間は流れる — LLM が考えている時間は「命令が届くまでの遅れ」になる。
 */

const ECHELON_LABEL = { company: "中隊長", platoon: "小隊長", squad: "分隊長" } as const;

export function LlmPanel() {
  const config = useLlmStore((s) => s.config);
  const status = useLlmStore((s) => s.status);
  const setConfig = useLlmStore((s) => s.setConfig);
  const [probe, setProbe] = useState<string>("");

  const test = async (): Promise<void> => {
    setProbe("確認中…");
    try {
      const models = await listModels(config.baseUrl);
      setProbe(models.length ? `OK: ${models.join(", ")}` : "繋がったがモデルが読み込まれていない");
    } catch (e) {
      setProbe(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const last = status.log[0];
  return (
    <div className="ov-sec">
      <div className="ov-sec-title">LLM 接続(LM Studio)</div>
      <div className="dbg-slider">
        <span className="dbg-k">URL</span>
        <input
          className="llm-input"
          value={config.baseUrl}
          disabled={config.enabled}
          onChange={(e) => setConfig({ baseUrl: e.target.value })}
          title="/lmstudio = 開発サーバ経由(LMSTUDIO_URL で転送先を変更可)。直接なら http://localhost:1234"
        />
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">モデル</span>
        <input
          className="llm-input"
          value={config.model}
          placeholder="空なら読み込み済みの先頭"
          disabled={config.enabled}
          onChange={(e) => setConfig({ model: e.target.value })}
        />
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">陣営</span>
        <div className="seg">
          {(["blue", "red"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={config.enabled}
              className={config.side === s ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => setConfig({ side: s })}
            >
              {s === "blue" ? "青" : "赤"}
            </button>
          ))}
        </div>
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">座席</span>
        <div className="seg">
          {AGENT_ECHELONS.map((e) => (
            <button
              key={e}
              type="button"
              disabled={config.enabled}
              className={config.echelon === e ? "seg-btn seg-on" : "seg-btn"}
              onClick={() => setConfig({ echelon: e })}
            >
              {ECHELON_LABEL[e]}
            </button>
          ))}
        </div>
        <input
          className="llm-num"
          type="number"
          min={0}
          value={config.unitIndex}
          disabled={config.enabled}
          onChange={(e) => setConfig({ unitIndex: Math.max(0, Number(e.target.value) || 0) })}
          title="その陣営・階層の何番目の部隊か(0始まり)"
        />
      </div>
      <div className="dbg-slider">
        <span className="dbg-k">間隔 {config.intervalSec}s</span>
        <input
          type="range"
          min={5}
          max={60}
          step={5}
          value={config.intervalSec}
          disabled={config.enabled}
          onChange={(e) => setConfig({ intervalSec: Number(e.target.value) })}
        />
      </div>
      <label className="dbg-chk" title="外すと LLM を使わない規則エージェントで配線だけ確認する">
        <input
          type="checkbox"
          checked={config.useLlm}
          disabled={config.enabled}
          onChange={(e) => setConfig({ useLlm: e.target.checked })}
        />
        <span>LM Studio を使う</span>
      </label>
      <div className="llm-row">
        <button type="button" className="seg-btn" onClick={() => void test()}>
          疎通確認
        </button>
        <button
          type="button"
          className={config.enabled ? "seg-btn seg-on" : "seg-btn"}
          onClick={() => setConfig({ enabled: !config.enabled })}
        >
          {config.enabled ? "切断" : "接続して座席を任せる"}
        </button>
      </div>
      {probe && <div className="llm-note">{probe}</div>}
      {status.error && <div className="llm-note llm-err">{status.error}</div>}
      {config.enabled && (
        <div className="llm-note">
          {status.agentName} {status.busy ? "— 考え中…" : ""}
        </div>
      )}
      {last && (
        <div className="llm-log">
          <div>
            [{(last.tick / SIM_HZ).toFixed(0)}s / {last.latencyMs}ms] {last.intent ?? "(意図なし)"}
          </div>
          {last.results.map((r, i) => (
            <div key={`r${i}`}>{r}</div>
          ))}
          {last.errors.map((r, i) => (
            <div key={`e${i}`} className="llm-err">
              {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
