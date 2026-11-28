import type { AgentSnapshot, SoundEvent } from '../../core/contracts.ts';

export const EXPLORER_SCREAM = 'zombie_scream';
export const EXPLORER_SCREAM_ALIAS = 'explorer_scream';
const SCOPED_SCREAM_ID = /^sound-(?:zombie_scream|explorer_scream)-(.+)-\d+$/;

export function isExplorerScream(sound: SoundEvent): boolean {
  return sound.sourceId === EXPLORER_SCREAM || sound.sourceId === EXPLORER_SCREAM_ALIAS;
}

export function explorerScreamAt(agent: AgentSnapshot, sounds: readonly SoundEvent[]): SoundEvent | undefined {
  if (agent.role !== 'explorer' || agent.health <= 0) return undefined;
  return sounds.find((sound) => {
    if (!isExplorerScream(sound)) return false;
    const originId = SCOPED_SCREAM_ID.exec(sound.id)?.[1];
    if (originId !== undefined) return originId === agent.id;
    return agent.state === 'alert' && sound.position.row === agent.position.row &&
      sound.position.col === agent.position.col;
  });
}
