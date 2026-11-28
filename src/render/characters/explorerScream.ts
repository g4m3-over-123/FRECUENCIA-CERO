import type { AgentSnapshot, SoundEvent } from '../../core/contracts.ts';

export const EXPLORER_SCREAM = 'zombie_scream';
const SCOPED_SCREAM_ID = /^sound-zombie_scream-(.+)-\d+$/;

export function explorerScreamAt(agent: AgentSnapshot, sounds: readonly SoundEvent[]): SoundEvent | undefined {
  if (agent.role !== 'explorer' || agent.health <= 0) return undefined;
  return sounds.find((sound) => {
    if (sound.sourceId !== EXPLORER_SCREAM) return false;
    const originId = SCOPED_SCREAM_ID.exec(sound.id)?.[1];
    if (originId !== undefined) return originId === agent.id;
    return agent.state === 'alert' && sound.position.row === agent.position.row &&
      sound.position.col === agent.position.col;
  });
}
