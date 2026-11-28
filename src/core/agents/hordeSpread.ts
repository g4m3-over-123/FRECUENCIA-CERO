import type { AgentSnapshot, AlertPropagationResult, GridCoord } from '../contracts.ts';
import {
  propagateAlertRecursive,
  type AlertPropagationOptions,
} from '../algorithms/alertRecursion.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { gridDistance } from './perception.ts';

export interface HordeSpreadOptions extends AlertPropagationOptions {
  maxRadius?: number;
  maxDepth?: number;
  coordinationEnabled?: boolean;
}

const DEFAULT_ALERT_RADIUS = 7;
const DEFAULT_ALERT_MAX_DEPTH = 3;

/**
 * Coordinates recursive alert spread across infected agents using propagateAlertRecursive.
 * Only living infected participate, and stunned infected cannot relay.
 * With coordination disabled, an eligible origin receives a zero-hop result.
 */
export function triggerHordeSpread(
  originAgentId: string,
  agents: AgentSnapshot[],
  options: HordeSpreadOptions = {}
): AlertPropagationResult {
  const maxRadius = options.maxRadius ?? DEFAULT_ALERT_RADIUS;
  const maxDepth = options.coordinationEnabled === false
    ? 0
    : options.maxDepth ?? DEFAULT_ALERT_MAX_DEPTH;
  const infectedAgents = agents.filter(
    (agent) => agent.role !== 'radio_survivor' && agent.state !== 'dead'
  );

  const userCanRelay = options.canRelay;
  return propagateAlertRecursive(originAgentId, infectedAgents, maxRadius, maxDepth, {
    decayPerHop: options.decayPerHop ?? 0.82,
    distanceAttenuation: options.distanceAttenuation ?? 0.25,
    minSignal: options.minSignal ?? 0.1,
    initialSignal: options.initialSignal ?? 1,
    canRelay: (agent) =>
      agent.state !== 'stunned' &&
      (userCanRelay ? userCanRelay(agent) : true),
  });
}

function coordKey(coord: GridCoord): string {
  return `${coord.row},${coord.col}`;
}

/**
 * Collects distinct walkable flanking slots around a focus cell across concentric rings.
 */
function gatherFlankingSlots(
  graph: WeightedGraph,
  focus: GridCoord,
  maxRing: number
): GridCoord[] {
  const slots: GridCoord[] = [];
  const seen = new Set<string>();

  const pushIfWalkable = (coord: GridCoord): void => {
    if (!graph.isWalkable(coord)) return;
    const key = coordKey(coord);
    if (seen.has(key)) return;
    seen.add(key);
    slots.push(coord);
  };

  pushIfWalkable(focus);

  for (let ring = 1; ring <= maxRing; ring++) {
    const ringCandidates: Array<{ coord: GridCoord; angle: number }> = [];
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const candidate: GridCoord = { row: focus.row + dr, col: focus.col + dc };
        if (!graph.isWalkable(candidate)) continue;
        ringCandidates.push({
          coord: candidate,
          angle: Math.atan2(dr, dc),
        });
      }
    }

    // Order slots evenly around the compass so agents surround from opposite sides.
    ringCandidates.sort((a, b) => a.angle - b.angle);
    const step = Math.max(1, Math.floor(ringCandidates.length / 4));
    for (let offset = 0; offset < step; offset++) {
      for (let i = offset; i < ringCandidates.length; i += step) {
        pushIfWalkable(ringCandidates[i].coord);
      }
    }
  }

  return slots;
}

/**
 * Distributes distinct approach cells around a focus point so converging infected agents
 * flank and surround rather than stacking onto the exact same cell.
 */
export function assignDistributedTargets(
  graph: WeightedGraph,
  focus: GridCoord,
  convergingAgents: readonly AgentSnapshot[],
  maxRing = 3,
  keepClear: readonly GridCoord[] = []
): Map<string, GridCoord> {
  const assignments = new Map<string, GridCoord>();
  if (convergingAgents.length === 0) return assignments;

  const sortedAgents = [...convergingAgents].sort(
    (a, b) =>
      gridDistance(a.position, focus) - gridDistance(b.position, focus) ||
      a.id.localeCompare(b.id)
  );

  // Slots next to keepClear cells (an escape corridor) are never handed out, so the horde can close in without sealing the exit.
  const slots = gatherFlankingSlots(graph, focus, maxRing).filter(
    (slot) => keepClear.every((cell) => gridDistance(slot, cell) > 1.5)
  );
  if (slots.length === 0) {
    for (const agent of sortedAgents) {
      assignments.set(agent.id, { ...focus });
    }
    return assignments;
  }

  const usedSlots = new Set<string>();

  // Closest agent takes the center focus when walkable; others select distinct flanking slots.
  for (let i = 0; i < sortedAgents.length; i++) {
    const agent = sortedAgents[i];
    let bestSlot: GridCoord | null = null;
    let bestScore = Infinity;

    if (i === 0 && graph.isWalkable(focus)) {
      bestSlot = { ...focus };
    } else {
      for (const slot of slots) {
        const key = coordKey(slot);
        if (usedSlots.has(key)) continue;

        const distFromAgent = gridDistance(agent.position, slot);
        const distFromFocus = gridDistance(focus, slot);
        // Prefer nearby flanking slots on ring 1-2 around the focus to surround effectively.
        const ringBonus = distFromFocus >= 1 && distFromFocus <= 2.3 ? -0.6 : 0;
        const score = distFromAgent + distFromFocus * 0.35 + ringBonus;

        if (score < bestScore) {
          bestScore = score;
          bestSlot = slot;
        }
      }
    }

    if (!bestSlot) {
      // Fallback if there are more agents than nearby walkable cells: cycle slots evenly.
      bestSlot = slots[i % slots.length];
    }

    usedSlots.add(coordKey(bestSlot));
    assignments.set(agent.id, { ...bestSlot });
  }

  return assignments;
}
