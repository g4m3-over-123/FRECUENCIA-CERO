/**
 * Headless benchmark runner for Dijkstra vs A* and recursive alert propagation.
 * Must remain completely decoupled from Three.js and browser DOM APIs.
 *
 * Usage: npm run benchmark -- [--reps=5] [--inner=15] [--seed=2026]
 * Output (src/benchmarks/results/):
 *   benchmark_results.csv   one row per (map, repetition, scenario, algorithm)
 *   benchmark_summary.csv   mean / std grouped by size, scenario and algorithm
 *   alert_results.csv       isolated vs coordinated agents with the same seeds
 *   run_metadata.json       machine, runtime, seeds and parameters
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSnapshot, GridCoord, HeuristicType, MapDefinition } from '../core/contracts.ts';
import { WeightedGraph } from '../core/graph/WeightedGraph.ts';
import { generateCityMap } from '../core/graph/mapGenerator.ts';
import { parseMapDefinition } from '../core/graph/mapLoader.ts';
import { SeededRng } from '../core/graph/seededRng.ts';
import { runAStar } from '../core/algorithms/astar.ts';
import { runDijkstra } from '../core/algorithms/dijkstra.ts';
import { isHeuristicAdmissible } from '../core/algorithms/heuristics.ts';
import type { SearchStats } from '../core/algorithms/shortestPath.ts';
import { propagateAlertRecursive } from '../core/algorithms/alertRecursion.ts';

export interface BenchmarkOptions {
  sizes: number[];
  repetitions: number;
  innerRuns: number;
  baseSeed: number;
  outDir: string;
  quiet: boolean;
}

interface Condition {
  algorithm: 'dijkstra' | 'astar';
  heuristic: HeuristicType | 'none';
}

interface MapCase {
  map: MapDefinition;
  size: number;
  seed: number | null;
  rep: number;
  source: 'generated' | 'file';
}

type Row = Record<string, string | number | boolean>;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const DEFAULT_OPTIONS: BenchmarkOptions = {
  sizes: [20, 32, 50],
  repetitions: 5,
  innerRuns: 15,
  baseSeed: 2026,
  outDir: resolve(HERE, 'results'),
  quiet: false,
};

const CONDITIONS_8: Condition[] = [
  { algorithm: 'dijkstra', heuristic: 'none' },
  { algorithm: 'astar', heuristic: 'octile' },
  { algorithm: 'astar', heuristic: 'euclidean' },
  { algorithm: 'astar', heuristic: 'manhattan' },
];

const CONDITIONS_4: Condition[] = [
  { algorithm: 'dijkstra', heuristic: 'none' },
  { algorithm: 'astar', heuristic: 'manhattan' },
];

const PUBLIC_MAPS: Array<{ file: string; size: number }> = [
  { file: 'map_small.json', size: 20 },
  { file: 'map_medium.json', size: 32 },
  { file: 'map_large.json', size: 50 },
];

function runCondition(graph: WeightedGraph, start: GridCoord, goal: GridCoord, c: Condition): SearchStats {
  return c.algorithm === 'dijkstra'
    ? runDijkstra(graph, start, goal)
    : runAStar(graph, start, goal, c.heuristic as HeuristicType);
}

/** Runs a search several times and keeps the median time to reduce timer noise. */
function measure(
  graph: WeightedGraph,
  start: GridCoord,
  goal: GridCoord,
  c: Condition,
  innerRuns: number
): SearchStats {
  runCondition(graph, start, goal, c);
  const times: number[] = [];
  let last: SearchStats | null = null;
  for (let i = 0; i < innerRuns; i++) {
    last = runCondition(graph, start, goal, c);
    times.push(last.executionTimeMs);
  }
  const result = last as SearchStats;
  return { ...result, executionTimeMs: median(times) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: string | number | boolean): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n') + '\n';
}

function randomWalkable(graph: WeightedGraph, rng: SeededRng): GridCoord {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const p = { row: rng.int(0, graph.height - 1), col: rng.int(0, graph.width - 1) };
    if (graph.isWalkable(p)) return p;
  }
  throw new Error('No walkable cell found');
}

