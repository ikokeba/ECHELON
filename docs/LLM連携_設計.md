# LLM 連携の設計(通信口) `[v7.0]`

ローカルの LLM(LM Studio)に、ECHELON の指揮官を1人受け持たせるための**通信口**の設計。
今回作ったのは「状況を渡して命令を受け取る」配管までで、LLM にどう戦わせるか
(プロンプトの工夫・モデル選び)はこの上で試していく前提。

- 実装: `src/llm/`(プロトコル・観測・命令・LM Studio クライアント・セッション)
- ヘッドレス実行: `npm run llm`(`src/tools/llmBattle.ts`)
- 画面から: デバッグパネル(キー `H`)の「LLM 接続(LM Studio)」
- テスト: `test/llm.test.ts`

---

## 1. 位置づけ — LLM は「座席に座る人間」と同じ

仕様 §4 のホットスワップは「人間は AI の意思決定者を**置き換える**のであって、能力を
足さない」という原則で作られている。LLM もこの原則にそのまま乗せる。

```
            ┌──────────── シミュレーション(src/sim、決定論的) ────────────┐
            │  中隊長AI   小隊長AI   分隊長AI   FTリーダーAI   …          │
            │     ▲          ▲                                           │
            │     │ 座席に就いたノードはAIが止まる(aiSuppressed)        │
            └─────┼──────────┼───────────────────────────────────────────┘
                  │          │
     人間(world.control)  エージェント(world.agentSeats[])
                               │
                       src/llm/session.ts
                     観測 ▼          ▲ 命令
                    LM Studio(OpenAI 互換 API)
```

- 座席は `world.agentSeats` に入る。人間の操作枠 `world.control` とは**別**なので、
  人間が別の部隊をホットスワップしても LLM の座席は外れない。
- 座席に就いたノードは AI が止まり(`control.ts` の `aiSuppressed`)、LLM が出した
  命令だけで動く。座席を外せば AI が**現在の状態のまま**判断を再開する(仕様 §4)。
- 座れるのは **中隊長・小隊長・分隊長** の3階層。FTリーダーと兵士は 0.3 秒周期の
  反射(遮蔽へ飛び込む・撃ち返す)が仕事で、数秒かかる LLM の応答には向かない。

## 2. 守っている一線(3つ)

| # | 一線 | 実装 | テスト |
|---|---|---|---|
| 1 | **情報階層を迂回しない**(仕様 §5) | 観測の敵情報は、座席の指揮官の `belief` だけ。中隊長・小隊長は無線で届いた遅れて粗い像、分隊長は麾下FTの視界の合算。真の敵位置は渡さない | 観測の接触がすべて belief と一致すること |
| 2 | **能力を足さない**(仕様 §4) | 命令の適用は `sim/playerOrders.ts` の**人間と同じ関数**。出せる命令の種類も AI 指揮官が出しているもの(任務 seize / support_by_fire / screen 等)だけ | 座席がある間は AI に上書きされない / 外すと AI が再開する |
| 3 | **陣営を名前で渡さない**(仕様 §2/§13) | 観測の中の陣営は `"own"` / `"enemy"`。青に座っても赤に座っても同じ形の盤面に見える | 陣営ラベルを入れ替えた盤面で、反対側の座席に**完全に同じ観測**が届くこと |

## 3. やり取りの形(プロトコル `echelon-llm/0.2`)

型の定義は `src/llm/protocol.ts`。

### 3.1 観測(シム → LLM)

```jsonc
{
  "protocol": "echelon-llm/0.2",
  "timeSec": 84.0, "tick": 2520,
  "you": {
    "echelon": "company", "unit": 0, "name": "中隊長",
    "commanderAlive": true,                 // 指揮官が倒れて誰も継げなければ false(命令は通らない)
    "mission": { "kind": "seize", "target": { "x": 0, "z": 0 } },
    "advanceDir": { "x": 0, "z": 1 }        // 前進方向(敵の方角の目安)
  },
  "map": {
    "bounds": { "minX": -220, "maxX": 220, "minZ": -170, "maxZ": 170 },   // +X=東 / +Z=南
    "objectives": [
      { "id": 1, "label": "OBJ BRAVO", "pos": {"x":0,"z":0}, "radius": 3,
        "owner": null, "progress": 0.35, "progressBy": "own", "contested": false }
    ]
  },
  "subordinates": [                         // 麾下。unit を命令に使う
    { "unit": 0, "kind": "platoon", "name": "1小隊", "pos": {"x":-40,"z":-60},
      "effective": 27, "total": 36, "ageSec": 6.2,      // 無線報告の古さ
      "mission": { "kind": "seize", "target": {"x":-78,"z":-13} } }
  ],
  "contacts": [                             // 把握している敵(belief。真の位置ではない)
    { "pos": {"x":12.5,"z":40.1}, "posError": 9.4, "confidence": 0.82, "ageSec": 21.0, "count": 1 }
  ],
  "reinforcement": { "callsLeft": 1, "size": "squad", "delaySec": 90, "pendingEtaSec": [] },  // 要請できる座席のみ
  "fireSupport": { "roundsLeft": 9, "roundsPerMission": 3, "cooldownSec": 0, "inFlightEtaSec": null,
    "commandPost": {"x":0,"z":-150}, "minRange": 40, "maxRange": 400, "dangerClose": 45,
    "timeOfFlightSec": 9 },               // 迫撃砲。中隊長の座席で、火力支援を持つ中隊のみ `[v7.2]`
  "victory": null,
  "commands": [ { "type": "move", "description": "…" }, … ],   // この座席で使える命令の説明
  "lastResult": [ "#0 assign unit 0 seize (-78,-13): 受理" ]   // 前回の命令の処理結果
}
```

