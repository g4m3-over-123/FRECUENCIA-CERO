# AGENTS.md - Z3R0-FRECUENCY

Architecture and collaboration rules for parallel development with 4 contributors and AI agents.
Read `docs/FASE0.md` first: it explains the integration base every front builds on.

## 1. Exclusive Folder Ownership by Front

- **Integrator (Phase 0 base)**: `src/core/contracts.ts`, `src/core/world/`, `src/game/`, `src/dev/`, `src/main.ts`, `package.json`, `tsconfig.json`, `AGENTS.md`
- **Front A - World, scenes and player**: `src/render/SceneManager.ts`, `src/render/world/`, `src/render/player/`, `public/assets/props/`, `public/maps/map_street.json`, `scripts/generate-street-map.ts`
- **Front B - Characters, weapon and audio**: `src/render/characters/`, `src/render/weapons/`, `src/render/AudioManager.ts`, `public/assets/characters/`, `public/assets/weapons/`, `public/assets/audio/`
- **Front C - Gameplay and agents**: `src/core/agents/`, `src/core/gameplay/`, `tests/agents.test.ts`, `tests/combat.test.ts`
- **Front D - Algorithms, X-ray, HUD and docs**: `src/core/graph/`, `src/core/algorithms/`, `src/benchmarks/`, `src/render/debug/`, `src/ui/`, `docs/`, `tests/algorithms.test.ts`, `public/maps/map_small.json`, `map_medium.json`, `map_large.json`

Each contributor and agent must only modify files inside their assigned directories unless explicitly coordinated.
`tests/fase0.test.ts` belongs to the integrator: if a change breaks it, talk to the integrator instead of editing the test.

## 2. Shared Contracts Governance

- `src/core/contracts.ts` is the shared interface boundary across all roles. Do NOT modify it without prior coordination.
- `src/game/GameLoop.ts` (`SimulationSource`, `FrameState`) and `src/game/views.ts` (`AgentView`, `DebugView`) are the contracts between `main.ts` and each render front. Replace implementations freely, keep these shapes.
- Need a new field? Ask the integrator and, meanwhile, fake it in `src/dev/mockSnapshot.ts`.

## 3. Strict Decoupling Rule (Headless Core)

- Zero imports of `three` inside `src/core/` or `src/benchmarks/`.
- Zero references to `window`, `document`, or browser-only APIs inside `src/core/` or `src/benchmarks/`.
- All graph, pathfinding, agent, gameplay, and benchmark modules must execute cleanly in Node.js (headless).
- The browser talks to the simulation only through `GameCommand` (`moveToCell`, `fire`, `reload`, `decoy`, `barricade`, `interact`).

## 4. Shared Grid Space

- Convention: `col` grows along +X, `row` grows along +Z, Y is up, ground at Y = 0.
- Convert positions only with `src/core/world/gridSpace.ts` (`gridToWorld`, `worldToGrid`). Never compute cell positions by hand.
- A map with a GLB carries `world.asset` (url, offset, scale). The renderer must place the GLB with exactly those values.

## 5. Anti-Omniscience Rule

- No agent inside `src/core/agents/` may read Mara's global position directly.
- Agents may only react to local line-of-sight perception, audible `SoundEvent` data (footsteps, gunshots, decoys, doors), memory decay entries, or received recursive alerts.
- `MockWorld` is exempt (it is fake data for render work, never the game).

## 6. Three.js Animation Rule

- Any duplicated animated character model (such as zombies) MUST be cloned using `SkeletonUtils.clone` and assigned its own dedicated `THREE.AnimationMixer`.

## 7. Assets

- No file in `public/` larger than 15 MB. Check with `npm run check:assets`; compress GLBs before committing.
- Record the source and license of every downloaded asset in `docs/CREDITS.md`.

## 8. Code Hygiene

- Never use emojis in any source code, comments, configuration files, or documentation.
- Keep comments minimalist and clear.
- Verify changes before committing with `npm run build` and `npm test`.
