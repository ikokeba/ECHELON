import { useEffect, useRef, useState } from "react";
import { useSimStore } from "./store.ts";

/**
 * 移動命令のフィードバック(初回テストプレイ指摘: 命令が出せているか分からない)。
 *
 * `runtime.ts` が `orderControlledTo` の成功時にだけ `lastOrder` を書くので、
 * ここに何か出れば「命令は通った」ことになる。数秒でフェードし、操作中は
 * 現在の目的地を小さく常設表示する(マップ上のマーカーと対応)。
 */
export function OrderToast() {
  const lastOrder = useSimStore((s) => s.lastOrder);
  const control = useSimStore((s) => s.control);
  const armed = useSimStore((s) => s.armed);
  const fire = useSimStore((s) => s.lastOrderResult);
  const [flash, setFlash] = useState(false);
  const [fireFlash, setFireFlash] = useState(false);
  const seen = useRef(0);
  const fireSeen = useRef(0);

  // 迫撃砲・発煙の結果(`[v7.2]`)。通らなかった理由もここに出す
  useEffect(() => {
    if (!fire || fire.seq === fireSeen.current) return;
    fireSeen.current = fire.seq;
    setFireFlash(true);
    const t = setTimeout(() => setFireFlash(false), 3200);
    return () => clearTimeout(t);
  }, [fire]);

  useEffect(() => {
    if (!lastOrder || lastOrder.tick === seen.current) return;
    seen.current = lastOrder.tick;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [lastOrder]);

  const active =
    control && lastOrder && lastOrder.echelon === control.echelon ? lastOrder : null;
  if (armed || (fireFlash && fire)) {
    return (
      <div className="panel order-toast ot-flash">
        <span className="ot-head">
          {armed === "fire"
            ? "◎ 迫撃砲: 撃つ地点をクリック"
            : armed === "smoke"
              ? "◎ 発煙: 焚く地点をクリック"
              : armed === "hold"
                ? "◎ 停止・警戒: 向く方向をクリック"
                : `${fire!.ok ? "◎" : "✕"} ${fire!.text}`}
        </span>
      </div>
    );
  }
  if (!flash && !active) return null;

  const fmt = (n: number) => n.toFixed(0);
  return (
    <div className={`panel order-toast${flash ? " ot-flash" : ""}`}>
      {flash && <span className="ot-head">▶ 移動命令を発行</span>}
      {active && (
        <span className="ot-dest">
          目的地 ({fmt(active.target.x)}, {fmt(active.target.z)})
        </span>
      )}
    </div>
  );
}
