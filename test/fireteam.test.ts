import { describe, it, expect } from "vitest";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { demoCrossingScenario, platoonClashScenario } from "../src/sim/scenario.ts";
import { decayedConfidence } from "../src/sim/belief.ts";
import type { FireteamMode, Side } from "../src/sim/types.ts";

describe("belief decay (spec §5 確定値)", () => {
  it("hits the three fixed points exactly", () => {
    expect(decayedConfidence(0)).toBe(1);
    expect(decayedConfidence(30)).toBeCloseTo(0.8, 10);
    expect(decayedConfidence(90)).toBeCloseTo(0.5, 10);
    expect(decayedConfidence(180)).toBeCloseTo(0, 10);
  });

  it("decays monotonically and never goes negative", () => {
    let prev = 1;
    for (let t = 0; t <= 300; t += 3) {
      const c = decayedConfidence(t);
      expect(c).toBeLessThanOrEqual(prev + 1e-12);
      expect(c).toBeGreaterThanOrEqual(0);
      prev = c;
    }
  });
});

describe("fireteam AI", () => {
  it("starts every fireteam in ADVANCE with an empty picture", () => {
    const w = createWorld(demoCrossingScenario(1));
    expect(w.fireteams.length).toBe(4); // 2 squads x 2 fireteams
    for (const ft of w.fireteams) {
      expect(ft.mode).toBe<FireteamMode>("ADVANCE");
      expect(ft.memory.size).toBe(0);
    }
  });

  it("builds a contact picture and leaves ADVANCE once the enemy is seen", () => {
    const w = createWorld(demoCrossingScenario(1));
    runTicks(w, 900); // 30s
    const engaged = w.fireteams.filter((f) => f.mode !== "ADVANCE");
    expect(engaged.length).toBeGreaterThan(0);
    expect(w.fireteams.some((f) => f.memory.size > 0)).toBe(true);
  });

  it("assigns base-of-fire and maneuver roles in CONTACT (spec §6)", () => {
    // 特定の1ティックを覗くのではなく交戦の経過を通して観測する。
    // どの瞬間に接敵するかは移動技術の選択(小隊長の判断)に左右されるため。
    const w = createWorld(demoCrossingScenario(1));
    const kinds = new Set<string>();
    for (let i = 0; i < 3600; i++) {
      runTicks(w, 1);
      for (const s of w.soldiers) if (s.status === "ok") kinds.add(s.order.kind);
    }
    expect(kinds.has("suppress")).toBe(true);
    expect(kinds.has("maneuver")).toBe(true);
  }, 30000);

  it("drops a contact from the picture as soon as it is confirmed KIA (spec §9)", () => {
    const w = createWorld(demoCrossingScenario(2));
    runTicks(w, 2400);
    for (const ft of w.fireteams) {
      for (const key of ft.memory.keys()) {
        const enemy = w.soldierById.get(Number(key.slice(1)));
        expect(enemy?.status).not.toBe("kia");
      }
    }
  });

  it("never puts an enemy contact in a friendly fireteam's picture (spec §5)", () => {
    const w = createWorld(demoCrossingScenario(4));
    runTicks(w, 1200);
    for (const ft of w.fireteams) {
      for (const c of ft.memory.values()) {
        expect(c.side).not.toBe(ft.side);
      }
    }
  });
});

describe("force symmetry (spec §2, §13)", () => {
  // 陣営バイアスの検証は test/symmetry.test.ts の「陣営ラベル入れ替え」に移した。
  // 勝率の統計より厳密で、地形由来の偏りとも切り分けられるため。


  it("resolves a fight — the crossing does not stalemate", () => {
    const w = createWorld(demoCrossingScenario(9));
    runTicks(w, 7200);
    const casualties = w.soldiers.filter((s) => s.status !== "ok").length;
    expect(casualties).toBeGreaterThan(4);
  }, 30000);
});