function collectMapCases(options: BenchmarkOptions): MapCase[] {
  const cases: MapCase[] = [];
  for (const size of options.sizes) {
    for (let rep = 0; rep < options.repetitions; rep++) {
      const seed = options.baseSeed + size * 1000 + rep;
      cases.push({ map: generateCityMap(size, size, seed), size, seed, rep, source: 'generated' });
    }
  }
  for (const { file, size } of PUBLIC_MAPS) {
    const path = resolve(ROOT, 'public', 'maps', file);
    if (!existsSync(path)) continue;
    const map = parseMapDefinition(JSON.parse(readFileSync(path, 'utf-8')));
    for (let rep = 0; rep < options.repetitions; rep++) {
      cases.push({ map, size, seed: null, rep, source: 'file' });
    }
  }
  return cases;
}

/** Picks up to `count` cells of the optimal path (avoiding endpoints) to barricade. */
function pickBarricades(path: GridCoord[], count: number): GridCoord[] {
  if (path.length < 5) return [];
  const picks: GridCoord[] = [];
  for (let i = 1; i <= count; i++) {
    const idx = Math.floor((path.length * i) / (count + 1));
    if (idx > 0 && idx < path.length - 1) picks.push(path[idx]);
  }
  return picks;
}

function runPathfindingBenchmarks(options: BenchmarkOptions): Row[] {
  const rows: Row[] = [];
  const cases = collectMapCases(options);

  for (const mc of cases) {
    const pairRng = new SeededRng((mc.seed ?? options.baseSeed) + 77 + mc.rep);
    const baseGraph8 = new WeightedGraph(mc.map, { allowDiagonal: true });
    const baseGraph4 = new WeightedGraph(mc.map, { allowDiagonal: false });

    const pairs: Array<{ name: string; start: GridCoord; goal: GridCoord }> = [
      { name: 'spawn_to_extraction', start: mc.map.spawnMara, goal: mc.map.extractionPoint },
      { name: 'random', start: randomWalkable(baseGraph8, pairRng), goal: randomWalkable(baseGraph8, pairRng) },
    ];

    for (const pair of pairs) {
      for (const [movement, base, conditions] of [
        [8, baseGraph8, CONDITIONS_8],
        [4, baseGraph4, CONDITIONS_4],
      ] as const) {
        const reference = runDijkstra(base, pair.start, pair.goal);
        const barricaded = base.clone();
        const barricades = pickBarricades(reference.path, 3);
        for (const b of barricades) barricaded.setBlocked(b, true);

        for (const [scenario, graph] of [
          ['static', base],
          ['barricade', barricaded],
        ] as const) {
          if (scenario === 'barricade' && barricades.length === 0) continue;
          const optimal = scenario === 'static' ? reference : runDijkstra(graph, pair.start, pair.goal);

          for (const condition of conditions) {
            const r = measure(graph, pair.start, pair.goal, condition, options.innerRuns);
            const ratio = optimal.found && optimal.totalCost > 0 ? r.totalCost / optimal.totalCost : 1;
            rows.push({
              source: mc.source,
              map_id: mc.map.id,
              size: mc.size,
              seed: mc.seed ?? 'file',
              rep: mc.rep,
              pair: pair.name,
              start: `${pair.start.row}:${pair.start.col}`,
              goal: `${pair.goal.row}:${pair.goal.col}`,
              movement,
              scenario,
              barricades: scenario === 'barricade' ? barricades.length : 0,
              algorithm: condition.algorithm,
              heuristic: condition.heuristic,
              admissible:
                condition.heuristic === 'none' ? true : isHeuristicAdmissible(condition.heuristic, movement === 8),
              vertices: graph.walkableCount,
              edges: graph.edgeCount,
              found: r.found,
              path_length: r.path.length,
              total_cost: round(r.totalCost),
              optimal_cost: round(optimal.totalCost),
              cost_ratio: round(ratio, 6),
              is_optimal: Math.abs(r.totalCost - optimal.totalCost) < 1e-6,
              expanded_nodes: r.expandedCount,
              pushes: r.pushCount,
              max_frontier: r.maxFrontierSize,
              reopened: r.reopenedCount,
              time_ms: round(r.executionTimeMs, 5),
            });
          }
        }
      }
    }
  }
  return rows;
}

