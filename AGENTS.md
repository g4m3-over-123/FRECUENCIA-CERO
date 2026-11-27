# AGENTS.md - Z3R0-FRECUENCY

Architecture and collaboration rules for parallel development with 4 contributors and AI agents.

## 1. Exclusive Folder Ownership by Role

- **Rol 3D/HUD**: `src/render/`, `src/ui/`, `index.html`
- **Rol Algoritmos/Benchmarks**: `src/core/graph/`, `src/core/algorithms/`, `src/benchmarks/`
- **Rol Agentes/Gameplay**: `src/core/agents/`, `src/core/gameplay/`
- **Rol Assets/Mapas/Docs**: `public/assets/`, `public/maps/`, `docs/`

Each contributor and agent must only modify files inside their assigned directories unless explicitly coordinated.

## 2. Shared Contracts Governance

- `src/core/contracts.ts` is the shared interface boundary across all roles.
- Do NOT modify `src/core/contracts.ts` without prior coordination across the team.

## 3. Strict Decoupling Rule (Headless Core)

- Zero imports of `three` inside `src/core/` or `src/benchmarks/`.
- Zero references to `window`, `document`, or browser-only APIs inside `src/core/` or `src/benchmarks/`.
- All graph, pathfinding, agent, gameplay, and benchmark modules must execute cleanly in Node.js (headless).

## 4. Anti-Omniscience Rule

- No agent inside `src/core/agents/` may read Mara's global position directly.
- Agents may only react to local line-of-sight perception, audible `SoundEvent` data, memory decay entries, or received recursive alerts.

## 5. Three.js Animation Rule

- Any duplicated animated character model (such as zombies) MUST be cloned using `SkeletonUtils.clone` and assigned its own dedicated `THREE.AnimationMixer`.

## 6. Code Hygiene

- Never use emojis in any source code, comments, configuration files, or documentation.
- Keep comments minimalist and clear.
- Verify changes before committing with `npm run build` and `npm test`.