describe("break contact は前線を放棄しない (`[v6.1]` 初回テストプレイ指摘)", () => {
  it("接敵後、部隊は自陣スポーン端まで逃げ帰らず前線付近に留まる", () => {
    // platoonClash: blue が z=-32、red が z=+32 から中央(0,0)へ前進して衝突する。
    // 不具合時は「頭数を見ただけで FALLBACK → 集結地点(=スポーン端)へ全面後退 →
    // 前進 → 再後退」を繰り返し、前線が消えていた。
    const w = createWorld(platoonClashScenario(3));
    // 前線＝突撃・制圧に出るライフル隊員の重心。選抜射手(§10 の長射程)と火器分隊
    // (support_by_fire で縦深に留まる)は設計上そもそも前へ出ないので判定から除く。
    const fightingCz = (side: Side): number => {
      const men = w.soldiers.filter(
        (s) =>
          s.side === side &&
          s.status === "ok" &&
          s.fireteamId >= 0 &&
          s.role !== "mg" &&
          !s.quals.designatedMarksman,
      );
      return men.length ? men.reduce((a, s) => a + s.pos.z, 0) / men.length : 0;
    };
    // まだ戦力の残っている(生存者のいる)FTだけを見る。全滅したFTの mode フィールドは
    // 更新されず古い値のまま固まるので、母数に入れない。
    const liveFts = (side: Side) =>
      w.fireteams.filter(
        (f) =>
          f.side === side &&
          w.soldiers.some(
            (s) =>
              s.side === f.side &&
              s.squadId === f.squadId &&
              s.fireteamId === f.ftIndex &&
              s.status === "ok",
          ),
      );
    const modeFrac = (side: Side, mode: string): number => {
      const fts = liveFts(side);
      return fts.filter((f) => f.mode === mode).length / Math.max(1, fts.length);
    };

    const stillAlive = (f: (typeof w.fireteams)[number]) =>
      w.soldiers.some(
        (s) =>
          s.side === f.side &&
          s.squadId === f.squadId &&
          s.fireteamId === f.ftIndex &&
          s.status === "ok",
      );

    // 2秒ごとに 200秒までサンプル。前線位置と、各FTの ROUT 入り/立て直りを追う。
    let worstBlue = 0;
    let worstRed = 0;
    let maxFallback = 0;
    const enteredRout = new Set<number>();
    const exitedRout = new Set<number>();
    for (let t = 0; t < 100; t++) {
      runTicks(w, 2 * 30);
      for (const f of w.fireteams) {
        if (f.mode === "ROUT") enteredRout.add(f.id);
        else if (enteredRout.has(f.id)) exitedRout.add(f.id);
      }
      if (w.victory) break;
      if (t < 10) continue; // 接敵前は前線評価しない
      // 「本当の戦闘」フェーズ = 両軍とも生存FTが3個以上。片方が壊滅寸前になると
      // 残り1〜2個の生存者が下がるだけで割合が跳ねるので、その局面は評価しない。
      if (liveFts("blue").length < 3 || liveFts("red").length < 3) continue;
      worstBlue = Math.max(worstBlue, -fightingCz("blue"));
      worstRed = Math.max(worstRed, fightingCz("red"));
      maxFallback = Math.max(
        maxFallback,
        modeFrac("blue", "FALLBACK"),
        modeFrac("red", "FALLBACK"),
      );
    }

    // blue は -32 方向、red は +32 方向へ逃げる。「スポーン端まで逃げ帰っていない」判定。
    // 閾値はスポーン距離(32m)に対する割合で見る。`[v6.1]` で移動時命中率ペナルティを
    // 上げた(§14 −25%→−40%)ぶん躍進的な後退が深くなり 22→24 に緩めた。
    // `[v6.2]` さらに 24→27。拠点保持のクランプを**最寄り1ユニットだけ**に直した
    // (design AD-36)結果、以前は「たまたま拠点に吸着していた」分隊が本来どおり
    // 脅威へ反応して下がるようになり、前線の踏み込みが 1.6m 深くなったため。
    // 27m はスポーン距離の84%で、依然「前線が消えて全面後退」(30m超)とは別物。
    expect(worstBlue).toBeLessThan(27);
    expect(worstRed).toBeLessThan(27);
    // ほぼ全FTが同時に FALLBACK へ抜ける(=前線が消える)状態にはならない。
    // 数個が同時に躍進的後退するのは正常なので、8割を閾値にする。
    expect(maxFallback).toBeLessThan(0.8);
    // `[v6.1]` 士気崩壊の回復: ROUT に入ったFTは、集結地点まで下がって接敵を切れれば
    // 未処置WIA比率に関係なく立て直る。追い詰められて撃たれ続ける残党1個までは許容し、
    // それ以外はすべて回復していること(旧実装は「WIA50%アンカー」で永久に固まっていた)。
    const stuck = [...enteredRout].filter((id) => {
      if (exitedRout.has(id)) return false;
      const f = w.fireteams.find((x) => x.id === id)!;
      return stillAlive(f); // 全滅したFTの mode は更新されず固まるだけなので除外
    });
    expect(enteredRout.size).toBeGreaterThan(0); // この seed では実際に ROUT が起きる
    expect(stuck.length).toBeLessThanOrEqual(1);
  }, 60000);
});
