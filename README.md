# ECHELON

Working repo for a top-down, large-scale squad-tactics game (working title:
*見下ろし型・大規模分隊戦術ゲーム(仮)*). It blends the Fire-and-Movement squad logic of
*Full Spectrum Warrior*, the simultaneous large-scale battles of PS2 *Star Wars: Battlefront*,
the any-unit hot-swap of *Battlefield 2: Modern Combat*, and the top-down vision/damage model
of *Door Kickers* — over a doctrinally accurate 5-tier chain of command (company → platoon →
squad → fire team → soldier), with AI running every unit a human isn't currently controlling.

**Phase: playable prototype.** The seven prototype mocks have been merged into one game state
and one simulation loop under `src/`. All five echelons run on the same world.

> **はじめての方へ**: 動かし方は [`docs/はじめかた.md`](docs/はじめかた.md) をどうぞ(日本語)。

## Layout

| Path | Contents |
|---|---|
| `docs/spec/` | The design spec. `戦場指揮ゲーム_仕様書_v5統合マスター版.md` is the single source of truth — the merge of the former v3 body + v5 addenda. All future spec edits go here. |
| `docs/はじめかた.md` | How to run it, for someone who doesn't work with code (Japanese). |
| `prototypes/` | The original standalone React mocks, one per verified design slice. Kept as reference; all have been ported into `src/`. |
| `src/sim/` | The pure deterministic simulation. No three.js, no React, no DOM, no `Math.random`. |
| `src/render/` | three.js top-down view. Reads the world, never mutates it. |
| `src/ui/` | React HUD + Zustand store. |
| `src/balance/` | Headless Monte-Carlo balance harness, running the sim's own combat function. |
| `test/` | Vitest specs — determinism, force symmetry, and one file per subsystem. |

## Toolchain

Vite + React + TypeScript. `npm install`, then:

| Command | What it does |
|---|---|
| `npm run dev` | Start the app (opens on a local port) |
| `npm test` | Run the headless sim tests |
| `npm run balance` | Print the MOS balance table (`npm run balance 5000` for more battles) |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build` | Typecheck + production build |

## What runs today

Four scenarios, switchable in the UI: **squad vs squad**, **platoon vs platoon**,
**company vs company** (91 men a side), and an **urban CQB** map.

- **Five echelons** (spec §2). Platoon and company HQs have bodies, so commanders can be
  killed and command passes down (§12).
- **Tiered information** (§5). A soldier sees; a fireteam leader gets the union of his team's
  vision; a squad leader the union of his fireteams'. Above that it is radio only — delayed,
  decaying, and coarsened one step per hop. The company's picture is measurably older and
  vaguer than the platoon's.
- **Movement** (§6). Traveling / traveling overwatch / bounding overwatch, chosen from the
  commander's *picture* rather than from the truth. Formations auto-select Tier 1–4 from the
  local corridor width.
- **Combat and CASEVAC** (§8, §9), end to end: hit → KIA/WIA → bleed-out → buddy aid →
  litter carry → CCP → evacuation asset → replacement with the same MOS.
- **CQB** (§7). Buildings, doors, a 0.3 m nav grid indoors stitched to the 1.0 m grid outside,
  and the Battle Drill 6 sequence: stack → breach → clear → reorg.
- **§12 in full**: command succession, morale break, objective capture, victory.
- **Hot-swap** (§4) into any echelon. The player gets exactly the orders the AI can issue —
  no more, no less.

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
