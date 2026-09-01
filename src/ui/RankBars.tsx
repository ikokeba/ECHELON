/**
 * 階級章のグリフ(`[v6.6]` — UIレビュー 診断D)。
 *
 * 地図では兵士の円の**上**に置く横棒で、HUDの階層ツリーでも同じ記号を流用する。
 * 点と棒の混在をやめ、**本数と長さ**の2軸だけで4階級を表す:
 *
 *   FTリーダー 短 ×1 / 分隊長 短 ×2 / 小隊長 長 ×2 / 中隊長 長 ×3
 *
 * 地図側の実体は `render/renderer.ts` の `putBar`。片方を変えたら両方直すこと。
 */
export type RankLevel = "fireteam" | "squad" | "platoon" | "company";

const SHAPE: Record<RankLevel, { bars: number; long: boolean }> = {
  fireteam: { bars: 1, long: false },
  squad: { bars: 2, long: false },
  platoon: { bars: 2, long: true },
  company: { bars: 3, long: true },
};

export function RankBars({ level }: { level: RankLevel }) {
  const { bars, long } = SHAPE[level];
  return (
    <span className={long ? "rank-bars rank-long" : "rank-bars rank-short"} aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
