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
  },
});
