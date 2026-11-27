import type { AgentSnapshot, AlertHop, AlertPropagationResult } from '../contracts.ts';

export interface AlertPropagationOptions {
  /** Signal multiplier applied per hop, in (0, 1]. Default 0.8. */
  decayPerHop?: number;
  /** Extra attenuation proportional to hop distance / radius, in [0, 1]. Default 0.3. */
  distanceAttenuation?: number;
  /** Propagation stops when the signal falls below this value. Default 0.05. */
  minSignal?: number;
  /** Initial signal strength of the origin. Default 1. */
  initialSignal?: number;
  /** Optional filter for agents that may relay the alert (e.g. not stunned). */
  canRelay?: (agent: AgentSnapshot) => boolean;
}

/**
 * Bounded recursive alert propagation over the communication graph.
 * Two agents are connected when their Euclidean grid distance is <= maxRadius.
 *
 * Base cases: depth == maxDepth, signal < minSignal, or no unvisited neighbors in range.
 * Progress: each call marks at least one new agent as visited before recursing,
 * so there are at most N calls and the recursion always terminates (no cycles).
 * Neighbors of a node are all marked before recursing into them, which keeps hop depth
 * close to the BFS depth instead of producing long chains.
 *
 * Time:  O(N^2) for N agents (each call scans all agents once).
 * Space: O(N) for the visited set plus O(min(N, maxDepth)) call stack frames.
 */
export function propagateAlertRecursive(
  originAgentId: string,
  agents: AgentSnapshot[],
  maxRadius: number,
  maxDepth: number,
  options: AlertPropagationOptions = {}
): AlertPropagationResult {
  const decay = options.decayPerHop ?? 0.8;
  const attenuation = options.distanceAttenuation ?? 0.3;
  const minSignal = options.minSignal ?? 0.05;
  const canRelay = options.canRelay ?? (() => true);

  const result: AlertPropagationResult = {
    originAgentId,
    maxDepth: 0,
    reachedAgentIds: [],
    hops: [],
    maxStackDepth: 0,
    recursiveCalls: 0,
  };

  const origin = agents.find((a) => a.id === originAgentId);
  if (!origin) return result;

  const visited = new Set<string>([originAgentId]);
  result.reachedAgentIds.push(originAgentId);

  const propagate = (current: AgentSnapshot, depth: number, signal: number, stackDepth: number): void => {
    result.recursiveCalls++;
    if (stackDepth > result.maxStackDepth) result.maxStackDepth = stackDepth;

    // Base case: depth limit, signal too weak, or this agent cannot relay.
    if (depth >= maxDepth || signal < minSignal || !canRelay(current)) return;

    const next: Array<{ agent: AgentSnapshot; distance: number }> = [];
    for (const candidate of agents) {
      if (visited.has(candidate.id)) continue;
      const distance = Math.hypot(
        candidate.position.row - current.position.row,
        candidate.position.col - current.position.col
      );
      if (distance <= maxRadius) next.push({ agent: candidate, distance });
    }

    // Base case: no new neighbors in range.
    if (next.length === 0) return;

    next.sort((a, b) => a.distance - b.distance || a.agent.id.localeCompare(b.agent.id));

    const children: Array<{ agent: AgentSnapshot; strength: number }> = [];
    for (const { agent, distance } of next) {
      const ratio = maxRadius > 0 ? distance / maxRadius : 0;
      const strength = signal * decay * (1 - attenuation * ratio);
      if (strength < minSignal) continue;
      visited.add(agent.id);
      result.reachedAgentIds.push(agent.id);
      const hop: AlertHop = {
        fromAgentId: current.id,
        toAgentId: agent.id,
        depth: depth + 1,
        distance,
        signalStrength: strength,
      };
      result.hops.push(hop);
      if (hop.depth > result.maxDepth) result.maxDepth = hop.depth;
      children.push({ agent, strength });
    }

    for (const child of children) {
      propagate(child.agent, depth + 1, child.strength, stackDepth + 1);
    }
  };

  propagate(origin, 0, options.initialSignal ?? 1, 1);
  return result;
}
