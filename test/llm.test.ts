import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "../src/sim/world.ts";
import { runTicks } from "../src/sim/step.ts";
import { companyClashScenario } from "../src/sim/scenario.ts";
import { DEFAULT_FORCE } from "../src/sim/force.ts";
import { buildObservation } from "../src/llm/observe.ts";
import { applyResponse, extractJson, parseResponse } from "../src/llm/commands.ts";
import { ruleAgent } from "../src/llm/agent.ts";
import { createLmStudioAgent } from "../src/llm/lmstudio.ts";
import { createLlmSession } from "../src/llm/session.ts";
import { MAX_COMMANDS, PROTOCOL_VERSION, type AgentSeat } from "../src/llm/protocol.ts";
import type { Scenario, Side } from "../src/sim/types.ts";

/**
 * LLM 通信口(`[v7.0]` src/llm/、設計は docs/LLM連携_設計.md)。
 *
 * 守るべき一線は3つで、それぞれをここで固定する:
 *   1. 観測に入る敵情報は座席の指揮官の belief だけ(仕様 §5)
 *   2. 出せる命令は人間・AIと同じもの、同じ経路(仕様 §4)
 *   3. 観測は陣営の名前を含まず、青でも赤でも同じ形になる(仕様 §2/§13)
 */

const platoonForce = (): Record<Side, { scale: "platoon" } & typeof DEFAULT_FORCE> => ({
  blue: { ...DEFAULT_FORCE, scale: "platoon" },
  red: { ...DEFAULT_FORCE, scale: "platoon" },
});

describe("観測(observe.ts)", () => {
  it("敵情報は belief だけで、陣営の名前を含まない", () => {
    const w = createWorld(companyClashScenario(1));
    runTicks(w, 2400);
    const co = w.companies.find((c) => c.side === "blue")!;
    const obs = buildObservation(w, { side: "blue", echelon: "company", unitId: co.companyId })!;
    const believed = [...co.belief.values()].filter((c) => c.confidence > 0);
    expect(obs.contacts.length).toBe(Math.min(24, believed.length));
    // 観測の接触は1件残らず belief のどれかと一致する(真の敵位置から作っていない)
    for (const c of obs.contacts) {
      expect(
        believed.some(
          (b) => Math.abs(b.pos.x - c.pos.x) < 0.06 && Math.abs(b.pos.z - c.pos.z) < 0.06,
        ),
      ).toBe(true);
    }
    const text = JSON.stringify(obs);
    expect(text).not.toMatch(/"(blue|red)"/);
    expect(obs.subordinates.length).toBe(w.platoons.filter((p) => p.side === "blue").length);
  });

  it("陣営ラベルを入れ替えた盤面では、反対側の座席に同じ観測が届く", () => {
    const flip = (s: Side): Side => (s === "blue" ? "red" : "blue");
    const swap = (sc: Scenario): Scenario => {
      for (const s of sc.soldiers) s.side = flip(s.side);
      for (const p of sc.fireteamPlans ?? []) p.side = flip(p.side);
      for (const p of sc.squadPlans ?? []) p.side = flip(p.side);
      for (const p of sc.platoonPlans ?? []) p.side = flip(p.side);
      for (const p of sc.companyPlans ?? []) p.side = flip(p.side);
      if (sc.ccp) sc.ccp = { blue: sc.ccp.red, red: sc.ccp.blue };
      return sc;
    };
    const a = createWorld(companyClashScenario(2, platoonForce()));
    const b = createWorld(swap(companyClashScenario(2, platoonForce())));
    runTicks(a, 1500);
    runTicks(b, 1500);
    for (const echelon of ["platoon", "squad"] as const) {
      const pick = (w: typeof a, side: Side) =>
        echelon === "platoon"
          ? w.platoons.find((p) => p.side === side)!.platoonId
          : w.squads.find((s) => s.side === side)!.squadId;
      const oa = buildObservation(a, { side: "blue", echelon, unitId: pick(a, "blue") });
      const ob = buildObservation(b, { side: "red", echelon, unitId: pick(b, "red") });
      expect(ob).toEqual(oa);
    }
  });
});

describe("応答の解釈(commands.ts)", () => {
  it("推論タグ・コードフェンス・前置きの文章があっても JSON を取り出す", () => {
    const raw =
      '<think>敵は東。まず…</think>\n了解。\n```json\n{"intent":"東へ","commands":[{"type":"hold"}]}\n```';
    expect(extractJson(raw)).toEqual({ intent: "東へ", commands: [{ type: "hold" }] });
    expect(extractJson('前置き {"commands":[]} 後書き')).toEqual({ commands: [] });
    expect(extractJson("JSONではない")).toBeUndefined();
  });

  it("壊れた命令は1件ずつ捨てて理由を返し、上限を超えた分は切る", () => {
    const p = parseResponse({
      intent: "x",
      commands: [
        { type: "move", target: { x: 1, z: 2 } },
        { type: "move" },
        { type: "assign", unit: 1, mission: "seize", target: { x: 0, z: 0 } },
        { type: "assign", unit: "a", mission: "dance", target: { x: 0, z: 0 } },
        { type: "fly" },
        ...Array.from({ length: MAX_COMMANDS }, () => ({ type: "hold" })),
      ],
    });
    expect(p.response!.commands.map((c) => c.type)).toEqual([
      "move",
      "assign",
      "hold",
      "hold",
      "hold",
    ]);
    expect(p.errors.length).toBe(4);
    expect(parseResponse("nope").response).toBeNull();
  });
});

