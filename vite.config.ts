import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@sim": fileURLToPath(new URL("./src/sim", import.meta.url)),
      "@render": fileURLToPath(new URL("./src/render", import.meta.url)),
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
    /**
     * このリポジトリのテストは**ほぼ全てが実シミュレーションの実行**で、多くが
     * `companyClashScenario`(建物78棟・両軍224名)の世界構築から始まる。構築だけで
     * 2〜3秒かかるので、vitest 既定の5秒は最初から足りていない — 機械が空いている
     * ときだけ通り、他の作業と並走すると一斉にタイムアウトする(実際に踏んだ)。
     *
     * ここを上げるのは判定を緩めることではない。**アサーションは1つも変えていない**。
     * 個々の長時間テスト(300秒ぶんの実行など)は各自でさらに長い値を指定している。
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
    /**
     * `[v6.9]` 既定の `forks` プールから `threads` へ。**判定は何も変えていない** —
     * 変わるのはワーカの走らせ方だけ。
     *
     * 症状: 全277件が緑なのに `npm test` が終了コード1を返していた。内訳は
     * 「Unhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"」が5件で、
     * 5件は**合計60秒を超えるテストファイルの数と厳密に一致する**
     * (clearInZone 121s / symmetry 96s / posture 89s / objectives 75s / company 64s)。
     * このリポジトリのテストは実シミュレーションの同期ループなので、ワーカは
     * ファイルを走らせているあいだイベントループをほぼ手放さない。fork 側の
     * IPC(v8シリアライズ + process.send)では、進捗報告の応答が birpc の60秒に
     * 間に合わない。並列度の問題ではなく、`posture.test.ts` を単独で走らせても再現する。
     *
     * `threads` の MessagePort では同じ待ち時間でも応答が返り、症状が消える。
     * `src/sim` は純粋(グローバル状態も Math.random も持たない)なので、
     * ワーカ間でプロセスを共有しても結果は変わらない — 実際、同じ277件が同じ結果で通る。
     */
    pool: "threads",
  },
});
