import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./theme.ts";
import "./ui/styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// 配色は `src/theme.ts` の1本しか無い(`[v6.6]`)。CSS の `:root` へ流し込んでから描く。
// 地図(three.js)は同じファイルの数値版を読むので、凡例と地図がずれようがない。
applyTheme(document.documentElement);

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
