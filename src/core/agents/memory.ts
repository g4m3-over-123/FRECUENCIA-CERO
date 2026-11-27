import type { AgentMemoryEntry } from '../contracts.ts';

/**
 * Manages confidence decay and updates for an agent's last-known target memory.
 */
export function decayMemory(
  memory: AgentMemoryEntry | null,
  _currentTick: number,
  _decayRate: number
): AgentMemoryEntry | null {
  // TODO: Reduce confidence over time and clear expired memory entries.
  return memory;
}
