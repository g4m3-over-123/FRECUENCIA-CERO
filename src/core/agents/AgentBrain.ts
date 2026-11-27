import type { AgentSnapshot, SoundEvent } from '../contracts.ts';

/**
 * Decision-making state machine for autonomous agents.
 * Anti-omniscience: decisions rely strictly on local perception, sound events, and memory.
 */
export class AgentBrain {
  decideNextState(
    agent: AgentSnapshot,
    _perceivedSounds: SoundEvent[],
    _hasLineOfSight: boolean
  ): AgentSnapshot {
    // TODO: Implement state transitions without reading Mara's global coordinates directly.
    return agent;
  }
}
