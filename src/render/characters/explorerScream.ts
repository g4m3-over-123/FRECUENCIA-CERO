import type { AgentSnapshot, SoundEvent } from '../../core/contracts.ts';

export const EXPLORER_SCREAM = 'zombie_scream';

export function explorerScreamAt(agent: AgentSnapshot, sounds: readonly SoundEvent[]): SoundEvent | undefined {
  if (agent.role !== 'explorer' || agent.state !== 'alert' || agent.health <= 0) return undefined;
  return sounds.find((sound) =>
    sound.sourceId === EXPLORER_SCREAM &&
    sound.position.row === agent.position.row &&
    sound.position.col === agent.position.col
  );
}
