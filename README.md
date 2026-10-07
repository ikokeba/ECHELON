# ECHELON

**English** | [日本語](README.ja.md)

> A top-down, large-scale squad-tactics game where you can take over *any* rank in a
> doctrinally accurate chain of command — and the AI runs everyone else.
> (Working title: *見下ろし型・大規模分隊戦術ゲーム(仮)*)

ECHELON blends the Fire-and-Movement squad logic of *Full Spectrum Warrior*, the simultaneous
large-scale battles of PS2 *Star Wars: Battlefront*, the any-unit hot-swap of *Battlefield 2:
Modern Combat*, and the top-down vision/damage model of *Door Kickers* — over a 5-tier chain of
command (company → platoon → squad → fire team → soldier).

**Phase: playable prototype.** The seven prototype mocks have been merged into one game state
and one simulation loop under `src/`. All five echelons run on the same world, in your browser.

![A platoon-level view of a battle in the Old Quarter: BLUE squads converge on the central objective while the HUD shows the echelon tree, force strength and capture progress](docs/media/overview.gif)

*Watching a battle through the platoon leader's eyes. Every unit is AI-controlled; the panels
show the chain of command, force strength and objective-capture progress in real time.*

## What makes it different

### You are not a soldier — you are a *seat* in the chain of command

Pick any company, platoon or squad and take its seat. The AI immediately keeps running everyone
else, and you receive **exactly the orders the AI can issue — no more, no less** (spec §4).
Right-click to give a move order; hand the seat back whenever you like.

![Hot-swapping into 1st Squad: the camera closes in on the squad, the banner switches to MANUAL, and a right-click move order sends the squad along a route](docs/media/hotswap.gif)

*Hot-swap into a squad, then steer it with move orders while the rest of the force keeps fighting.
The orange diamond is the destination; the line is the route.*

### Command is lossy — information flows up the chain, not out of thin air

A soldier sees; a fireteam leader gets the union of his team's vision; a squad leader the union
of his fireteams'. Above that it is radio only — delayed, decaying, and coarsened one step per
hop. The company's picture is measurably older and vaguer than the platoon's. Switch the
viewpoint between company / platoon / squad / "god" and watch the fog of war change.

### From the whole board down to a single soldier

The camera zooms from the full battlefield to the point of contact. Down there you see
individual soldiers, fire teams, tracers, and the markers for suppressed and wounded men —
every one of them simulated, not animated.

![The camera dives from the full board into a firefight: individual soldiers, tracer lines and wounded markers come into view](docs/media/firefight.gif)

*Pulling in from the whole board to the point of contact.*

### Objective capture

An objective is taken by standing in it. A pale disc grows outward from the centre while the
capture progresses, and the ring switches to the capturer's colour when it is complete. If
both sides are inside, the count stops (contested).

![A BLUE fire team enters an objective; a pale-blue disc expands to fill the ring until the capture is complete](docs/media/capture.gif)

*A BLUE fire team holds a room-sized objective while the capture disc fills.*

### Casualties are carried, not deleted

Hit → wounded → buddy aid → a litter team of two or four picks the casualty up and carries him
to the casualty collection point (spec §9). Bearers cannot use their weapons while carrying, and
the squad is weaker for it.

![A RED litter team carries a wounded soldier across the board; the cyan rings mark the bearers](docs/media/casevac.gif)

*A four-man litter team (cyan rings) carrying a wounded soldier to the CCP.*

### Five boards, from alley fights to no-man's-land

Close-quarters streets, a 40 m boulevard you have to cross, staggered new-town blocks, trench
lines — and a regular grid used as the baseline for balance comparisons. The company-level
scenario fields up to **91 men a side**.

## Features

All features below run today. Section numbers refer to the design spec.

- **Five echelons** (§2). Platoon and company HQs have bodies, so commanders can be killed and
  command passes down (§12).
- **Tiered information** (§5), as described above.
- **Movement** (§6). Traveling / traveling overwatch / bounding overwatch, chosen from the
  commander's *picture* rather than from the truth. Formations auto-select Tier 1–4 from the
  local corridor width.
- **Combat and CASEVAC** (§8, §9), end to end: hit → KIA/WIA → bleed-out → buddy aid →
  litter carry → CCP → evacuation asset → replacement with the same MOS.
