import type {
  AlgorithmType,
  HeuristicType,
  MapDefinition,
  SceneId,
  WorldSnapshot,
} from '../contracts.ts';

/**
 * Headless simulation loop managing ticks, agents, Mara, and telemetry.
 */
export class SimulationEngine {
  private snapshot: WorldSnapshot;

  constructor(map: MapDefinition, sceneId: SceneId = 1) {
    this.snapshot = {
      sceneId,
      tick: 0,
      elapsedMs: 0,
      paused: false,
      algorithm: 'astar',
      heuristic: 'octile',
      mara: {
        position: { ...map.spawnMara },
        noiseLevel: 0,
        health: 100,
        stamina: 100,
        hasMedicalKit: false,
        reachedExtraction: false,
      },
      agents: [],
      activeAlerts: [],
      soundEvents: [],
      logs: [],
    };
  }

  getSnapshot(): WorldSnapshot {
    return this.snapshot;
  }

  setAlgorithm(algorithm: AlgorithmType, heuristic: HeuristicType): void {
    this.snapshot.algorithm = algorithm;
    this.snapshot.heuristic = heuristic;
  }

  step(_deltaMs: number): WorldSnapshot {
    // TODO: Advance simulation tick, perceptions, pathfinding, and agent actions.
    return this.snapshot;
  }
}
