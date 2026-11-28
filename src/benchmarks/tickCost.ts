/**
 * Headless per-tick cost of the full simulation (perception, memory, planning, alerts)
 * as the number of zombies grows. Same seeds for isolated and coordinated runs.
 *
 * Mara follows the optimal route from spawn to extraction (one cell every 2 ticks) and
 * fires every `fireEveryTicks` ticks, so agents hear gunshots, pursue and relay alerts.
 * When an episode ends (Mara dies or escapes) a new one starts with a derived seed, until
 * `ticks` ticks have been measured, so every configuration gets the same sample size.
 *
 * Besides time, each run counts how many searches were redundant: a new search by an agent
 * with the same start, goal, algorithm and graph version as its previous search. Those are
 * the searches a PathCache (src/core/algorithms/pathCache.ts) would answer in O(1).
 */
import type { AlgorithmType, GridCoord, HeuristicType, MapDefinition } from '../core/contracts.ts';
import { runAStar } from '../core/algorithms/astar.ts';
import { SeededRng } from '../core/graph/seededRng.ts';
import { WeightedGraph } from '../core/graph/WeightedGraph.ts';
import { SimulationEngine } from '../core/gameplay/SimulationEngine.ts';
import type { AgentSpawnConfig } from '../core/gameplay/scenes.ts';

export interface TickCostCase {
  label: string;
  map: MapDefinition;
}

export interface TickCostOptions {
  zombieCounts: number[];
  repetitions: number;
  ticks: number;
  baseSeed: number;
  fireEveryTicks: number;
  algorithms: Array<{ algorithm: AlgorithmType; heuristic: HeuristicType }>;
}

export const DEFAULT_TICK_OPTIONS: TickCostOptions = {
  zombieCounts: [4, 8, 16, 32, 64],
  repetitions: 3,
  ticks: 200,
  baseSeed: 2026,
  fireEveryTicks: 15,
  algorithms: [
    { algorithm: 'astar', heuristic: 'octile' },
    { algorithm: 'dijkstra', heuristic: 'octile' },
  ],
};

export type TickRow = Record<string, string | number | boolean>;

const ENGAGED = new Set(['investigate', 'pursue', 'alert', 'attack']);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function spawnZombies(map: MapDefinition, graph: WeightedGraph, count: number, rng: SeededRng): AgentSpawnConfig[] {
  const walkable = map.cells.filter((c) => c.walkable).map((c) => ({ row: c.row, col: c.col }));
  const far = walkable.filter(
    (c) => Math.hypot(c.row - map.spawnMara.row, c.col - map.spawnMara.col) >= 8 && graph.isWalkable(c)
  );
  const pool = far.length >= count ? far : walkable;
  const taken = new Set<string>();
  const agents: AgentSpawnConfig[] = [];
  for (let i = 0; i < count; i++) {
    let cell = rng.pick(pool);
    for (let attempt = 0; attempt < 50 && taken.has(`${cell.row},${cell.col}`); attempt++) cell = rng.pick(pool);
    taken.add(`${cell.row},${cell.col}`);
    agents.push({ id: `z${i}`, role: i % 3 === 2 ? 'pursuer' : 'explorer', position: cell });
  }
  return agents;
}

interface RunResult {
  ticks: number;
  times: number[];
  searches: number;
  redundant: number;
  expanded: number;
  redundantExpanded: number;
  alerts: number;
  alertHops: number;
  engagedSum: number;
  engagedMax: number;
  informedByAlert: number;
  episodes: number;
  defeats: number;
}

function simulate(
  map: MapDefinition,
  zombies: number,
  seed: number,
  coordination: boolean,
  algorithm: AlgorithmType,
  heuristic: HeuristicType,
  options: TickCostOptions
): RunResult {
  const result: RunResult = {
    ticks: 0,
    times: [],
    searches: 0,
    redundant: 0,
    expanded: 0,
    redundantExpanded: 0,
    alerts: 0,
    alertHops: 0,
    engagedSum: 0,
    engagedMax: 0,
    informedByAlert: 0,
    episodes: 0,
    defeats: 0,
  };
  const graph = new WeightedGraph(map);

  while (result.ticks < options.ticks) {
    const episodeSeed = seed + result.episodes * 7919;
    result.episodes++;
    const agents = spawnZombies(map, graph, zombies, new SeededRng(episodeSeed + 404));
    const engine = new SimulationEngine(map, 1, {
      seed: episodeSeed,
      coordinationEnabled: coordination,
      algorithm,
      heuristic,
      customAgents: agents,
      maxLogs: 20,
    });
    const route: GridCoord[] = runAStar(engine.getGraph(), map.spawnMara, map.extractionPoint, 'octile').path;
    const signature = new Map<string, string>();
    const lastKey = new Map<string, string>();
    const informed = new Set<string>();

    for (let tick = 1; result.ticks < options.ticks; tick++) {
      const step = Math.min(route.length - 1, Math.floor(tick / 2));
      if (route[step]) engine.applyCommand({ type: 'moveToCell', cell: route[step], posture: 'walk' });
      if (tick % options.fireEveryTicks === 0) {
        const snap = engine.getSnapshot();
        if (snap.mara.weapon.ammoInMagazine === 0) engine.applyCommand({ type: 'reload' });
        else engine.applyCommand({ type: 'fire', hitAgentId: null });
      }

      const version = engine.getGraph().version;
      const t0 = performance.now();
      const snapshot = engine.step(150);
      result.times.push(performance.now() - t0);
      result.ticks++;

      let engaged = 0;
      for (const agent of snapshot.agents) {
        if (ENGAGED.has(agent.state)) engaged++;
        if (agent.memory?.source === 'alert') informed.add(agent.id);
        const s = agent.lastSearch;
        if (!s) continue;
        const sig = `${s.executionTimeMs}|${s.expandedCount}|${s.totalCost}`;
        if (signature.get(agent.id) === sig) continue;
        signature.set(agent.id, sig);
        result.searches++;
        result.expanded += s.expandedCount;
        const start = s.path[0] ?? agent.position;
        const goal = agent.targetPosition ?? start;
        const key = `${agent.algorithmUsed}|${agent.heuristicUsed}|${start.row},${start.col}|${goal.row},${goal.col}|${version}`;
        if (lastKey.get(agent.id) === key) {
          result.redundant++;
          result.redundantExpanded += s.expandedCount;
        }
        lastKey.set(agent.id, key);
      }
      result.engagedSum += engaged;
      result.engagedMax = Math.max(result.engagedMax, engaged);
      result.alerts += snapshot.activeAlerts.length;
      result.alertHops += snapshot.activeAlerts.reduce((sum, a) => sum + a.hops.length, 0);
      if (snapshot.status !== 'playing') {
        if (snapshot.status === 'defeat') result.defeats++;
        break;
      }
    }
    result.informedByAlert += informed.size;
  }
  return result;
}

