/**
 * LLM 接続パネルの状態(`[v7.0]`)。シムの本体ストア(store.ts)とは分けておく —
 * こちらは「どこへ繋ぐか」という設定と、接続の様子の表示だけで、戦闘の初期条件では
 * ないから(初期条件コード `setupCode.ts` にも入れない。LLM の出力は再現できない)。
 */

import { create } from "zustand";
import type { Side } from "@sim/types.ts";
import type { AgentEchelon } from "../llm/protocol.ts";
import type { SessionLogEntry } from "../llm/session.ts";

export interface LlmConfig {
  /** 接続する(true の間、runtime がセッションを張る) */
  enabled: boolean;
  /** "/lmstudio" なら Vite の開発サーバ経由(CORS 不要)。直接なら "http://localhost:1234" */
  baseUrl: string;
  /** 空なら LM Studio に読み込まれている先頭のモデル */
  model: string;
  side: Side;
  echelon: AgentEchelon;
  /** その陣営・階層の何番目の部隊か(0始まり) */
  unitIndex: number;
  /** 何秒(シム時間)おきに問い合わせるか */
  intervalSec: number;
  /** `false` なら LM Studio を使わず規則エージェント(配線確認用) */
  useLlm: boolean;
}

export interface LlmStatus {
  agentName: string;
  busy: boolean;
  /** 新しい順 */
  log: SessionLogEntry[];
  /** 座席の解決に失敗したなど、セッションを張れなかった理由 */
  error: string | null;
}

interface LlmStore {
  config: LlmConfig;
  status: LlmStatus;
  setConfig: (patch: Partial<LlmConfig>) => void;
  setStatus: (patch: Partial<LlmStatus>) => void;
}

const loadConfig = (): Partial<LlmConfig> => {
  try {
    const raw = localStorage.getItem("echelon.llm");
    return raw ? (JSON.parse(raw) as Partial<LlmConfig>) : {};
  } catch {
    return {};
  }
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  baseUrl: "/lmstudio",
  model: "",
  side: "blue",
  echelon: "company",
  unitIndex: 0,
  intervalSec: 20,
  useLlm: true,
};

export const useLlmStore = create<LlmStore>((set, get) => ({
  // 接続状態そのもの(enabled)は持ち越さない。開いた瞬間に勝手に繋がないため
  config: { ...DEFAULT_LLM_CONFIG, ...loadConfig(), enabled: false },
  status: { agentName: "", busy: false, log: [], error: null },
  setConfig: (patch) => {
    const config = { ...get().config, ...patch };
    set({ config });
    try {
      localStorage.setItem("echelon.llm", JSON.stringify({ ...config, enabled: false }));
    } catch {
      // 保存できなくても動作には影響しない
    }
  },
  setStatus: (patch) => set({ status: { ...get().status, ...patch } }),
}));
