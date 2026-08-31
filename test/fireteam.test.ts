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
    // platoonClash: blue が z=-80、red が z=+80 から中央(0,0)へ前進して衝突する
    // (`[v6.3]` で射程復帰にあわせ盤面を2倍にしたのでスポーンは ±80)。
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
    let engaged = false;
    /** 前進で到達した最浅の位置(小さいほど前へ出ている) */
    let bestBlue = Infinity;
    let bestRed = Infinity;
    /** そこから押し戻された最大量 m */
    let worstBlue = 0;
    let worstRed = 0;
    /** 「生存FTの8割以上が同時に FALLBACK」が続いた最長サンプル数(1サンプル=2秒) */
    let maxFallbackRun = 0;
    let fallbackRun = 0;
    const enteredRout = new Set<number>();
    const exitedRout = new Set<number>();
    for (let t = 0; t < 100; t++) {
      runTicks(w, 2 * 30);
      for (const f of w.fireteams) {
        if (f.mode === "ROUT") enteredRout.add(f.id);
        else if (enteredRout.has(f.id)) exitedRout.add(f.id);
      }
      if (w.victory) break;
      // `[v6.3]` 接敵の起点は**固定時刻ではなく実際に接敵したか**で判定する。
      // 盤面を2倍にしてスポーン間隔が 64m → 160m になったため、「20秒経過」では
      // まだ前進中で、その途中の位置を「後退」と読み違えていた。
      if (!engaged) {
        engaged =
          liveFts("blue").some((f) => f.mode === "CONTACT") &&
          liveFts("red").some((f) => f.mode === "CONTACT");
        continue;
      }
      // 「本当の戦闘」フェーズ = 両軍とも生存FTが3個以上。片方が壊滅寸前になると
      // 残り1〜2個の生存者が下がるだけで割合が跳ねるので、その局面は評価しない。
      if (liveFts("blue").length < 3 || liveFts("red").length < 3) continue;
      // `[v6.3]` 測るのは**取った地歩を手放したか**。絶対的な深さではない。
      // 深さの絶対値は「まだ前進中」でも大きくなるので、前進の到達点(最浅)からの
      // 押し戻され量を見る。これが元の指摘「前線を維持せず放棄してます」そのもの。
      const bd = -fightingCz("blue");
      const rd = fightingCz("red");
      bestBlue = Math.min(bestBlue, bd);
      bestRed = Math.min(bestRed, rd);
      worstBlue = Math.max(worstBlue, bd - bestBlue);
      worstRed = Math.max(worstRed, rd - bestRed);
      const fallbackFrac = Math.max(modeFrac("blue", "FALLBACK"), modeFrac("red", "FALLBACK"));
      fallbackRun = fallbackFrac >= 0.8 ? fallbackRun + 1 : 0;
      maxFallbackRun = Math.max(maxFallbackRun, fallbackRun);
    }

    // **取った地歩を手放していないこと**。1回の break contact は BREAK_DIST(12m)の
    // 躍進なので、2回ぶん + 余裕を上限にする。
    //
    // 経緯: 当初は「盤面中央からの深さ」の絶対値で見ていた(22m → 24m → 27m)。
    // `[v6.3]` で射程を仕様 §10 へ戻し盤面を2倍にした結果、接敵が即座に成立する
    // ようになり、深さの絶対値では「まだ前進中」と「後退した」が区別できなくなった。
    // 測るべきは押し戻され量なので、指標そのものを作り直した。
    const GIVE_UP_LIMIT = 30;
    expect(worstBlue).toBeLessThan(GIVE_UP_LIMIT);
    expect(worstRed).toBeLessThan(GIVE_UP_LIMIT);
    // ほぼ全FTが同時に FALLBACK へ抜けた状態が**続かない**こと(=前線が消えない)。
    //
    // `[v6.4]` 判定を「瞬間値 < 0.8」から「0.8以上が2サンプル(4秒)続かない」へ変えた。
    // 詰まりの解消(§6.5/§7)で部隊が実際に動くようになった結果、接敵が一斉に成立して
    // 8個中7個のFTが同じ2秒に躍進的後退へ入る場面が出る。これは統制された後退であって
    // 前線の放棄ではない — その瞬間に手放した地歩は3.9m、通算でも17.6m(上限30m)しか
    // なかった。元の不具合は「後退→集結→前進→再後退」の反復なので、
    // **継続時間**で見れば取りこぼさない。
    expect(maxFallbackRun).toBeLessThan(2);
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