export function runTickCostBenchmarks(cases: TickCostCase[], overrides: Partial<TickCostOptions> = {}): TickRow[] {
  const options: TickCostOptions = { ...DEFAULT_TICK_OPTIONS, ...overrides };
  const rows: TickRow[] = [];
  for (const { label, map } of cases) {
    for (const zombies of options.zombieCounts) {
      for (const { algorithm, heuristic } of options.algorithms) {
        for (let rep = 0; rep < options.repetitions; rep++) {
          const seed = options.baseSeed + zombies * 100 + rep;
          for (const coordination of [false, true]) {
            const r = simulate(map, zombies, seed, coordination, algorithm, heuristic, options);
            const sorted = [...r.times].sort((a, b) => a - b);
            const total = r.times.reduce((s, v) => s + v, 0);
            rows.push({
              map: label,
              vertices: map.cells.filter((c) => c.walkable).length,
              zombies,
              algorithm,
              heuristic: algorithm === 'dijkstra' ? 'none' : heuristic,
              mode: coordination ? 'coordinated' : 'isolated',
              seed,
              rep,
              ticks: r.ticks,
              episodes: r.episodes,
              defeats: r.defeats,
              tick_ms_mean: round(total / Math.max(1, r.ticks), 5),
              tick_ms_p50: round(percentile(sorted, 50), 5),
              tick_ms_p95: round(percentile(sorted, 95), 5),
              tick_ms_max: round(sorted[sorted.length - 1] ?? 0, 5),
              searches: r.searches,
              searches_per_tick: round(r.searches / Math.max(1, r.ticks), 4),
              expanded_per_tick: round(r.expanded / Math.max(1, r.ticks), 2),
              redundant_searches: r.redundant,
              redundant_rate: round(r.searches ? r.redundant / r.searches : 0, 4),
              redundant_expanded_share: round(r.expanded ? r.redundantExpanded / r.expanded : 0, 4),
              alerts: r.alerts,
              alert_hops: r.alertHops,
              engaged_mean: round(r.engagedSum / Math.max(1, r.ticks), 3),
              engaged_max: r.engagedMax,
              informed_by_alert_per_episode: round(r.informedByAlert / r.episodes, 3),
            });
          }
        }
      }
    }
  }
  return rows;
}

/** Mean per (map, zombies, algorithm, mode). */
export function summarizeTickCost(rows: TickRow[]): TickRow[] {
  const groups = new Map<string, TickRow[]>();
  for (const row of rows) {
    const key = [row.map, row.zombies, row.algorithm, row.mode].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const avg = (list: TickRow[], k: string): number => list.reduce((s, r) => s + Number(r[k]), 0) / list.length;
  return [...groups.values()].map((list) => ({
    map: list[0].map,
    vertices: list[0].vertices,
    zombies: list[0].zombies,
    algorithm: list[0].algorithm,
    mode: list[0].mode,
    samples: list.length,
    tick_ms_mean: round(avg(list, 'tick_ms_mean'), 5),
    tick_ms_p95: round(avg(list, 'tick_ms_p95'), 5),
    tick_ms_max: round(Math.max(...list.map((r) => Number(r.tick_ms_max))), 5),
    searches_per_tick: round(avg(list, 'searches_per_tick'), 4),
    expanded_per_tick: round(avg(list, 'expanded_per_tick'), 2),
    redundant_rate: round(avg(list, 'redundant_rate'), 4),
    redundant_expanded_share: round(avg(list, 'redundant_expanded_share'), 4),
    engaged_mean: round(avg(list, 'engaged_mean'), 3),
    informed_by_alert_per_episode: round(avg(list, 'informed_by_alert_per_episode'), 3),
    episodes_mean: round(avg(list, 'episodes'), 2),
  }));
}
