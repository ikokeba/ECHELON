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
  const [flash, setFlash] = useState(false);
  const seen = useRef(0);

  useEffect(() => {
    if (!lastOrder || lastOrder.tick === seen.current) return;
    seen.current = lastOrder.tick;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [lastOrder]);

  const active =
    control && lastOrder && lastOrder.echelon === control.echelon ? lastOrder : null;
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
