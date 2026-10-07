import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  /**
   * `[v7.0]` LM Studio(ローカルLLM)への中継。ブラウザから localhost:1234 を直接叩くと
   * CORS で止まるので、開発サーバの `/lmstudio/*` を LM Studio へ転送する。
   * 転送先は環境変数 `LMSTUDIO_URL` で変えられる(別のPCで動かしている場合など)。
   */
  server: {
    proxy: {
      "/lmstudio": {
        target: process.env.LMSTUDIO_URL ?? "http://localhost:1234",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lmstudio/, ""),
      },
    },
  },
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
     *
     * `[v6.10]` **個々のテストに `60000` を書かないこと。** これらは既定が5秒だった頃の
     * 「引き上げ」だったが、ここが120秒になった時点で静かに「引き下げ」に変わっていた
     * (単独では27秒で終わるテストが、16ファイル並列の負荷で60秒を超えて落ちる)。
     * スライダーの上限と定数が別々に育つのと同じ型 — 同じ1つの数の写しは必ずずれる。
     * これより長い値が要るテストだけ、その場で明示する。
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