- 座標は 0.1m に丸める(トークン節約。判断には効かない粒度)。接触は確度の高い順に最大24件。
- `lastResult` は前回の応答をどう処理したか。却下された命令の理由も入るので、
  小さなモデルでも次の応答で自分の誤りを直せる。

### 3.2 応答(LLM → シム)

```json
{ "intent": "中央を主攻、両翼は支援射撃", "commands": [
  { "type": "assign", "unit": 1, "mission": "seize", "target": { "x": 0, "z": 0 } },
  { "type": "assign", "unit": 0, "mission": "support_by_fire", "target": { "x": 0, "z": 0 } },
  { "type": "reinforce" }
] }
```

| type | 座席 | 意味 | 通る関数(人間と共通) |
|---|---|---|---|
| `move` | 全階層 | 自分の部隊の目標地点を変える | `orderControlledTo` |
| `assign` | 中隊長 / 小隊長 | 麾下1部隊に任務(seize / support_by_fire / screen)を下ろす | `assignPlatoonMission` / `assignSquadMission` |
| `casevac` | 分隊長 | 止血済みの負傷者を後送する(仕様 §9) | `orderCasevac` |
| `reinforce` | 陣営の最上位 | 後援部隊を要請する(回数に上限) | `orderReinforcement` |
| `fire_mission` | 中隊長 | 迫撃砲の射撃を地点へ要請する(`[v7.2]`)。却下されたら理由が `lastResult` に返る | `orderFireMission` → `requestFireMission`(AIの中隊長と共通) |
| `hold` | 全階層 | 何もしない(現在の命令を続ける) | — |

- 応答の JSON Schema は `RESPONSE_SCHEMA`。LM Studio の構造化出力
  (`response_format: { type: "json_schema" }`)に渡すので、文法制約で JSON が崩れにくい。
- **LLM の出力は信用しない入力として扱う**(`commands.ts`)。`<think>` タグ・コードフェンス・
  前置きの文章は剥がす。形の崩れた命令は1件ずつ捨てて理由を返す。座標は盤面の内側へ収める。
  1回に8件まで。座席の階層で出せない命令・麾下にいない部隊は却下する。

## 4. 時間の扱い

| 回し方 | 使う場所 | 時間 | 再現性 |
|---|---|---|---|
| `session.poll(world)` 非同期 | 画面(`ui/runtime.ts` が毎フレーム) | 問い合わせ中も流れる。**LLM が考えている時間 = 命令が届くまでの遅れ** | なし(応答の到着がフレームに依存) |
| `session.decideNow(world)` 同期 | `npm run llm` | 応答が届くまで止まる | **あり**。シムは決定論的なので、モデルの出力が同じなら戦闘も同じ |

- 問い合わせは `intervalSec`(シム時間)おき。命令の適用は常にティックとティックのあいだ。
- 1回の問い合わせには上限時間(既定 60 秒)がある。繋がらない・遅すぎるときはその回を
  「命令なし」として記録し、シムは止めない(座席の部隊は直前の命令を続ける)。

## 5. LM Studio との接続

LM Studio の「Developer → Local Server」を起動すると、OpenAI 互換の API が
`http://localhost:1234/v1` に出る。使うのは2本だけ。

| API | 用途 |
|---|---|
| `GET /v1/models` | 読み込まれているモデルの一覧。モデル名を指定しなければ先頭を使う。疎通確認にも使う |
| `POST /v1/chat/completions` | system = 指示文(`prompt.ts`)、user = 観測 JSON。応答の `choices[0].message.content` を解釈する |

- 構造化出力に対応していない版で 400 が返ったら、以後は付けずに送り直す。
- **ブラウザからは CORS で直接は叩けない**ので、開発サーバ(Vite)が `/lmstudio/*` を
  LM Studio へ中継する(`vite.config.ts`)。転送先は環境変数 `LMSTUDIO_URL` で変えられる
  (例: 別の PC で LM Studio を動かしている場合 `LMSTUDIO_URL=http://192.168.1.10:1234 npm run dev`)。
- `npm run llm` は Node から直接繋ぐので中継は要らない(`--url` で指定)。

## 6. 試し方

```bash
# 1) 配線だけ確認(LLM なし。規則で動く参照エージェント)
npm run llm -- --mock --sec 120

# 2) LM Studio に青の中隊長を任せる(20秒おきに判断、10分間)
npm run llm

# 3) 小隊長の座席・15秒おき・モデル指定・生の出力も表示
npm run llm -- --echelon platoon --interval 15 --model qwen2.5-7b-instruct --verbose
```

画面から試すときは、`npm run dev` → キー `H` でデバッグパネル → 「LLM 接続」で
陣営・座席・間隔を選び「接続して座席を任せる」。「疎通確認」でモデル一覧が出れば繋がっている。

## 7. まだやっていないこと(次の候補)

ロードマップ([`docs/ロードマップ.md`](ロードマップ.md))へ移した。LLM まわりは C-23〜C-27(複数の座席、対戦と評価、観測の要約、会話の履歴、ツール呼び出し形式)。
迫撃砲の要請(旧 S-5)は `[v7.2]` で実装した(プロトコル `echelon-llm/0.2`)。
