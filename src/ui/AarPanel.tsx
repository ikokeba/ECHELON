import { useEffect, useMemo, useState } from "react";
import { useSimStore } from "./store.ts";
import { getAarFrames, getAarMap } from "./runtime.ts";
import { aarMissByEchelon, type AarBelief, type AarFrame } from "@sim/aar.ts";
import type { Side } from "@sim/types.ts";

/**
 * 戦闘の振り返り(AAR、`[v7.2]` ロードマップ S-4)。
 *
 * 見せるのは仕様 §5 の情報の階層: **選んだ指揮官がそのとき信じていた敵の位置**(破線の円 =
 * 位置誤差、濃さ = 確度)と、**実際の敵の位置**(塗りの点)を同じ時刻で並べ、像から実際の
 * 敵までを細い線で結ぶ。線が長いほど像が古い。分隊長 → 小隊長 → 中隊長と上がるほど
 * 線が伸びるのが、このゲームの情報の手触りそのもの。
 *
 * 「最初から再生」は、初期条件と命令の記録から同じ戦闘を作り直して盤面で見せ直す。
 * 記録の終わりで止まり、そこから先は操作を返すので、続きから遊べる。
 */

const ECH_LABEL: Record<AarBelief["echelon"], string> = {
  company: "中隊長",
  platoon: "小隊長",
  squad: "分隊長",
};

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AarPanel() {
  const open = useSimStore((s) => s.aarOpen);
  const toggle = useSimStore((s) => s.toggleAar);
  const viewSide = useSimStore((s) => s.viewSide);
  const replaying = useSimStore((s) => s.replaying);
  const requestReplay = useSimStore((s) => s.requestReplay);
  const tick = useSimStore((s) => s.tick);

  const [frames, setFrames] = useState<readonly AarFrame[]>([]);
  const [idx, setIdx] = useState(-1);
  const [side, setSide] = useState<Side>(viewSide);
  const [who, setWho] = useState<string>("company");

  // 開いている間は取り溜めを読み直す(戦闘が進めばフレームが増える)
  useEffect(() => {
    if (!open) return;
    setFrames([...getAarFrames()]);
  }, [open, tick]);

  const map = getAarMap();
  const frame = frames.length ? frames[idx < 0 || idx >= frames.length ? frames.length - 1 : idx]! : null;

  const candidates = useMemo(
    () => (frame ? frame.beliefs.filter((b) => b.side === side) : []),
    [frame, side],
  );
  const belief =
    candidates.find((b) => `${b.echelon}:${b.unitId}` === who) ??
    candidates.find((b) => b.echelon === "company") ??
    candidates[0] ??
    null;

  if (!open) return null;

  const stats = frame ? aarMissByEchelon(frame, side) : null;
  const enemies = frame ? frame.truth.filter((t) => t.side !== side && !t.down) : [];
  const own = frame ? frame.truth.filter((t) => t.side === side) : [];
  // 選んだ指揮官が把握していない敵(15m 以内に像が無い)
  const unknown = belief
    ? enemies.filter((e) => !belief.contacts.some((c) => Math.hypot(c.pos.x - e.pos.x, c.pos.z - e.pos.z) <= 15))
        .length
    : 0;

  const b = map?.bounds;
  const sideColor = (s: Side) => (s === "blue" ? "var(--blue)" : "var(--red)");

  return (
    <div className="panel aar-panel">
      <div className="ov-head">
        <span>振り返り(AAR)</span>
        <button type="button" className="tc-btn" onClick={toggle} title="閉じる (R)">
          ✕
        </button>
      </div>
      <div className="aar-row">
        <button
          type="button"
          className="seg-btn aar-btn"
          disabled={replaying || tick === 0}
          onClick={requestReplay}
          title="初期条件と命令の記録から、同じ戦闘を最初から盤面で再生する。記録の終わりで止まり、続きから遊べる"
        >
          {replaying ? "再生中…" : "最初から再生"}
        </button>
        <div className="seg aar-side">
          {(["blue", "red"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={side === s ? `seg-btn seg-on seg-${s}` : "seg-btn"}
              onClick={() => setSide(s)}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
        <select
          className="aar-select"
          value={belief ? `${belief.echelon}:${belief.unitId}` : ""}
          onChange={(e) => setWho(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={`${c.echelon}:${c.unitId}`} value={`${c.echelon}:${c.unitId}`}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {!frame || !b ? (
        <div className="dbg-k">戦闘が始まると、2秒ごとに盤面の要約を取ります。</div>
      ) : (
        <>
          <svg
            className="aar-map"
            viewBox={`${b.minX} ${b.minZ} ${b.maxX - b.minX} ${b.maxZ - b.minZ}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <rect x={b.minX} y={b.minZ} width={b.maxX - b.minX} height={b.maxZ - b.minZ} className="aar-ground" />
            {map!.buildings.map((r, i) => (
              <rect key={i} x={r.minX} y={r.minZ} width={r.maxX - r.minX} height={r.maxZ - r.minZ} className="aar-bldg" />
            ))}
            {own.map((t) => (
              <circle key={t.id} cx={t.pos.x} cy={t.pos.z} r={1.4} fill={sideColor(t.side)} opacity={t.down ? 0.3 : 0.55} />
            ))}
            {belief?.contacts.map((c, i) => {
              const near = enemies.reduce<{ x: number; z: number } | null>((best, e) => {
                if (!best) return e.pos;
                return Math.hypot(e.pos.x - c.pos.x, e.pos.z - c.pos.z) <
                  Math.hypot(best.x - c.pos.x, best.z - c.pos.z)
                  ? e.pos
                  : best;
              }, null);
              return (
                <g key={i} opacity={0.25 + 0.75 * c.confidence}>
                  {near && <line x1={c.pos.x} y1={c.pos.z} x2={near.x} y2={near.z} className="aar-miss" />}
                  <circle cx={c.pos.x} cy={c.pos.z} r={Math.max(2.5, c.posError)} className="aar-belief" />
                  <circle cx={c.pos.x} cy={c.pos.z} r={1.2} className="aar-belief-dot" />
                </g>
              );
            })}
            {enemies.map((t) => (
              <circle key={t.id} cx={t.pos.x} cy={t.pos.z} r={1.8} fill={sideColor(t.side)} className="aar-truth" />
            ))}
          </svg>
          <input
            type="range"
            className="aar-slider"
            min={0}
            max={frames.length - 1}
            value={idx < 0 ? frames.length - 1 : Math.min(idx, frames.length - 1)}
            onChange={(e) => setIdx(Number(e.target.value) === frames.length - 1 ? -1 : Number(e.target.value))}
          />
          <div className="aar-row aar-legend">
            <span>{fmt(frame.tick / 30)}</span>
            <span>
              {belief?.name} の像 {belief?.contacts.length ?? 0} 件 / 把握していない敵 {unknown} 名
            </span>
          </div>
          {stats && (
            <div className="aar-stats" title="像からいちばん近い実際の敵までの距離の平均(確度で重みづけ)。上の階層ほど大きい(仕様 §5)">
              {(["squad", "platoon", "company"] as const).map((e) => (
                <span key={e}>
                  {ECH_LABEL[e]} {stats[e].miss === null ? "—" : `${stats[e].miss!.toFixed(0)}m`}
                </span>
              ))}
              <span className="aar-hint">像のずれ</span>
            </div>
          )}
          <div className="hint">
            破線の円 = 信じていた位置(大きさ = 位置誤差、濃さ = 確度)/ 塗りの点 = 実際の敵 /
            細線 = 像のずれ
          </div>
        </>
      )}
    </div>
  );
}
