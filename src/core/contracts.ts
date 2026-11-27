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

export interface MapDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  spawnMara: GridCoord;
  extractionPoint: GridCoord;
  cells: MapCellData[];
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
  | 'stunned';

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
}

export interface MaraSnapshot {
  position: GridCoord;
  noiseLevel: number;
  health: number;
  stamina: number;
  hasMedicalKit: boolean;
  reachedExtraction: boolean;
}

export interface TelemetryLogEntry {
  tick: number;
  timestampMs: number;
  category: 'search' | 'alert' | 'agent' | 'gameplay' | 'system';
  message: string;
}

export type SceneId = 1 | 2 | 3 | 4 | 5;

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
