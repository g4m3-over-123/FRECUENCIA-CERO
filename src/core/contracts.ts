export interface GridCoord {
  row: number;
  col: number;
}

export type CellType =
  | 'street'
  | 'sidewalk'
  | 'building'
  | 'obstacle'
  | 'barricade'
  | 'pharmacy'
  | 'refuge'
  | 'extraction';

export interface MapCellData {
  row: number;
  col: number;
  type: CellType;
  walkable: boolean;
  cost: number;
  elevation?: number;
}

/**
 * Links the logical grid with the 3D world (meters).
 * Convention: col grows along +X, row grows along +Z, Y is up.
 * origin = world XZ position of the outer corner of cell (0, 0).
 */
export interface WorldAlignment {
  origin: { x: number; z: number };
  /** Optional GLB that visually represents this grid, placed with `offset` (and `scale`). */
  asset?: {
    url: string;
    offset: [number, number, number];
    scale?: number;
  };
}

export interface MapDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  spawnMara: GridCoord;
  extractionPoint: GridCoord;
  cells: MapCellData[];
  /** Absent = grid centered on the world origin, no visual asset. */
  world?: WorldAlignment;
}

export type AlgorithmType = 'dijkstra' | 'astar';

export type HeuristicType = 'manhattan' | 'octile' | 'euclidean';

export interface SearchResult {
  found: boolean;
  path: GridCoord[];
  totalCost: number;
  expandedNodes: GridCoord[];
  expandedCount: number;
  executionTimeMs: number;
}

export interface SoundEvent {
  id: string;
  sourceId: string;
  position: GridCoord;
  radius: number;
  intensity: number;
  timestamp: number;
}

export interface AlertHop {
  fromAgentId: string;
  toAgentId: string;
  depth: number;
  distance: number;
  signalStrength: number;
}

export interface AlertPropagationResult {
  originAgentId: string;
  maxDepth: number;
  reachedAgentIds: string[];
  hops: AlertHop[];
  maxStackDepth: number;
  recursiveCalls: number;
}

export type AgentRole = 'explorer' | 'pursuer' | 'radio_survivor';

export type AgentState =
  | 'idle'
  | 'patrol'
  | 'investigate'
  | 'pursue'
  | 'alert'
  | 'stunned'
  | 'attack'
  | 'dead';

export interface AgentMemoryEntry {
  position: GridCoord;
  confidence: number;
  lastSeenTick: number;
  source: 'vision' | 'sound' | 'alert';
}

export interface AgentSnapshot {
  id: string;
  role: AgentRole;
  state: AgentState;
  position: GridCoord;
  targetPosition: GridCoord | null;
  alertDepth: number;
  memory: AgentMemoryEntry | null;
  /** 0 means dead. */
  health: number;
}

export type MaraPosture = 'stealth' | 'walk' | 'sprint';

export interface WeaponSnapshot {
  id: string;
  ammoInMagazine: number;
  magazineSize: number;
  ammoReserve: number;
  reloading: boolean;
}

export interface MaraSnapshot {
  position: GridCoord;
  noiseLevel: number;
  health: number;
  stamina: number;
  hasMedicalKit: boolean;
  reachedExtraction: boolean;
  weapon: WeaponSnapshot;
}

export interface TelemetryLogEntry {
  tick: number;
  timestampMs: number;
  category: 'search' | 'alert' | 'agent' | 'gameplay' | 'system';
  message: string;
}

export type SceneId = 1 | 2 | 3 | 4 | 5;

/**
 * The only way the browser (input, camera, weapon raycast) talks to the simulation.
 * The engine validates every command against its own rules.
 */
export type GameCommand =
  | { type: 'moveToCell'; cell: GridCoord; posture: MaraPosture; facing?: GridCoord }
  | { type: 'fire'; hitAgentId: string | null }
  | { type: 'reload' }
  | { type: 'decoy'; target?: GridCoord }
  | { type: 'barricade'; target?: GridCoord }
  | { type: 'interact' };

/** SoundEvent.sourceId emitted by gunshots. */
export const GUNSHOT_SOURCE_ID = 'mara_gunshot';

export interface WorldSnapshot {
  sceneId: SceneId;
  tick: number;
  elapsedMs: number;
  paused: boolean;
  algorithm: AlgorithmType;
  heuristic: HeuristicType;
  mara: MaraSnapshot;
  agents: AgentSnapshot[];
  activeAlerts: AlertPropagationResult[];
  soundEvents: SoundEvent[];
  logs: TelemetryLogEntry[];
}