describe("命令の適用(人間と同じ経路、仕様 §4)", () => {
  it("中隊座席の assign は小隊の任務を書き換え、座席がある間はAI中隊長に上書きされない", () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "blue")!;
    const seat: AgentSeat = { side: "blue", echelon: "company", unitId: co.companyId };
    const pl = w.platoons.find((p) => p.side === "blue")!;
    const target = { x: 50, z: 40 };

    const session = createLlmSession({ seat, agent: ruleAgent(), intervalSec: 1000 });
    session.attach(w);
    const r = applyResponse(w, seat, {
      commands: [{ type: "assign", unit: pl.platoonId, mission: "support_by_fire", target }],
    });
    expect(r[0]).toMatch(/受理/);
    runTicks(w, 300);
    expect(pl.mission).toEqual({ kind: "support_by_fire", target });

    // 座席を外せば、AI中隊長が現在の状態から判断を再開して書き換える(仕様 §4)
    session.detach(w);
    runTicks(w, 600);
    expect(pl.mission).not.toEqual({ kind: "support_by_fire", target });
  });

  it("階層で出せない命令・麾下にいない部隊は却下して理由を返す", () => {
    const w = createWorld(companyClashScenario(1, platoonForce()));
    const sq = w.squads.find((s) => s.side === "blue")!;
    const r = applyResponse(
      w,
      { side: "blue", echelon: "squad", unitId: sq.squadId },
      {
        commands: [
          { type: "assign", unit: 0, mission: "seize", target: { x: 0, z: 0 } },
          { type: "move", target: { x: 1e6, z: 0 } },
        ],
      },
    );
    expect(r[0]).toMatch(/assign を出せない/);
    // 盤外の目標は盤面の内側へ収めて受理する
    expect(r[1]).toMatch(/受理/);
    expect(sq.objective.x).toBeLessThanOrEqual(w.bounds.maxX);

    const pl = w.platoons.find((p) => p.side === "blue")!;
    const r2 = applyResponse(
      w,
      { side: "blue", echelon: "platoon", unitId: pl.platoonId },
      {
        commands: [{ type: "assign", unit: 999, mission: "seize", target: { x: 0, z: 0 } }],
      },
    );
    expect(r2[0]).toMatch(/麾下にいない/);
  });
});

describe("セッション(session.ts)", () => {
  it("規則エージェントで、観測 → 応答 → 命令 → 次の観測の lastResult まで一巡する", async () => {
    const w = createWorld(companyClashScenario(1));
    const co = w.companies.find((c) => c.side === "red")!;
    const session = createLlmSession({
      seat: { side: "red", echelon: "company", unitId: co.companyId },
      agent: ruleAgent(),
      intervalSec: 5,
    });
    session.attach(w);
    const e = await session.decideNow(w);
    expect(e!.errors).toEqual([]);
    expect(e!.results.some((r) => r.includes("受理"))).toBe(true);
    runTicks(w, 30);
    await session.decideNow(w);
    expect(session.lastObservation!.lastResult).toEqual(e!.results);
  });
});

describe("LM Studio クライアント(lmstudio.ts)", () => {
  it("OpenAI 互換 API を叩き、構造化出力が 400 なら付けずに送り直す", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = JSON.parse(body) as Record<string, unknown>;
        seen.push(json);
        if (json.response_format) {
          res.statusCode = 400;
          res.end("response_format not supported");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '<think>…</think>```json\n{"intent":"保持","commands":[{"type":"hold"}]}\n```',
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const w = createWorld(companyClashScenario(1, platoonForce()));
      const pl = w.platoons.find((p) => p.side === "blue")!;
      const agent = createLmStudioAgent({ baseUrl: `http://127.0.0.1:${port}/` });
      const session = createLlmSession({
        seat: { side: "blue", echelon: "platoon", unitId: pl.platoonId },
        agent,
        intervalSec: 10,
      });
      session.attach(w);
      const e = await session.decideNow(w);
      expect(e!.errors).toEqual([]);
      expect(e!.intent).toBe("保持");
      expect(e!.results[0]).toMatch(/hold/);
      expect(agent.name).toContain("test-model");
      // 1回目は構造化出力つき → 400、2回目は無しで送り直している
      expect(seen.length).toBe(2);
      expect(seen[0]!.response_format).toBeDefined();
      expect(seen[1]!.response_format).toBeUndefined();
      expect(seen[1]!.model).toBe("test-model");
      const messages = seen[1]!.messages as Array<{ role: string; content: string }>;
      expect(messages[0]!.role).toBe("system");
      expect(messages[1]!.content).toContain(`"protocol":"${PROTOCOL_VERSION}"`);
    } finally {
      server.close();
    }
  });

  it("繋がらないときは命令なしで記録し、シムは止まらない", async () => {
    const w = createWorld(companyClashScenario(1, platoonForce()));
    const pl = w.platoons.find((p) => p.side === "blue")!;
    const session = createLlmSession({
      seat: { side: "blue", echelon: "platoon", unitId: pl.platoonId },
      agent: createLmStudioAgent({ baseUrl: "http://127.0.0.1:9", timeoutMs: 2000 }),
      intervalSec: 10,
    });
    session.attach(w);
    const e = await session.decideNow(w);
    expect(e!.errors[0]).toMatch(/通信失敗/);
    expect(e!.results).toEqual([]);
    runTicks(w, 10);
    expect(w.tick).toBe(10);
  });
});
