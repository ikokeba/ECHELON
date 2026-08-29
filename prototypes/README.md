# Prototypes

Each file is a **standalone React component** (`export default function …Prototype()`) that
verifies one slice of the design spec (`docs/spec/戦場指揮ゲーム_仕様書_v5統合マスター版.md`).
They are **not** wired into a shared game loop or state.

> **All seven have now been ported into `src/`.** These files are kept as the record of what
> was verified in v5 — useful when checking why an integrated behaviour is shaped the way it
> is. Don't add features here; add them in `src/` and record the decision in the spec.
> The porting notes are in the "Ported to" column below.

Spec parameters are lifted to top-of-file `const`s, each commented with the spec section it
comes from (e.g. `追補3(CASEVAC)`, `追補5(CQB)`). Change a number here only alongside the spec.

| File | Spec chapters | Verifies | Renderer | Ported to |
|---|---|---|---|---|
| `squad-12v12-3ft-autobattle-mock.jsx` | 1, 6, 13 | Squad-combat base: FT-leader AI state machine (`ADVANCE/CONTACT/SEARCH/FALLBACK`), per-soldier orders (`move/hold/suppress/maneuver/retreat/evade`), vision-confidence decay, cover scoring, grid+Dijkstra pathfinding. Confirmed up to 12v12. | three.js | `sim/c2/fireteam.ts`, `sim/cover.ts`, `sim/navgrid.ts`, `sim/belief.ts` |
| `casevac-wia-buddyaid-prototype.jsx` | 9 | KIA/WIA roll, 45s bleed timer, buddy-aid (`assignedAider`), 15s suppress→aid switch threshold. | three.js | `sim/systems/casualties.ts` |
| `casevac-litter-formation-prototype.jsx` | 9 | 2-/4-man litter carry, doctrine carry speeds, "cap whole-squad speed to the litter team" + formation upkeep. | three.js | `sim/systems/litter.ts` |
| `formation-autoselect-prototype.jsx` | 6 | Corridor-width Tier 1–4 formation auto-select (echelon dropped), wall safety clamp (0.45m margin). | three.js | `sim/formation.ts` |
| `cqb-minimal-prototype.jsx` | 7 | 1 room + 1 door: stack → breach → clear, single-file entry stagger (0.6s), 0.3m grid + Dijkstra with wall-crossing edges excluded. | three.js | `sim/cqb.ts`, `sim/c2/cqbDrill.ts`, `sim/navgrid.ts` (composite grid) |
| `mos-balance-simulator.jsx` | 14 | Headless Monte Carlo (3000 battles) on MOS loadout balance (TL/SAW/grenadier/CLS vs uniform). Fixed a tally bug and a first-mover bias during verification. | Recharts (no three.js) | `src/balance/` — rebuilt over the sim's own `rollShot`, reproduces the confirmed table |
| `platoon-command-report-prototype.jsx` | 2, 5, 6 | **Platoon-leader layer** (first attempt at the previously-unimplemented level): simultaneous movement-technique orders to 3 squads, bounding-overwatch support-range constraint, report-confidence decay (30s→80% / 90s→50% / 180s→gone), control measures (CP/PL/OBJ), SALUTE reports. Squads abstracted to one marker each. | HTML canvas 2D (no three.js) | `sim/radio.ts`, `sim/c2/platoon.ts`, `sim/c2/company.ts` |

## Conventions (match these in new prototypes)

- **Coordinates:** X/Z ground plane, Y up. Walls are AABBs `{cx, cz, hw, hd}`.
- **Sim state lives in `useRef`**, stepped inside a `useEffect` `requestAnimationFrame` loop.
  React state is only for HUD/overlay UI.
- **Geometry + pathfinding helpers** (`rayAABB`, `hasLineOfSight`, `collidesWall`, `edgeIsClear`,
  grid + Dijkstra) are currently **copy-pasted into each three.js file**. Extract them into a
  shared module when the integrated game starts — until then, keep the copies in sync.
- **Symmetry rule (spec §2, §13):** friendly and enemy forces run the *same* C2/AI logic; no
  player-favoring branches. Human control replaces an AI decision-maker, it doesn't add abilities.

## Running one

The repo's own toolchain (`npm run dev`) runs the **integrated** game in `src/`, not these.
To run a prototype in isolation you still need a React toolchain with `react`, `three`
(all but two files) and `recharts` (`mos-balance-simulator`) — e.g. drop the file into a
Vite React project as `App.jsx`. In practice the integrated version is the better thing to
look at; these are here for archaeology.