function summarize(rows: Row[]): Row[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = [row.source, row.size, row.movement, row.scenario, row.algorithm, row.heuristic].join('|');
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const summary: Row[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const nums = (k: string): number[] => list.map((r) => Number(r[k]));
    const times = nums('time_ms');
    summary.push({
      source: first.source,
      size: first.size,
      movement: first.movement,
      scenario: first.scenario,
      algorithm: first.algorithm,
      heuristic: first.heuristic,
      admissible: first.admissible,
      samples: list.length,
      vertices_mean: round(mean(nums('vertices')), 1),
      edges_mean: round(mean(nums('edges')), 1),
      time_ms_mean: round(mean(times), 5),
      time_ms_std: round(std(times), 5),
      expanded_mean: round(mean(nums('expanded_nodes')), 2),
      expanded_std: round(std(nums('expanded_nodes')), 2),
      max_frontier_mean: round(mean(nums('max_frontier')), 2),
      cost_mean: round(mean(nums('total_cost')), 4),
      cost_ratio_mean: round(mean(nums('cost_ratio')), 6),
      optimal_rate: round(list.filter((r) => r.is_optimal === true).length / list.length, 4),
    });
  }
  return summary.sort(
    (a, b) =>
      String(a.source).localeCompare(String(b.source)) ||
      Number(a.size) - Number(b.size) ||
      Number(b.movement) - Number(a.movement) ||
      String(a.scenario).localeCompare(String(b.scenario)) ||
      String(a.algorithm).localeCompare(String(b.algorithm)) ||
      String(a.heuristic).localeCompare(String(b.heuristic))
  );
}

function makeAgent(id: string, position: GridCoord): AgentSnapshot {
  return {
    id,
    role: 'explorer',
    state: 'patrol',
    position,
    targetPosition: null,
    alertDepth: 0,
    memory: null,
  };
}

/**
 * Isolated vs coordinated agents on the same seeded maps and placements.
 * A noise event is heard by agents inside the hearing radius (local perception only).
 * Isolated: only those agents react. Coordinated: they relay a recursive radio alert.
 * Response cost: optimal A* path cost from each informed agent to the noise source.
 */
function runAlertBenchmarks(options: BenchmarkOptions): Row[] {
  const rows: Row[] = [];
  const hearingRadius = 5;
  const commRadius = 7;
  const depths = [1, 2, 4, 8];

  for (const size of options.sizes) {
    const agentCount = Math.max(6, Math.round((size * size) / 40));
    for (let rep = 0; rep < options.repetitions; rep++) {
      const seed = options.baseSeed + size * 1000 + rep;
      const map = generateCityMap(size, size, seed);
      const graph = new WeightedGraph(map);
      const rng = new SeededRng(seed + 991);
      const agents = Array.from({ length: agentCount }, (_, i) => makeAgent(`z${i}`, randomWalkable(graph, rng)));

      // Noise near a random agent so that at least one listener exists.
      const anchor = rng.pick(agents).position;
      let noise = anchor;
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = {
          row: Math.min(size - 1, Math.max(0, anchor.row + rng.int(-3, 3))),
          col: Math.min(size - 1, Math.max(0, anchor.col + rng.int(-3, 3))),
        };
        if (graph.isWalkable(candidate)) {
          noise = candidate;
          break;
        }
      }

      const listeners = agents.filter(
        (a) => Math.hypot(a.position.row - noise.row, a.position.col - noise.col) <= hearingRadius
      );

      const responseCost = (ids: Set<string>): { mean: number; reachable: number; ms: number } => {
        const costs: number[] = [];
        let ms = 0;
        for (const agent of agents) {
          if (!ids.has(agent.id)) continue;
          const r = runAStar(graph, agent.position, noise, 'octile');
          ms += r.executionTimeMs;
          if (r.found) costs.push(r.totalCost);
        }
        return { mean: mean(costs), reachable: costs.length, ms };
      };

      const base = {
        size,
        seed,
        rep,
        agents: agentCount,
        hearing_radius: hearingRadius,
        comm_radius: commRadius,
        listeners: listeners.length,
      };

      const isolatedIds = new Set(listeners.map((a) => a.id));
      const iso = responseCost(isolatedIds);
      rows.push({
        ...base,
        mode: 'isolated',
        max_depth_limit: 0,
        informed: isolatedIds.size,
        informed_ratio: round(isolatedIds.size / agentCount, 4),
        hops: 0,
        reached_depth: 0,
        recursive_calls: 0,
        max_stack_depth: 0,
        propagation_ms: 0,
        responders_reachable: iso.reachable,
        response_cost_mean: round(iso.mean),
        planning_ms: round(iso.ms, 5),
      });

      for (const maxDepth of depths) {
        const informed = new Set<string>(isolatedIds);
        let hops = 0;
        let calls = 0;
        let stack = 0;
        let reachedDepth = 0;
        const t0 = performance.now();
        for (const listener of listeners) {
          const result = propagateAlertRecursive(listener.id, agents, commRadius, maxDepth);
          for (const id of result.reachedAgentIds) informed.add(id);
          hops += result.hops.length;
          calls += result.recursiveCalls;
          stack = Math.max(stack, result.maxStackDepth);
          reachedDepth = Math.max(reachedDepth, result.maxDepth);
        }
        const propagationMs = performance.now() - t0;
        const co = responseCost(informed);
        rows.push({
          ...base,
          mode: 'coordinated',
          max_depth_limit: maxDepth,
          informed: informed.size,
          informed_ratio: round(informed.size / agentCount, 4),
          hops,
          reached_depth: reachedDepth,
          recursive_calls: calls,
          max_stack_depth: stack,
          propagation_ms: round(propagationMs, 5),
          responders_reachable: co.reachable,
          response_cost_mean: round(co.mean),
          planning_ms: round(co.ms, 5),
        });
      }
    }
  }
  return rows;
}