- **CQB** (§7). Buildings, doors, a 0.3 m nav grid indoors stitched to the 1.0 m grid outside,
  and the Battle Drill 6 sequence: stack → breach → clear → reorg.
- **§12 in full**: command succession, morale break, objective capture, victory.
- **Hot-swap** (§4) into any echelon, as shown above.
- **Flanking** (§6, `[v7.0]`). Squad leaders latch base/maneuver roles for the whole
  engagement and walk the maneuver team around an arc centred on the threat; platoon leaders
  fix the enemy with one squad and send another around the *end* of the enemy line.
- **Shield bearers** (§14, `[v7.0]`, force option). One rifleman per fireteam swaps to a ballistic
  shield and pistol; the team moves in a tight stack behind it.
- **Reinforcements** (§11, `[v7.0]`, force option, provisional numbers). The top commander calls
  them; they arrive after a delay and join the existing chain of command.
- **LLM seat** (§4, `[v7.0]`). A local LLM via LM Studio can take a company/platoon/squad
  commander's seat. It sees only that commander's belief and issues the same orders a human could.

## Quick start

Requires [Node.js](https://nodejs.org/) (LTS).

```sh
npm install
npm run dev      # then open http://localhost:5173/
```

The battle starts in a **planning phase** (time is frozen): read the operation order, then press
the start button. Use the panel on the left to switch **board**, **viewpoint** and **side**, and
the echelon tree on the right to take over a unit. Non-programmers: see
[`docs/はじめかた.md`](docs/はじめかた.md) (Japanese, Windows step-by-step).

| Command | What it does |
|---|---|
| `npm run dev` | Start the app (opens on a local port) |
| `npm test` | Run the headless sim tests |
| `npm run balance` | Print the MOS balance table (`npm run balance 5000` for more battles) |
| `npm run llm` | Let a local LLM (LM Studio) command one echelon in a headless battle (`-- --mock` for a no-LLM wiring check) |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build` | Typecheck + production build |

Stack: Vite + React + TypeScript, three.js for the top-down view, Zustand for UI state.

## Layout

| Path | Contents |
|---|---|
| `docs/spec/` | The design spec. `戦場指揮ゲーム_仕様書_v5統合マスター版.md` is the single source of truth — the merge of the former v3 body + v5 addenda. All future spec edits go here. |
| `docs/はじめかた.md` | How to run it, for someone who doesn't work with code (Japanese). |
| `docs/media/` | The GIFs used in this README. |
| `prototypes/` | The original standalone React mocks, one per verified design slice. Kept as reference; all have been ported into `src/`. |
| `src/sim/` | The pure deterministic simulation. No three.js, no React, no DOM, no `Math.random`. |
| `src/render/` | three.js top-down view. Reads the world, never mutates it. |
| `src/ui/` | React HUD + Zustand store. |
| `src/balance/` | Headless Monte-Carlo balance harness, running the sim's own combat function. |
| `src/llm/` | The LLM "seat": observation/command protocol and an LM Studio client. Design: [`docs/LLM連携_設計.md`](docs/LLM連携_設計.md). |
| `test/` | Vitest specs — determinism, force symmetry, and one file per subsystem. |

## Two invariants the tests hold to

**Force symmetry (§2/§13)** is checked by *swapping the side labels and asserting the outcome
inverts exactly* — not by a win-rate statistic. §13's claim is about the code (no
player-favouring branches), and an exact inversion proves the sim never reads `side`. It also
separates that from terrain advantage, which a win rate conflates. The same idea appears in
the balance harness: give both sides the same RNG stream and identical compositions, and the
battle must end in an exact mutual wipe.

**Determinism.** Same seed, same result. `Math.random` and `Date.now` are banned inside
`src/sim/`, all randomness runs through one seeded stream per force.

## Known gaps

- Individual-variance parameters (§14) exist on every soldier but **nothing reads them yet** —
  the largest remaining distance from the spec.
- Weapon range tiers (§10) are not modelled; everyone shares one detection range.
- The platoon's weapons squad is not in the ToE, so a platoon is 29 rather than ~40 men.
- Scenarios are TypeScript fixtures, not the JSON the architecture calls for.

## License

[MIT](LICENSE)
