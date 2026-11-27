import type { AgentSnapshot, AlertPropagationResult } from '../contracts.ts';

/**
 * Coordinates horde alert spread using recursive propagation.
 */
export function triggerHordeSpread(
  originAgentId: string,
  _agents: AgentSnapshot[]
): AlertPropagationResult {
  // TODO: Invoke propagateAlertRecursive and update agent alert states.
  return {
    originAgentId,
    maxDepth: 0,
    reachedAgentIds: [originAgentId],
    hops: [],
    maxStackDepth: 1,
    recursiveCalls: 1,
  };
}
