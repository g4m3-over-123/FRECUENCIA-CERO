import type { AgentMemoryEntry, GridCoord } from '../contracts.ts';

export interface BlockedCellMemory {
  position: GridCoord;
  discoveredTick: number;
}

export interface MemoryConfig {
  decayRate: number;
  minConfidence: number;
  maxHistory: number;
  blockedCellTtlTicks: number;
}

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  decayRate: 0.04,
  minConfidence: 0.1,
  maxHistory: 16,
  blockedCellTtlTicks: 40,
};

const SOURCE_PRIORITY: Record<AgentMemoryEntry['source'], number> = {
  vision: 3,
  sound: 2,
  alert: 1,
};

function coordKey(coord: GridCoord): string {
  return `${coord.row},${coord.col}`;
}

/**
 * Computes confidence decay for an agent's last-known target memory entry.
 * Returns null once confidence falls below minConfidence.
 */
export function decayMemory(
  memory: AgentMemoryEntry | null,
  currentTick: number,
  decayRate: number,
  minConfidence = 0.05
): AgentMemoryEntry | null {
  if (!memory) return null;
  const elapsed = Math.max(0, currentTick - memory.lastSeenTick);
  const confidence = Math.max(0, memory.confidence - elapsed * decayRate);
  if (confidence < minConfidence) {
    return null;
  }
  return {
    position: { ...memory.position },
    confidence,
    lastSeenTick: memory.lastSeenTick,
    source: memory.source,
  };
}

/**
 * Per-agent memory store managing target evidence, observation history,
 * inferred target velocity from consecutive local sightings, and blocked cells.
 */
export class AgentMemoryStore {
  private readonly config: MemoryConfig;
  private anchorEntry: AgentMemoryEntry | null = null;
  private currentEntry: AgentMemoryEntry | null = null;
  private previousVisualPos: GridCoord | null = null;
  private estimatedVelocity: GridCoord = { row: 0, col: 0 };
  private readonly history: AgentMemoryEntry[] = [];
  private readonly blockedCells = new Map<string, BlockedCellMemory>();
  private readonly visitedPatrolTicks = new Map<string, number>();

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  /**
   * Decays active memory linearly from its anchor observation tick and expires old obstacles.
   */
  tick(currentTick: number): AgentMemoryEntry | null {
    if (this.anchorEntry) {
      this.currentEntry = decayMemory(
        this.anchorEntry,
        currentTick,
        this.config.decayRate,
        this.config.minConfidence
      );
      if (!this.currentEntry) {
        this.anchorEntry = null;
        this.previousVisualPos = null;
        this.estimatedVelocity = { row: 0, col: 0 };
      }
    }

    for (const [key, item] of this.blockedCells.entries()) {
      if (currentTick - item.discoveredTick > this.config.blockedCellTtlTicks) {
        this.blockedCells.delete(key);
      }
    }

    return this.getSnapshot();
  }

  /**
   * Evaluates a new local evidence entry and promotes it to active memory when stronger or fresher.
   * Returns true if the active target position or source changed.
   */
  recordEvidence(entry: AgentMemoryEntry, allowSoundOverrideOfStaleVision = true): boolean {
    const normalized: AgentMemoryEntry = {
      position: { ...entry.position },
      confidence: Math.max(0, Math.min(1, entry.confidence)),
      lastSeenTick: entry.lastSeenTick,
      source: entry.source,
    };

    this.history.push(normalized);
    if (this.history.length > this.config.maxHistory) {
      this.history.shift();
    }

    if (normalized.source === 'vision') {
      if (this.previousVisualPos) {
        this.estimatedVelocity = {
          row: Math.sign(normalized.position.row - this.previousVisualPos.row),
          col: Math.sign(normalized.position.col - this.previousVisualPos.col),
        };
      }
      this.previousVisualPos = { ...normalized.position };
    }

    const active = this.currentEntry;
    if (!active) {
      this.anchorEntry = normalized;
      this.currentEntry = { ...normalized, position: { ...normalized.position } };
      return true;
    }

    const incomingPrio = SOURCE_PRIORITY[normalized.source];
    const activePrio = SOURCE_PRIORITY[active.source];
    const activeIsFreshVision =
      active.source === 'vision' && normalized.lastSeenTick - active.lastSeenTick <= 1;

    let shouldReplace = false;

    if (normalized.source === 'vision') {
      shouldReplace = true;
    } else if (normalized.source === 'sound') {
      if (activeIsFreshVision) {
        shouldReplace = false;
      } else if (allowSoundOverrideOfStaleVision) {
        const isFresher = normalized.lastSeenTick >= active.lastSeenTick;
        const isStronger = normalized.confidence >= active.confidence * 0.85;
        shouldReplace = isFresher && isStronger;
      } else {
        shouldReplace = incomingPrio >= activePrio && normalized.confidence >= active.confidence;
      }
    } else {
      // Alert source: do not override fresh direct vision or stronger recent local sound.
      const isFresher = normalized.lastSeenTick > active.lastSeenTick;
      const isStrongerThanDecayed = normalized.confidence >= active.confidence * 0.9;
      shouldReplace = !activeIsFreshVision && (isFresher || isStrongerThanDecayed) && activePrio <= 2;
      if (active.source === 'sound' && normalized.lastSeenTick - active.lastSeenTick <= 1 && active.confidence > normalized.confidence) {
        shouldReplace = false;
      }
    }

    if (!shouldReplace) {
      return false;
    }

    const changed =
      active.position.row !== normalized.position.row ||
      active.position.col !== normalized.position.col ||
      active.source !== normalized.source;

    this.anchorEntry = normalized;
    this.currentEntry = { ...normalized, position: { ...normalized.position } };
    return changed;
  }

  /**
   * Clears active target memory (for example after arriving at an investigated cell and finding nothing).
   */
  clearActiveTarget(): void {
    this.anchorEntry = null;
    this.currentEntry = null;
    this.previousVisualPos = null;
    this.estimatedVelocity = { row: 0, col: 0 };
  }

  getSnapshot(): AgentMemoryEntry | null {
    if (!this.currentEntry) return null;
    return {
      position: { ...this.currentEntry.position },
      confidence: this.currentEntry.confidence,
      lastSeenTick: this.currentEntry.lastSeenTick,
      source: this.currentEntry.source,
    };
  }

  getEstimatedVelocity(): GridCoord {
    return { ...this.estimatedVelocity };
  }

  getHistory(): readonly AgentMemoryEntry[] {
    return this.history;
  }

  recordBlockedCell(position: GridCoord, tick: number): void {
    this.blockedCells.set(coordKey(position), {
      position: { ...position },
      discoveredTick: tick,
    });
  }

  getKnownBlockedCells(): GridCoord[] {
    return Array.from(this.blockedCells.values()).map((item) => ({ ...item.position }));
  }

  markPatrolVisited(position: GridCoord, tick: number): void {
    this.visitedPatrolTicks.set(coordKey(position), tick);
  }

  getLastVisitedTick(position: GridCoord): number {
    return this.visitedPatrolTicks.get(coordKey(position)) ?? -Infinity;
  }
}
