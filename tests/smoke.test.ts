import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AlgorithmType,
  AlertPropagationResult,
  HeuristicType,
  MapDefinition,
  SearchResult,
  WorldSnapshot,
} from '../src/core/contracts.ts';
import { parseMapDefinition } from '../src/core/graph/mapLoader.ts';
import { SimulationEngine } from '../src/core/gameplay/SimulationEngine.ts';

describe('Z3R0-FRECUENCY scaffolding smoke test', () => {
  it('loads public/maps/map_sample.json as a valid 10x10 MapDefinition', () => {
    const mapPath = resolve(process.cwd(), 'public/maps/map_sample.json');
    const rawJson = JSON.parse(readFileSync(mapPath, 'utf-8')) as unknown;
    const map: MapDefinition = parseMapDefinition(rawJson);

    expect(map.id).toBe('map_sample');
    expect(map.width).toBe(10);
    expect(map.height).toBe(10);
    expect(map.cells).toHaveLength(100);
    expect(map.spawnMara).toEqual({ row: 0, col: 0 });
    expect(map.extractionPoint).toEqual({ row: 0, col: 9 });
  });

  it('initializes headless SimulationEngine and satisfies shared contracts', () => {
    const mapPath = resolve(process.cwd(), 'public/maps/map_sample.json');
    const map = parseMapDefinition(JSON.parse(readFileSync(mapPath, 'utf-8')));

    const algorithm: AlgorithmType = 'astar';
    const heuristic: HeuristicType = 'octile';
    const engine = new SimulationEngine(map, 1);
    engine.setAlgorithm(algorithm, heuristic);

    const snapshot: WorldSnapshot = engine.getSnapshot();
    expect(snapshot.sceneId).toBe(1);
    expect(snapshot.algorithm).toBe('astar');
    expect(snapshot.heuristic).toBe('octile');
    expect(snapshot.mara.position).toEqual(map.spawnMara);

    const searchSample: SearchResult = {
      found: false,
      path: [],
      totalCost: 0,
      expandedNodes: [],
      expandedCount: 0,
      executionTimeMs: 0,
    };
    const alertSample: AlertPropagationResult = {
      originAgentId: 'agent-1',
      maxDepth: 0,
      reachedAgentIds: ['agent-1'],
      hops: [],
      maxStackDepth: 1,
      recursiveCalls: 1,
    };

    expect(searchSample.expandedCount).toBe(0);
    expect(alertSample.recursiveCalls).toBe(1);
  });
});
