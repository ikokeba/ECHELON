/**
 * LLM に1部隊を指揮させるヘッドレス対戦(`[v7.0]`)。ブラウザ無しで通信口を試すためのもの。
 *
 *   npm run llm                                  # LM Studio(localhost:1234)に青の中隊を任せる
 *   npm run llm -- --mock                        # LLM無しの規則エージェントで配線だけ確認
 *   npm run llm -- --echelon platoon --unit 0 --interval 15 --sec 300
 *   npm run llm -- --url http://192.168.1.10:1234 --model qwen2.5-7b-instruct
 *
 * 時間は**応答が届くまで止まる**(`session.decideNow`)。モデルの出力が同じなら
 * 戦闘は厳密に再現される。各判断の意図・命令・処理結果と、最後に戦果を表示する。
 *
 * オプション:
 *   --url <URL>         LM Studio の URL(既定 http://localhost:1234)
 *   --model <id>        モデル id(既定: 読み込み済みの先頭)
 *   --map <key>         盤面(company / oldQuarter / bazaar / planned / trench。既定 company)
 *   --scale <s>         規模(squad / platoon / company。既定 company)
 *   --side <blue|red>   LLM が受け持つ陣営(既定 blue)
 *   --echelon <e>       company / platoon / squad(既定 company)
 *   --unit <id>         座席の部隊 id(既定: その階層の先頭)
 *   --interval <s>      何秒おきに判断させるか(シム時間、既定 20)
 *   --sec <s>           戦闘の長さ(シム時間、既定 600)
 *   --seed <n>          乱数種(既定 1)
 *   --shield            両軍とも盾持ちありの編成にする
 *   --mock              LM Studio を使わず規則エージェントで動かす
 *   --verbose           モデルの生の出力も表示する
 */

import { createWorld } from "../sim/world.ts";
import { stepWorld } from "../sim/step.ts";
import { SCENARIOS, type ScenarioKey } from "../sim/scenario.ts";
import { DEFAULT_FORCE, type ForceScale } from "../sim/force.ts";
import { SIM_HZ } from "../sim/constants.ts";
import type { Side } from "../sim/types.ts";
import { ruleAgent } from "../llm/agent.ts";
import { createLmStudioAgent } from "../llm/lmstudio.ts";
import { createLlmSession } from "../llm/session.ts";
import type { AgentEchelon, AgentSeat } from "../llm/protocol.ts";
import type { World } from "../sim/world.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function firstUnit(world: World, side: Side, echelon: AgentEchelon): number | null {
  if (echelon === "company") return world.companies.find((c) => c.side === side)?.companyId ?? null;
  if (echelon === "platoon") return world.platoons.find((p) => p.side === side)?.platoonId ?? null;
  return world.squads.find((s) => s.side === side)?.squadId ?? null;
}

async function main(): Promise<void> {
  const map = (arg("map") ?? "company") as ScenarioKey;
  const scale = (arg("scale") ?? "company") as ForceScale;
  const side = (arg("side") ?? "blue") as Side;
  const echelon = (arg("echelon") ?? "company") as AgentEchelon;
  const intervalSec = Number(arg("interval") ?? 20);
  const totalSec = Number(arg("sec") ?? 600);
  const seed = Number(arg("seed") ?? 1);
  const verbose = flag("verbose");
  if (!SCENARIOS[map]) throw new Error(`--map は ${Object.keys(SCENARIOS).join(" / ")}`);

  const spec = { ...DEFAULT_FORCE, scale, shield: flag("shield") };
  const world = createWorld(SCENARIOS[map].make(seed, { blue: spec, red: { ...spec } }));
  const unitArg = arg("unit");
  const unitId = unitArg !== undefined ? Number(unitArg) : firstUnit(world, side, echelon);
  if (unitId === null) throw new Error(`${side} に ${echelon} が無い(--scale を確認)`);
  const seat: AgentSeat = { side, echelon, unitId };

  const agent = flag("mock")
    ? ruleAgent()
    : createLmStudioAgent({
        baseUrl: arg("url") ?? "http://localhost:1234",
        ...(arg("model") ? { model: arg("model") } : {}),
      });
  const session = createLlmSession({ seat, agent, intervalSec });
  session.attach(world);

  console.log(`盤面 ${map} / 規模 ${scale} / 座席 ${side} ${echelon} #${unitId} / ${agent.name}`);
  console.log(`判断間隔 ${intervalSec}s・戦闘 ${totalSec}s(応答待ちの間は時間を止める)\n`);

  const endTick = Math.round(totalSec * SIM_HZ);
  const step = Math.max(1, Math.round(intervalSec * SIM_HZ));
  while (world.tick < endTick && !world.victory) {
    const e = await session.decideNow(world);
    if (e) {
      const t = (e.tick / SIM_HZ).toFixed(0).padStart(4);
      console.log(`[${t}s] (${e.latencyMs}ms) 意図: ${e.intent ?? "-"}`);
      for (const r of e.results) console.log(`        ${r}`);
      for (const r of e.errors) console.log(`        ! ${r}`);
      if (verbose) console.log(`        raw: ${e.raw.slice(0, 600)}`);
    }
    for (let i = 0; i < step && world.tick < endTick && !world.victory; i++) stepWorld(world);
  }

  const kia = (s: Side) => world.soldiers.filter((x) => x.side === s && x.status === "kia").length;
  const total = (s: Side) => world.soldiers.filter((x) => x.side === s).length;
  console.log(`\n── 結果(${(world.tick / SIM_HZ).toFixed(0)}s)──`);
  console.log(`戦死 BLUE ${kia("blue")}/${total("blue")}  RED ${kia("red")}/${total("red")}`);
  for (const o of world.objectives) {
    console.log(`拠点 ${o.label}: ${o.owner ?? "中立"}${o.contested ? "(係争)" : ""}`);
  }
  console.log(
    world.victory ? `勝者: ${world.victory.winner}(${world.victory.reason})` : "決着つかず",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
