import type {
  AgentMemoryEntry,
  AgentRole,
  AgentSnapshot,
  AgentState,
  AlgorithmType,
  GridCoord,
  HeuristicType,
  SoundEvent,
} from '../contracts.ts';
import { findPath, type SearchStats } from '../algorithms/index.ts';
import type { SeededRng } from '../graph/seededRng.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { AgentMemoryStore } from './memory.ts';
import {
  computePerceivedSoundIntensity,
  gridDistance,
  type LocalPerception,
} from './perception.ts';

/**
 * Extended agent snapshot structurally assignable to AgentSnapshot.
 * Exposes pathfinding and perception telemetry needed by HUD and debug overlays
 * without modifying src/core/contracts.ts.
 */
export interface ExtendedAgentSnapshot extends AgentSnapshot {
  currentPath: GridCoord[];
  lastSearch: SearchStats | null;
  perceptionSummary: string;
  algorithmUsed: AlgorithmType;
  heuristicUsed: HeuristicType;
  goalReason: string;
  planChanges: number;
  knownBlockedCells: GridCoord[];
}

export interface AgentProfile {
  visionRange: number;
  minAudibleIntensity: number;
  patrolMoveEveryTicks: number;
  activeMoveEveryTicks: number;
  memoryDecayRate: number;
  canIntercept: boolean;
  meleeDamage: number;
  attackCooldownTicks: number;
}

export const AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  explorer: {
    visionRange: 5,
    minAudibleIntensity: 0.06,
    patrolMoveEveryTicks: 2,
    activeMoveEveryTicks: 1,
    memoryDecayRate: 0.045,
    canIntercept: false,
    meleeDamage: 10,
    attackCooldownTicks: 3,
  },
  pursuer: {
    visionRange: 6,
    minAudibleIntensity: 0.08,
    patrolMoveEveryTicks: 2,
    activeMoveEveryTicks: 1,
    memoryDecayRate: 0.035,
    canIntercept: true,
    meleeDamage: 16,
    attackCooldownTicks: 3,
  },
  radio_survivor: {
    visionRange: 5,
    minAudibleIntensity: 0.08,
    patrolMoveEveryTicks: 4,
    activeMoveEveryTicks: 2,
    memoryDecayRate: 0.06,
    canIntercept: false,
    meleeDamage: 0,
    attackCooldownTicks: 0,
  },
};

/** Phase 0 hit points per role. Front C owns balance. */
export const AGENT_MAX_HEALTH: Record<AgentRole, number> = {
  explorer: 70,
  pursuer: 105,
  radio_survivor: 100,
};

const EXPLORER_SCREAM_HOLD_TICKS = 2;
const EXPLORER_SCREAM_COOLDOWN_TICKS = 18;
const EXPLORER_SCREAM_RADIUS = 16;
const EXPLORER_SCREAM_INTENSITY = 0.85;
const ZOMBIE_SCREAM_SOURCE_ID = 'zombie_scream';
const ZOMBIE_SCREAM_ID_PATTERN = /^sound-zombie_scream-(.+)-(\d+)$/;

export interface AgentRuntimeState {
  id: string;
  role: AgentRole;
  state: AgentState;
  health: number;
  position: GridCoord;
  homePosition: GridCoord;
  targetPosition: GridCoord | null;
  alertDepth: number;
  memoryStore: AgentMemoryStore;
  currentPath: GridCoord[];
  lastSearch: SearchStats | null;
  perceptionSummary: string;
  algorithmUsed: AlgorithmType;
  heuristicUsed: HeuristicType;
  goalReason: string;
  planChanges: number;
  patrolWaypoints: GridCoord[];
  patrolIndex: number;
  stunnedUntilTick: number;
  alertHoldUntilTick: number;
  lastScreamTick: number;
  lastAlertBroadcastTick: number;
  lastMoveTick: number;
  lastAttackTick: number;
}

export interface AgentCycleInput {
  runtime: AgentRuntimeState;
  perception: LocalPerception;
  graph: WeightedGraph;
  algorithm: AlgorithmType;
  heuristic: HeuristicType;
  tick: number;
  rng: SeededRng;
  assignedFocusSlot?: GridCoord | null;
  nearbyThreatForSurvivor?: GridCoord | null;
}

