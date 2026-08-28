# ECHELON

Working repo for a top-down, large-scale squad-tactics game (working title:
*見下ろし型・大規模分隊戦術ゲーム(仮)*). It blends the Fire-and-Movement squad logic of
*Full Spectrum Warrior*, the simultaneous large-scale battles of PS2 *Star Wars: Battlefront*,
the any-unit hot-swap of *Battlefield 2: Modern Combat*, and the top-down vision/damage model
of *Door Kickers* — over a doctrinally accurate 5-tier chain of command (company → platoon →
squad → fire team → soldier), with AI running every unit a human isn't currently controlling.

**Phase: design + prototyping.** Integration of the prototype mocks into one game state +
loop has started under `src/` (see `docs/design/`).

## Layout

| Path | Contents |
|---|---|
| `docs/spec/` | The design spec. `戦場指揮ゲーム_仕様書_v5統合マスター版.md` is the single source of truth — the merge of the former v3 body + v5 addenda. All future spec edits go here. |
| `docs/design/` | Engineering notes for the integration: tech stack, architecture, open questions. `00-integration-architecture.md` first. |
| `prototypes/` | Standalone React component mocks, one per verified design slice. See `prototypes/README.md`. Kept as reference; being ported into `src/`. |
| `src/` | The integrated implementation. `src/sim/` is the pure deterministic simulation; `src/render/` is the three.js view; `src/ui/` is the React HUD. |

## Toolchain

Vite + React + TypeScript. `npm install`, then `npm run dev` (app), `npm test` (headless
sim tests), `npm run lint`, `npm run typecheck`.

## Status

- Verified in prototype: squad-leader ↔ fire-team-leader combat, CASEVAC (WIA/buddy-aid/litter),
  formation auto-select, CQB room entry, MOS balance. Platoon level has a first prototype.
- Company-commander layer is designed in the spec but not yet prototyped.
- Integrated implementation (`src/`) runs a squad-vs-squad autobattle: bounding overwatch →
  contact → base-of-fire + maneuver → casualties, force-symmetric and deterministic.
- Buddy-aid treatment time — formerly the one open spec conflict — is **resolved `[v6]`** in
  favour of the FT-level MOS 2-tier model (3s / 1.5s).
