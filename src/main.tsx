import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./theme.ts";
import { useSimStore } from "./ui/store.ts";
import "./ui/styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// 配色は `src/theme.ts` の1本しか無い(`[v6.6]`)。CSS の `:root` へ流し込んでから描く。
// 地図(three.js)は同じファイルの数値版を読むので、凡例と地図がずれようがない。
applyTheme(document.documentElement);

// 初期条件コード(`[v6.18]`)。URL の `#` に載っていれば、描く前に読み込む。
// **LAN内の別端末で同じ URL を開けば同じ条件で立ち上がる**のがこれの主目的。
// 読めないコードは黙って捨てる — 既定の盤面で始まるほうが、起動しないよりよい。
const hash = window.location.hash.replace(/^#/, "");
if (hash) useSimStore.getState().applySetupCode(decodeURIComponent(hash));

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