function parseArgs(argv: string[]): Partial<BenchmarkOptions> {
  const parsed: Partial<BenchmarkOptions> = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'reps') parsed.repetitions = Math.max(1, Number(value));
    if (key === 'inner') parsed.innerRuns = Math.max(1, Number(value));
    if (key === 'seed') parsed.baseSeed = Number(value);
    if (key === 'sizes') parsed.sizes = value.split(',').map(Number);
    if (key === 'quiet') parsed.quiet = true;
  }
  return parsed;
}

export async function runBenchmarkSuite(overrides: Partial<BenchmarkOptions> = {}): Promise<{
  results: Row[];
  summary: Row[];
  alerts: Row[];
}> {
  const options: BenchmarkOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const log = (msg: string): void => {
    if (!options.quiet) console.log(msg);
  };
  const started = new Date();
  log(
    `Z3R0-FRECUENCY benchmark: sizes=${options.sizes.join(',')} reps=${options.repetitions} ` +
      `inner=${options.innerRuns} baseSeed=${options.baseSeed}`
  );

  const results = runPathfindingBenchmarks(options);
  const summary = summarize(results);
  const alerts = runAlertBenchmarks(options);

  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(resolve(options.outDir, 'benchmark_results.csv'), toCsv(results));
  writeFileSync(resolve(options.outDir, 'benchmark_summary.csv'), toCsv(summary));
  writeFileSync(resolve(options.outDir, 'alert_results.csv'), toCsv(alerts));
  writeFileSync(
    resolve(options.outDir, 'run_metadata.json'),
    JSON.stringify(
      {
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        options: { ...options, outDir: undefined },
        seeds: options.sizes.flatMap((size) =>
          Array.from({ length: options.repetitions }, (_, rep) => ({ size, rep, seed: options.baseSeed + size * 1000 + rep }))
        ),
        machine: {
          cpu: cpus()[0]?.model ?? 'unknown',
          cores: cpus().length,
          totalMemoryGb: round(totalmem() / 1024 ** 3, 2),
          platform: platform(),
          release: release(),
          arch: arch(),
          node: process.version,
        },
        rows: { results: results.length, summary: summary.length, alerts: alerts.length },
      },
      null,
      2
    ) + '\n'
  );

  if (!options.quiet) {
    console.table(
      summary
        .filter((r) => r.movement === 8)
        .map((r) => ({
          source: r.source,
          size: r.size,
          scenario: r.scenario,
          algorithm: r.heuristic === 'none' ? r.algorithm : `${r.algorithm}/${r.heuristic}`,
          'time ms': r.time_ms_mean,
          expanded: r.expanded_mean,
          'cost ratio': r.cost_ratio_mean,
          optimal: r.optimal_rate,
        }))
    );
    const alertSummary = new Map<string, number[]>();
    for (const a of alerts) {
      const key = `${a.size}|${a.mode}${a.mode === 'coordinated' ? ` d<=${a.max_depth_limit}` : ''}`;
      alertSummary.set(key, [...(alertSummary.get(key) ?? []), Number(a.informed_ratio)]);
    }
    console.table(
      [...alertSummary.entries()].map(([key, ratios]) => {
        const [size, mode] = key.split('|');
        return { size, mode, 'informed ratio mean': round(mean(ratios), 3) };
      })
    );
    log(`CSV written to ${options.outDir}`);
  }

  return { results, summary, alerts };
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.endsWith('runSuite.ts');

if (isDirectExecution) {
  void runBenchmarkSuite(parseArgs(process.argv.slice(2)));
}