export interface AgentCycleOutput {
  snapshot: ExtendedAgentSnapshot;
  shouldBroadcastAlert: boolean;
  alertTarget: GridCoord | null;
  emittedSound?: Omit<SoundEvent, 'id' | 'timestamp'> | null;
  planChanged: boolean;
  planChangeReason: string | null;
  searchExecuted: SearchStats | null;
  moved: boolean;
}

function sameCoord(a: GridCoord | null, b: GridCoord | null): boolean {
  if (!a || !b) return false;
  return a.row === b.row && a.col === b.col;
}

/**
 * Finds the nearest walkable cell to target when target itself is blocked (e.g. by a barricade).
 */
function resolveWalkableTarget(graph: WeightedGraph, target: GridCoord): GridCoord | null {
  if (graph.isWalkable(target)) return { ...target };

  for (let ring = 1; ring <= 4; ring++) {
    let best: GridCoord | null = null;
    let bestDist = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const candidate = { row: target.row + dr, col: target.col + dc };
        if (!graph.isWalkable(candidate)) continue;
        const d = gridDistance(target, candidate);
        if (d < bestDist) {
          bestDist = d;
          best = candidate;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Creates initial runtime state for an autonomous agent with local patrol waypoints.
 */
export function createAgentRuntime(
  id: string,
  role: AgentRole,
  startPosition: GridCoord,
  patrolWaypoints: GridCoord[],
  algorithm: AlgorithmType,
  heuristic: HeuristicType
): AgentRuntimeState {
  const profile = AGENT_PROFILES[role];
  const initialState: AgentState = role === 'radio_survivor' ? 'idle' : 'patrol';
  const memoryStore = new AgentMemoryStore({
    decayRate: profile.memoryDecayRate,
  });
  memoryStore.markPatrolVisited(startPosition, 0);

  return {
    id,
    role,
    state: initialState,
    health: AGENT_MAX_HEALTH[role],
    position: { ...startPosition },
    homePosition: { ...startPosition },
    targetPosition: null,
    alertDepth: 0,
    memoryStore,
    currentPath: [],
    lastSearch: null,
    perceptionSummary: 'no local stimuli',
    algorithmUsed: algorithm,
    heuristicUsed: heuristic,
    goalReason: role === 'radio_survivor' ? 'holding refuge radio post' : 'exploring local patrol sector',
    planChanges: 0,
    patrolWaypoints: patrolWaypoints.map((p) => ({ ...p })),
    patrolIndex: 0,
    stunnedUntilTick: -1,
    alertHoldUntilTick: -1,
    lastScreamTick: -100,
    lastAlertBroadcastTick: -100,
    lastMoveTick: -1,
    lastAttackTick: -100,
  };
}

/**
 * Converts an agent runtime state into an ExtendedAgentSnapshot assignable to AgentSnapshot.
 */
export function toAgentSnapshot(runtime: AgentRuntimeState): ExtendedAgentSnapshot {
  return {
    id: runtime.id,
    role: runtime.role,
    state: runtime.state,
    position: { ...runtime.position },
    targetPosition: runtime.targetPosition ? { ...runtime.targetPosition } : null,
    alertDepth: runtime.alertDepth,
    memory: runtime.memoryStore.getSnapshot(),
    health: runtime.health,
    currentPath: runtime.currentPath.map((p) => ({ ...p })),
    lastSearch: runtime.lastSearch
      ? {
          ...runtime.lastSearch,
          path: runtime.lastSearch.path.map((p) => ({ ...p })),
          expandedNodes: runtime.lastSearch.expandedNodes.map((p) => ({ ...p })),
        }
      : null,
    perceptionSummary: runtime.perceptionSummary,
    algorithmUsed: runtime.algorithmUsed,
    heuristicUsed: runtime.heuristicUsed,
    goalReason: runtime.goalReason,
    planChanges: runtime.planChanges,
    knownBlockedCells: runtime.memoryStore.getKnownBlockedCells(),
  };
}

/**
 * Autonomous agent brain implementing the full 6-stage cycle:
 * Perception -> Memory -> Decision -> Planning -> Execution -> Evaluation.
 *
 * Anti-omniscience: AgentBrain never receives or accesses Mara's global coordinates.
 */
export class AgentBrain {
  /**
   * Stateless compatibility helper for quick state transitions from local signals only.
   */
  decideNextState(
    agent: AgentSnapshot,
    perceivedSounds: SoundEvent[],
    hasLineOfSightFlag: boolean
  ): AgentSnapshot {
    if (agent.state === 'stunned' || agent.state === 'dead') return { ...agent };

    if (agent.role === 'radio_survivor') {
      const nextState: AgentState = perceivedSounds.length > 0 || hasLineOfSightFlag ? 'alert' : 'idle';
      return { ...agent, state: nextState };
    }

    if (hasLineOfSightFlag) {
      return {
        ...agent,
        state: 'pursue',
      };
    }

    if (perceivedSounds.length > 0) {
      const strongest = perceivedSounds[0];
      const nextState: AgentState =
        agent.role === 'pursuer' && strongest.intensity >= 0.75 ? 'pursue' : 'investigate';
      return {
        ...agent,
        state: nextState,
        targetPosition: { ...strongest.position },
        memory: {
          position: { ...strongest.position },
          confidence: Math.min(1, strongest.intensity),
          lastSeenTick: strongest.timestamp,
          source: 'sound',
        },
      };
    }

    if (agent.memory && agent.memory.confidence > 0.1) {
      const nextState: AgentState =
        agent.memory.source === 'vision'
          ? 'pursue'
          : agent.memory.source === 'alert'
            ? 'alert'
            : 'investigate';
      return {
        ...agent,
        state: nextState,
        targetPosition: { ...agent.memory.position },
      };
    }

    return {
      ...agent,
      state: 'patrol',
      alertDepth: 0,
    };
  }

  /**
   * Runs one full Perception -> Memory -> Decision -> Planning -> Execution -> Evaluation cycle.
   */
  executeCycle(input: AgentCycleInput): AgentCycleOutput {
    const {
      runtime,
      perception,
      graph,
      algorithm,
      heuristic,
      tick,
      rng,
      assignedFocusSlot = null,
      nearbyThreatForSurvivor = null,
    } = input;

    const profile = AGENT_PROFILES[runtime.role];
    let shouldBroadcastAlert = false;
    let alertTarget: GridCoord | null = null;
    let emittedSound: Omit<SoundEvent, 'id' | 'timestamp'> | null = null;
    let planChanged = false;
    let planChangeReason: string | null = null;
    let searchExecuted: SearchStats | null = null;
    let moved = false;

    // Dead agents never perceive, plan or move again.
    if (runtime.state === 'dead' || runtime.health <= 0) {
      runtime.state = 'dead';
      runtime.alertHoldUntilTick = -1;
      runtime.currentPath = [];
      runtime.targetPosition = null;
      runtime.goalReason = 'dead';
      return {
        snapshot: toAgentSnapshot(runtime),
        shouldBroadcastAlert: false,
        alertTarget: null,
        emittedSound: null,
        planChanged: false,
        planChangeReason: null,
        searchExecuted: null,
        moved: false,
      };
    }

    // 1. Perception stage
    runtime.perceptionSummary = perception.summary;

    if (runtime.stunnedUntilTick >= tick) {
      runtime.state = 'stunned';
      runtime.alertHoldUntilTick = -1;
      runtime.goalReason = 'temporarily stunned';
      return {
        snapshot: toAgentSnapshot(runtime),
        shouldBroadcastAlert: false,
        alertTarget: null,
        emittedSound: null,
        planChanged: false,
        planChangeReason: null,
        searchExecuted: null,
        moved: false,
      };
    }

    // Special autonomous behavior for the stationary/defensive radio_survivor ally
    if (runtime.role === 'radio_survivor') {
      return this.executeRadioSurvivorCycle(runtime, nearbyThreatForSurvivor, tick);
    }

    // 2. Memory update & decay stage
    runtime.memoryStore.tick(tick);

    // Ignore only this agent's own scream echo and prioritize recursive alerts over zombie_scream.
    const externalAudibleSounds = perception.audibleSounds.filter((sound) => {
      if (sound.sourceId !== ZOMBIE_SCREAM_SOURCE_ID) return true;
      const scopedMatch = ZOMBIE_SCREAM_ID_PATTERN.exec(sound.id);
      if (scopedMatch) return scopedMatch[1] !== runtime.id;
      return !(runtime.lastScreamTick === tick - 1 && sameCoord(runtime.position, sound.position));
    });
    const rawStrongestSound = externalAudibleSounds.length > 0 ? externalAudibleSounds[0] : null;
    const strongestSound =
      perception.receivedAlert && rawStrongestSound?.sourceId === ZOMBIE_SCREAM_SOURCE_ID
        ? (externalAudibleSounds.find((sound) => sound.sourceId !== ZOMBIE_SCREAM_SOURCE_ID) ?? null)
        : rawStrongestSound;
    const isDecoySound = strongestSound !== null && strongestSound.sourceId.startsWith('decoy');
    const decoyPriority =
      isDecoySound &&
      strongestSound !== null &&
      computePerceivedSoundIntensity(runtime.position, strongestSound) >= 0.25;

    let evidenceChanged = false;
    let freshTriggerSource: AgentMemoryEntry['source'] | null = null;

    // Loud acoustic decoys lure infected that are not already in immediate melee contact.
    const visualCloseContact =
      perception.visualTarget !== null &&
      gridDistance(runtime.position, perception.visualTarget) <= 1.5;

    if (decoyPriority && strongestSound && !visualCloseContact) {
      runtime.alertHoldUntilTick = -1;
      const perceived = computePerceivedSoundIntensity(runtime.position, strongestSound);
      const confidence = Math.min(1, 0.72 + perceived * 0.28);
      // Clear stale vision so the horde genuinely reconsiders toward the acoustic decoy.
      const prevMem = runtime.memoryStore.getSnapshot();
      if (prevMem && prevMem.source === 'vision') {
        runtime.memoryStore.clearActiveTarget();
      }
      evidenceChanged = runtime.memoryStore.recordEvidence(
        {
          position: strongestSound.position,
          confidence,
          lastSeenTick: tick,
          source: 'sound',
        },
        true
      );
      freshTriggerSource = 'sound';
      runtime.alertDepth = 0;
    } else if (perception.visualTarget) {
      evidenceChanged = runtime.memoryStore.recordEvidence(
        {
          position: perception.visualTarget,
          confidence: 1,
          lastSeenTick: tick,
          source: 'vision',
        },
        false
      );
      freshTriggerSource = 'vision';
      runtime.alertDepth = 0;
    } else if (strongestSound) {
      const perceived = computePerceivedSoundIntensity(runtime.position, strongestSound);
      const confidence = Math.min(1, 0.35 + perceived * 0.65);
      evidenceChanged = runtime.memoryStore.recordEvidence(
        {
          position: strongestSound.position,
          confidence,
          lastSeenTick: tick,
          source: 'sound',
        },
        true
      );
      freshTriggerSource = 'sound';
      runtime.alertDepth = 0;
    }

    if (perception.receivedAlert) {
      const alertChanged = runtime.memoryStore.recordEvidence(
        {
          position: perception.receivedAlert.position,
          confidence: Math.min(0.92, perception.receivedAlert.signalStrength),
          lastSeenTick: tick,
          source: 'alert',
        },
        true
      );
      if (alertChanged) {
        evidenceChanged = true;
        runtime.alertDepth = perception.receivedAlert.depth;
        if (!freshTriggerSource) freshTriggerSource = 'alert';
      }
    }

    const activeMemory = runtime.memoryStore.getSnapshot();

    // Determine whether this agent initiates recursive horde alert propagation.
    const canBroadcastNow = tick - runtime.lastAlertBroadcastTick >= 3;
    if (canBroadcastNow) {
      if (perception.visualTarget) {
        shouldBroadcastAlert = true;
        alertTarget = { ...perception.visualTarget };
        runtime.lastAlertBroadcastTick = tick;
      } else if (
        strongestSound &&
        strongestSound.sourceId !== ZOMBIE_SCREAM_SOURCE_ID &&
        strongestSound.intensity >= 0.6
      ) {
        shouldBroadcastAlert = true;
        alertTarget = { ...strongestSound.position };
        runtime.lastAlertBroadcastTick = tick;
      }
    }

    // Trigger explorer scream when spotting a distant target outside decoy override and cooldown.
    if (
      runtime.role === 'explorer' &&
      !decoyPriority &&
      perception.visualTarget !== null &&
      !visualCloseContact &&
      tick > runtime.alertHoldUntilTick &&
      tick - runtime.lastScreamTick >= EXPLORER_SCREAM_COOLDOWN_TICKS
    ) {
      runtime.alertHoldUntilTick = tick + EXPLORER_SCREAM_HOLD_TICKS;
      runtime.lastScreamTick = tick;
      emittedSound = {
        sourceId: ZOMBIE_SCREAM_SOURCE_ID,
        position: { ...runtime.position },
        radius: EXPLORER_SCREAM_RADIUS,
        intensity: EXPLORER_SCREAM_INTENSITY,
      };
    }

    if (runtime.role === 'explorer' && visualCloseContact) {
      runtime.alertHoldUntilTick = -1;
    }

    const isScreamingHold = runtime.role === 'explorer' && tick <= runtime.alertHoldUntilTick;

    // 3. Decision stage (select state and goal based strictly on memory and local evidence)
    const previousTarget = runtime.targetPosition ? { ...runtime.targetPosition } : null;
    const previousState = runtime.state;
    let desiredTarget: GridCoord | null = null;

    if (activeMemory) {
      const baseFocus = assignedFocusSlot ?? activeMemory.position;

      if (activeMemory.source === 'vision') {
        runtime.state = 'pursue';
        desiredTarget = this.selectPursuitOrInterceptTarget(
          runtime,
          graph,
          baseFocus,
          assignedFocusSlot !== null
        );
        runtime.goalReason =
          desiredTarget && !sameCoord(desiredTarget, activeMemory.position) && !assignedFocusSlot
            ? 'intercepting observed movement trajectory'
            : assignedFocusSlot
              ? 'flanking last seen position'
              : 'pursuing visual evidence';
      } else if (activeMemory.source === 'sound') {
        runtime.state =
          runtime.role === 'pursuer' && activeMemory.confidence >= 0.72 ? 'pursue' : 'investigate';
        desiredTarget = { ...baseFocus };
        runtime.goalReason = isDecoySound
          ? 'reconsidering target toward acoustic decoy'
          : assignedFocusSlot
            ? 'flanking acoustic disturbance'
            : 'investigating audible sound event';
      } else {
        runtime.state = 'alert';
        desiredTarget = { ...baseFocus };
        runtime.goalReason = assignedFocusSlot
          ? `coordinated flanking from alert depth ${runtime.alertDepth}`
          : `responding to propagated alert (depth ${runtime.alertDepth})`;
      }
    } else {
      runtime.state = 'patrol';
      runtime.alertDepth = 0;
      desiredTarget = this.selectLocalPatrolTarget(runtime, graph, rng);
      runtime.goalReason = 'autonomous local patrol without global info';
    }

    if (isScreamingHold) {
      runtime.state = 'alert';
      runtime.goalReason = 'screaming to alert nearby infected';
    }

    const resolvedTarget = desiredTarget ? resolveWalkableTarget(graph, desiredTarget) : null;

    // 4. Planning & replanning evaluation stage
    const blockedStep = this.findBlockedStepOnCurrentPath(runtime.currentPath, graph);
    if (blockedStep) {
      runtime.memoryStore.recordBlockedCell(blockedStep, tick);
    }

    const targetChanged = !sameCoord(previousTarget, resolvedTarget);
    const algorithmChanged =
      runtime.algorithmUsed !== algorithm || runtime.heuristicUsed !== heuristic;
    const pathMissing =
      resolvedTarget !== null &&
      !sameCoord(runtime.position, resolvedTarget) &&
      (runtime.currentPath.length <= 1 ||
        !sameCoord(runtime.currentPath[0], runtime.position) ||
        !sameCoord(runtime.currentPath[runtime.currentPath.length - 1], resolvedTarget));

    const needsReplan =
      resolvedTarget !== null &&
      !sameCoord(runtime.position, resolvedTarget) &&
      (blockedStep !== null || targetChanged || algorithmChanged || pathMissing || evidenceChanged);

    runtime.targetPosition = resolvedTarget;

    if (needsReplan && resolvedTarget) {
      const search = findPath(graph, algorithm, runtime.position, resolvedTarget, heuristic);
      searchExecuted = search;
      runtime.lastSearch = search;
      runtime.algorithmUsed = algorithm;
      runtime.heuristicUsed = heuristic;

      if (search.found) {
        runtime.currentPath = search.path.map((p) => ({ ...p }));
      } else {
        runtime.currentPath = [];
      }

      if (blockedStep) {
        planChanged = true;
        runtime.planChanges++;
        planChangeReason = `${runtime.id} replanned (${algorithm}/${heuristic}) around blocked cell (${blockedStep.row},${blockedStep.col}) -> (${resolvedTarget.row},${resolvedTarget.col}) [cost=${search.totalCost.toFixed(2)}, expanded=${search.expandedCount}]`;
      } else if (targetChanged || previousState !== runtime.state) {
        planChanged = true;
        runtime.planChanges++;
        planChangeReason = `${runtime.id} switched ${previousState} -> ${runtime.state} (${runtime.goalReason}) target (${resolvedTarget.row},${resolvedTarget.col}) [${algorithm}, expanded=${search.expandedCount}]`;
      } else if (algorithmChanged) {
        planChanged = true;
        runtime.planChanges++;
        planChangeReason = `${runtime.id} replanned with ${algorithm}/${heuristic} [expanded=${search.expandedCount}]`;
      }
    } else if (resolvedTarget && sameCoord(runtime.position, resolvedTarget)) {
      runtime.currentPath = [{ ...runtime.position }];
    }

    // 5. Execution stage
    const moveInterval =
      runtime.state === 'patrol' ? profile.patrolMoveEveryTicks : profile.activeMoveEveryTicks;
    const canMoveThisTick = tick - runtime.lastMoveTick >= moveInterval;

    if (!isScreamingHold && canMoveThisTick && runtime.currentPath.length > 1) {
      const nextStep = runtime.currentPath[1];
      if (graph.isWalkable(nextStep)) {
        runtime.position = { ...nextStep };
        runtime.currentPath.shift();
        runtime.lastMoveTick = tick;
        runtime.memoryStore.markPatrolVisited(nextStep, tick);
        moved = true;
      } else {
        runtime.memoryStore.recordBlockedCell(nextStep, tick);
        runtime.currentPath = [];
      }
    }

    // 6. Post-execution evaluation stage
    if (runtime.targetPosition && sameCoord(runtime.position, runtime.targetPosition)) {
      if (runtime.state === 'patrol') {
        runtime.patrolIndex =
          runtime.patrolWaypoints.length > 0
            ? (runtime.patrolIndex + 1) % runtime.patrolWaypoints.length
            : 0;
        runtime.targetPosition = null;
        runtime.currentPath = [];
      } else if (!isScreamingHold && freshTriggerSource !== 'vision' && !isDecoySound) {
        // Arrived at last known evidence without finding a live target: clear stale memory.
        runtime.memoryStore.clearActiveTarget();
        runtime.targetPosition = null;
        runtime.currentPath = [];
        runtime.state = 'patrol';
        runtime.alertDepth = 0;
        runtime.goalReason = 'target site cleared; resuming local patrol';
        planChanged = true;
        runtime.planChanges++;
        if (!planChangeReason) {
          planChangeReason = `${runtime.id} evaluated target (${runtime.position.row},${runtime.position.col}) empty and resumed patrol`;
        }
      }
    }

    return {
      snapshot: toAgentSnapshot(runtime),
      shouldBroadcastAlert,
      alertTarget,
      emittedSound,
      planChanged,
      planChangeReason,
      searchExecuted,
      moved,
    };
  }

  private executeRadioSurvivorCycle(
    runtime: AgentRuntimeState,
    nearbyThreat: GridCoord | null,
    tick: number
  ): AgentCycleOutput {
    const previousState = runtime.state;
    let planChanged = false;
    let planChangeReason: string | null = null;

    if (nearbyThreat) {
      runtime.state = 'alert';
      runtime.targetPosition = { ...nearbyThreat };
      runtime.memoryStore.recordEvidence({
        position: nearbyThreat,
        confidence: 0.9,
        lastSeenTick: tick,
        source: 'vision',
      });
      runtime.goalReason = 'alerting Mara: infected approaching refuge';
      runtime.perceptionSummary = `threat detected near refuge at (${nearbyThreat.row},${nearbyThreat.col})`;
    } else {
      runtime.memoryStore.tick(tick);
      runtime.state = 'idle';
      runtime.targetPosition = { ...runtime.homePosition };
      runtime.goalReason = 'maintaining shortwave radio inside refuge';
    }

    if (previousState !== runtime.state) {
      planChanged = true;
      runtime.planChanges++;
      planChangeReason = `${runtime.id} switched ${previousState} -> ${runtime.state} (${runtime.goalReason})`;
    }

    return {
      snapshot: toAgentSnapshot(runtime),
      shouldBroadcastAlert: false,
      alertTarget: null,
      emittedSound: null,
      planChanged,
      planChangeReason,
      searchExecuted: null,
      moved: false,
    };
  }

  private selectPursuitOrInterceptTarget(
    runtime: AgentRuntimeState,
    graph: WeightedGraph,
    baseFocus: GridCoord,
    hasAssignedFlank: boolean
  ): GridCoord {
    const profile = AGENT_PROFILES[runtime.role];
    if (!profile.canIntercept || hasAssignedFlank) {
      return { ...baseFocus };
    }

    const dist = gridDistance(runtime.position, baseFocus);
    if (dist <= 2) {
      return { ...baseFocus };
    }

    const vel = runtime.memoryStore.getEstimatedVelocity();
    if (vel.row === 0 && vel.col === 0) {
      return { ...baseFocus };
    }

    // Project up to 2 cells along locally observed trajectory to intercept escaping target.
    for (const lead of [2, 1]) {
      const projected: GridCoord = {
        row: baseFocus.row + vel.row * lead,
        col: baseFocus.col + vel.col * lead,
      };
      if (graph.isWalkable(projected)) {
        return projected;
      }
    }

    return { ...baseFocus };
  }

  private selectLocalPatrolTarget(
    runtime: AgentRuntimeState,
    graph: WeightedGraph,
    rng: SeededRng
  ): GridCoord | null {
    if (
      runtime.targetPosition &&
      graph.isWalkable(runtime.targetPosition) &&
      !sameCoord(runtime.position, runtime.targetPosition)
    ) {
      return runtime.targetPosition;
    }

    if (runtime.patrolWaypoints.length > 0) {
      // Pick the least recently visited walkable patrol waypoint.
      let best: GridCoord | null = null;
      let oldestTick = Infinity;
      for (let i = 0; i < runtime.patrolWaypoints.length; i++) {
        const idx = (runtime.patrolIndex + i) % runtime.patrolWaypoints.length;
        const candidate = runtime.patrolWaypoints[idx];
        if (!graph.isWalkable(candidate) || sameCoord(candidate, runtime.position)) continue;
        const lastVisited = runtime.memoryStore.getLastVisitedTick(candidate);
        if (lastVisited < oldestTick) {
          oldestTick = lastVisited;
          best = candidate;
          runtime.patrolIndex = idx;
        }
      }
      if (best) return { ...best };
    }

    // Fallback: pick an unexplored local neighbor using deterministic rng.
    const neighbors = graph.getNeighbors(runtime.position);
    if (neighbors.length === 0) return null;

    let bestNeighbor = rng.pick(neighbors).to;
    let oldest = runtime.memoryStore.getLastVisitedTick(bestNeighbor);
    for (const edge of neighbors) {
      const visitedTick = runtime.memoryStore.getLastVisitedTick(edge.to);
      if (visitedTick < oldest) {
        oldest = visitedTick;
        bestNeighbor = edge.to;
      }
    }
    return { ...bestNeighbor };
  }

  private findBlockedStepOnCurrentPath(
    path: readonly GridCoord[],
    graph: WeightedGraph
  ): GridCoord | null {
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1];
      const to = path[i];
      if (!graph.isWalkable(to)) return { ...to };

      if (graph.preventCornerCutting && from.row !== to.row && from.col !== to.col) {
        const rowSide = { row: to.row, col: from.col };
        const colSide = { row: from.row, col: to.col };
        if (!graph.isWalkable(rowSide)) return rowSide;
        if (!graph.isWalkable(colSide)) return colSide;
      }
    }
    return null;
  }
}
