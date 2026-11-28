import type { AgentRole, GridCoord, MapDefinition, SceneId } from '../contracts.ts';
import type { SeededRng } from '../graph/seededRng.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { buildOpaqueCellSet, gridDistance, hasLineOfSight } from '../agents/perception.ts';
import { runAStar } from '../algorithms/astar.ts';

export interface ScenePreset {
  id: SceneId;
  name: string;
  description: string;
  objective: string;
  explorerCount: number;
  pursuerCount: number;
  hordeFlankingEnabled: boolean;
  extractionWindowTicks: number;
}

export type PickupKind = 'medicine' | 'fuel' | 'battery';

export interface WorldPickup {
  id: string;
  kind: PickupKind;
  position: GridCoord;
  collected: boolean;
}

export type LootKind = 'ammo' | 'medkit';

export interface LootPickup {
  id: string;
  kind: LootKind;
  amount: number;
  position: GridCoord;
  collected: boolean;
}

export interface AgentSpawnConfig {
  id: string;
  role: AgentRole;
  position: GridCoord;
  patrolWaypoints?: GridCoord[];
}

export interface SceneLayout {
  refugePosition: GridCoord;
  pharmacyPosition: GridCoord;
  extractionPosition: GridCoord;
  pickups: WorldPickup[];
  lootPickups: LootPickup[];
  agents: AgentSpawnConfig[];
}

/**
 * Official 5-scene storyboard presets aligned with 02_refugio.pdf (El ultimo refugio).
 */
export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: 1,
    name: 'Ciudad silenciosa',
    description: 'Calles desiertas y desplazamiento silencioso; infectados exploran sin informacion global.',
    objective: 'Avanza en sigilo hacia la farmacia sin delatar tu posicion.',
    explorerCount: 2,
    pursuerCount: 1,
    hordeFlankingEnabled: false,
    extractionWindowTicks: 45,
  },
  {
    id: 2,
    name: 'La farmacia',
    description: 'Recoleccion de medicamentos; el ruido al mover suministros y escombros activa alertas locales.',
    objective: 'Recoge los medicamentos en la farmacia y sobrevive a la alerta de la horda.',
    explorerCount: 2,
    pursuerCount: 2,
    hordeFlankingEnabled: true,
    extractionWindowTicks: 45,
  },
  {
    id: 3,
    name: 'La horda',
    description: 'Cruce de calles con obstaculos; la horda distribuye aproximaciones sin concentrarse en una celda.',
    objective: 'Reune el combustible y la bateria cruzando el sector vigilado por la horda.',
    explorerCount: 3,
    pursuerCount: 3,
    hordeFlankingEnabled: true,
    extractionWindowTicks: 45,
  },
  {
    id: 4,
    name: 'El refugio',
    description: 'Instalacion de la bateria y activacion de la radio mientras la horda reacciona a senuelos y barricadas.',
    objective: 'Regresa al refugio, instala la bateria para activar la radio y protege sus defensas.',
    explorerCount: 3,
    pursuerCount: 3,
    hordeFlankingEnabled: true,
    extractionWindowTicks: 45,
  },
  {
    id: 5,
    name: 'Extraccion',
    description: 'La senal abre una ruta de escape temporal; los agentes persiguen, exploran o interceptan segun evidencias.',
    objective: 'Alcanza el punto de extraccion antes de que se cierre la ventana temporal.',
    explorerCount: 3,
    pursuerCount: 4,
    hordeFlankingEnabled: true,
    extractionWindowTicks: 45,
  },
];

export function getScenePreset(sceneId: SceneId): ScenePreset {
  const found = SCENE_PRESETS.find((preset) => preset.id === sceneId);
  return found ?? SCENE_PRESETS[0];
}

function sameCoord(a: GridCoord, b: GridCoord): boolean {
  return a.row === b.row && a.col === b.col;
}

function coordKey(coord: GridCoord): string {
  return `${coord.row},${coord.col}`;
}

/** Computes BFS-reachable walkable cells and hop distances from origin on the graph. */
export function computeReachableDistances(
  graph: WeightedGraph,
  origin: GridCoord
): { reachable: GridCoord[]; distances: Map<string, number>; maxDistance: number } {
  const distances = new Map<string, number>();
  const reachable: GridCoord[] = [];
  let maxDistance = 0;

  if (!graph.isWalkable(origin)) {
    return { reachable, distances, maxDistance };
  }

  const queue: GridCoord[] = [{ ...origin }];
  distances.set(coordKey(origin), 0);

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const currentDist = distances.get(coordKey(current))!;
    reachable.push(current);
    if (currentDist > maxDistance) maxDistance = currentDist;

    for (const edge of graph.getNeighbors(current)) {
      if (!graph.isWalkable(edge.to)) continue;
      const key = coordKey(edge.to);
      if (distances.has(key)) continue;
      distances.set(key, currentDist + 1);
      queue.push({ ...edge.to });
    }
  }

  return { reachable, distances, maxDistance };
}

/**
 * Distances (in cells) that pace both acts. The chain gap stays below the engine alert radius
 * (12 on fine grids, 7 on coarse ones) so every link of the pharmacy watch can relay an AlertHop.
 */
export interface ActSpacing {
  /** Pharmacy watch ring: close enough to hear the metal door, far enough not to stand in the shop. */
  ringMin: number;
  ringMax: number;
  /** Gap between consecutive watchers of the alert chain. */
  chainMin: number;
  chainMax: number;
  /** Cells around each infected treated as closed when checking that an escape route survives. */
  clearance: number;
  /** No infected spawns this close to the refuge or the extraction point. */
  keyPointGuard: number;
  /** Escape corridor cells (from the pharmacy) kept free of flanking slots. */
  escapeCorridor: number;
}

export function getActSpacing(map: Pick<MapDefinition, 'cellSize'>): ActSpacing {
  return map.cellSize <= 1
    ? { ringMin: 9, ringMax: 15, chainMin: 7, chainMax: 11, clearance: 2, keyPointGuard: 6, escapeCorridor: 8 }
    : { ringMin: 4, ringMax: 7, chainMin: 3, chainMax: 6, clearance: 1, keyPointGuard: 3, escapeCorridor: 4 };
}

/** True when a path from -> goal exists with every cell within `clearance` of a threat closed. */
export function hasEscapeRoute(
  graph: WeightedGraph,
  from: GridCoord,
  goal: GridCoord,
  threats: readonly GridCoord[],
  clearance: number
): boolean {
  const probe = graph.clone();
  for (const threat of threats) {
    for (let dr = -clearance; dr <= clearance; dr++) {
      for (let dc = -clearance; dc <= clearance; dc++) {
        const cell = { row: threat.row + dr, col: threat.col + dc };
        if (sameCoord(cell, from) || sameCoord(cell, goal) || !probe.isWalkable(cell)) continue;
        probe.setBlocked(cell, true);
      }
    }
  }
  return runAStar(probe, from, goal, 'octile').found;
}

/** First cells of the shortest route out of `from`; flanking slots never land on them. */
export function escapeCorridorCells(
  graph: WeightedGraph,
  from: GridCoord,
  goal: GridCoord,
  length: number
): GridCoord[] {
  const route = runAStar(graph, from, goal, 'octile');
  return route.found ? route.path.slice(1, 1 + length).map((cell) => ({ ...cell })) : [];
}

/**
 * Places infected around the pharmacy as a chain: each new watcher sits chainMin..chainMax from an
 * existing link (so the door slam relays hop by hop) and as far as possible from the rest (so the
 * recursion gets deeper than one hop). A candidate is rejected if it would seal every exit to escapeGoal.
 */
export function pickPharmacyWatchCells(
  graph: WeightedGraph,
  opaqueCells: ReadonlySet<number>,
  pharmacy: GridCoord,
  escapeGoal: GridCoord,
  candidates: readonly GridCoord[],
  anchors: readonly GridCoord[],
  others: readonly GridCoord[],
  count: number,
  spacing: ActSpacing,
  visionRange: number
): GridCoord[] {
  const ring = candidates.filter((cell) => {
    const d = gridDistance(cell, pharmacy);
    return (
      d >= spacing.ringMin &&
      d <= spacing.ringMax &&
      !hasLineOfSight(graph, cell, pharmacy, visionRange, opaqueCells)
    );
  });
  const relayRing = candidates.filter((cell) => {
    const d = gridDistance(cell, pharmacy);
    return (
      d >= spacing.ringMin &&
      d <= spacing.ringMax + spacing.chainMax &&
      !hasLineOfSight(graph, cell, pharmacy, visionRange, opaqueCells)
    );
  });
  const chain: GridCoord[] = anchors.filter((a) => gridDistance(a, pharmacy) <= spacing.ringMax + spacing.chainMax);
  const chosen: GridCoord[] = [];
  const tightChainMax = Math.max(4, spacing.chainMax - 3);

  while (chosen.length < count) {
    const links = [...chain, ...chosen];
    const source = links.length === 0 ? ring : relayRing;
    const match = (maxLink: number) =>
      source.filter(
        (cell) =>
          [...links, ...others].every((u) => gridDistance(u, cell) >= Math.min(3, spacing.chainMin)) &&
          (links.length === 0 ||
            links.some((l) => {
              const d = gridDistance(l, cell);
              return d >= Math.min(4, spacing.chainMin) && d <= maxLink;
            }))
      );
    const pool = match(tightChainMax).length > 0 ? match(tightChainMax) : match(spacing.chainMax);
    const spread = (cell: GridCoord): number => links.reduce((acc, l) => acc + gridDistance(l, cell), 0);
    pool.sort((a, b) => spread(b) - spread(a));
    const canChain = (cell: GridCoord): boolean =>
      relayRing.some((other) => {
        const d = gridDistance(cell, other);
        return (
          d >= Math.min(4, spacing.chainMin) &&
          d <= tightChainMax &&
          hasEscapeRoute(graph, pharmacy, escapeGoal, [...links, ...others, cell, other], spacing.clearance)
        );
      });
    const pick =
      (links.length === 0 && count > 1
        ? pool.find(
            (cell) =>
              hasEscapeRoute(graph, pharmacy, escapeGoal, [...links, ...others, cell], spacing.clearance) &&
              canChain(cell)
          )
        : undefined) ??
      pool.find((cell) =>
        hasEscapeRoute(graph, pharmacy, escapeGoal, [...links, ...others, cell], spacing.clearance)
      );
    if (!pick) break;
    chosen.push({ ...pick });
  }
  return chosen;
}

/**
 * Act II (start at scene 3): fuel and battery go to the yard mirrored from the refuge across the map
 * center, so the way back crosses the middle of the complex and its side doors.
 */
function pickOppositeSupplyCells(
  graph: WeightedGraph,
  candidates: readonly GridCoord[],
  refuge: GridCoord,
  spawn: GridCoord,
  pharmacy: GridCoord,
  extraction: GridCoord,
  map: MapDefinition,
  spacing: ActSpacing
): { fuel: GridCoord; battery: GridCoord } | null {
  const { distances, maxDistance } = computeReachableDistances(graph, refuge);
  if (maxDistance === 0) return null;
  const mirror: GridCoord = {
    row: Math.max(0, Math.min(map.height - 1, map.height - 1 - refuge.row)),
    col: Math.max(0, Math.min(map.width - 1, map.width - 1 - refuge.col)),
  };
  const pool = candidates.filter(
    (cell) =>
      (distances.get(coordKey(cell)) ?? 0) >= maxDistance * 0.55 &&
      gridDistance(cell, extraction) >= spacing.keyPointGuard * 2 &&
      gridDistance(cell, spawn) >= spacing.ringMax &&
      gridDistance(cell, pharmacy) >= 3
  );
  const byMirror = (a: GridCoord, b: GridCoord): number =>
    gridDistance(a, mirror) - gridDistance(b, mirror) || a.row - b.row || a.col - b.col;
  const fuel = [...pool].sort(byMirror)[0];
  if (!fuel) return null;
  // Battery goes deeper into the same yard: the farthest walk from the refuge near the fuel.
  const steps = (cell: GridCoord): number => distances.get(coordKey(cell)) ?? 0;
  const battery = pool
    .filter((cell) => {
      const d = gridDistance(cell, fuel);
      return d >= spacing.chainMin && d <= spacing.chainMax + 3;
    })
    .sort((a, b) => steps(b) - steps(a) || byMirror(a, b))[0];
  return battery ? { fuel: { ...fuel }, battery: { ...battery } } : null;
}

function findClosestCellOfType(
  map: MapDefinition,
  type: MapDefinition['cells'][number]['type'],
  reference: GridCoord
): GridCoord | null {
  let best: GridCoord | null = null;
  let bestDist = Infinity;
  for (const cell of map.cells) {
    if (cell.type !== type || !cell.walkable) continue;
    const d = gridDistance(cell, reference);
    if (d < bestDist) {
      bestDist = d;
      best = { row: cell.row, col: cell.col };
    }
  }
  return best;
}

function buildLocalPatrolWaypoints(
  origin: GridCoord,
  walkableCells: readonly GridCoord[],
  safeAvoid: GridCoord,
  rng: SeededRng,
  scale = 1,
  avoidDist = 3 * scale
): GridCoord[] {
  const minDist = 2 * scale;
  const maxDist = 6 * scale;
  const nearby = walkableCells.filter(
    (cell) =>
      gridDistance(origin, cell) >= minDist &&
      gridDistance(origin, cell) <= maxDist &&
      gridDistance(cell, safeAvoid) >= avoidDist
  );

  const pool =
    nearby.length >= 3
      ? [...nearby]
      : walkableCells.filter((c) => gridDistance(c, safeAvoid) >= Math.max(2, scale));
  rng.shuffle(pool);

  const waypoints: GridCoord[] = [{ ...origin }];
  for (const candidate of pool) {
    if (waypoints.length >= 4) break;
    if (waypoints.every((wp) => gridDistance(wp, candidate) >= minDist)) {
      waypoints.push({ ...candidate });
    }
  }

  return waypoints;
}

/**
 * Dynamically derives key scene points, supply pickups, loot, and safe anti-omniscience spawns
 * for any valid MapDefinition (10x10, 20x20, 32x32, 50x50, or map_street).
 */
export function buildSceneLayout(
  map: MapDefinition,
  graph: WeightedGraph,
  sceneId: SceneId,
  rng: SeededRng,
  customAgents?: readonly AgentSpawnConfig[]
): SceneLayout {
  const preset = getScenePreset(sceneId);
  const opaqueCells = buildOpaqueCellSet(map);
  const isFineGrid = map.cellSize <= 1;
  const patrolScale = isFineGrid ? 2 : 1;
  const center: GridCoord = {
    row: Math.floor(map.height / 2),
    col: Math.floor(map.width / 2),
  };

  const allWalkable: GridCoord[] = map.cells
    .filter((cell) => cell.walkable)
    .map((cell) => ({ row: cell.row, col: cell.col }));

  const { reachable, distances, maxDistance } = computeReachableDistances(graph, map.spawnMara);
  const walkableCells = reachable.length > 0 ? reachable : allWalkable;

  const refugePosition =
    findClosestCellOfType(map, 'refuge', map.spawnMara) ?? { ...map.spawnMara };

  const pharmacyPosition =
    findClosestCellOfType(map, 'pharmacy', center) ??
    walkableCells
      .filter((c) => gridDistance(c, map.spawnMara) >= 3 && !sameCoord(c, map.extractionPoint))
      .sort((a, b) => gridDistance(a, center) - gridDistance(b, center))[0] ??
    { ...map.spawnMara };

  const extractionPosition: GridCoord = { ...map.extractionPoint };

  const reserved: GridCoord[] = [
    map.spawnMara,
    refugePosition,
    pharmacyPosition,
    extractionPosition,
  ];
  const isReserved = (cell: GridCoord): boolean => reserved.some((r) => sameCoord(r, cell));

  const pharmacySteps = distances.get(coordKey(pharmacyPosition)) ?? 0;
  const useCorridorPacing = maxDistance >= 24 || pharmacySteps >= 12;

  const pickByCorridorOrAnchor = (
    targetFraction: number,
    anchor: GridCoord,
    minDistFromSpawn: number,
    avoidCells: readonly GridCoord[],
    minAvoidDist: number
  ): GridCoord => {
    const unreserved = walkableCells.filter((cell) => !isReserved(cell));

    if (useCorridorPacing) {
      const targetSteps = Math.round(maxDistance * targetFraction);
      const filterTier = (minSpawnSteps: number, gap: number): GridCoord[] =>
        unreserved.filter(
          (cell) =>
            (distances.get(coordKey(cell)) ?? 0) >= minSpawnSteps &&
            avoidCells.every((a) => gridDistance(cell, a) >= gap)
        );

      let pool = filterTier(minDistFromSpawn, minAvoidDist);
      if (pool.length === 0) pool = filterTier(Math.floor(minDistFromSpawn * 0.5), 1);
      if (pool.length === 0) pool = unreserved;

      pool.sort((a, b) => {
        const da = Math.abs((distances.get(coordKey(a)) ?? maxDistance) - targetSteps);
        const db = Math.abs((distances.get(coordKey(b)) ?? maxDistance) - targetSteps);
        return da - db || gridDistance(a, anchor) - gridDistance(b, anchor);
      });

      const chosen = pool[0] ?? walkableCells[walkableCells.length - 1] ?? { ...map.spawnMara };
      reserved.push(chosen);
      return { ...chosen };
    }

    const candidates = unreserved
      .filter((cell) => gridDistance(cell, map.spawnMara) >= minDistFromSpawn)
      .sort((a, b) => gridDistance(a, anchor) - gridDistance(b, anchor));

    const chosen = candidates[0] ?? unreserved[0] ?? walkableCells[walkableCells.length - 1] ?? { ...map.spawnMara };
    reserved.push(chosen);
    return { ...chosen };
  };

  const fuelMinSpawn = useCorridorPacing
    ? Math.min(pharmacySteps + 2, Math.max(0, maxDistance - 4))
    : Math.min(3, Math.floor(map.width / 3));
  let fuelPosition = pickByCorridorOrAnchor(0.62, center, fuelMinSpawn, [extractionPosition], 4);

  const batteryAnchor: GridCoord = {
    row: Math.min(map.height - 1, Math.floor(map.height * 0.65)),
    col: Math.min(map.width - 1, Math.floor(map.width * 0.65)),
  };
  const batteryMinSpawn = useCorridorPacing
    ? Math.min(pharmacySteps + 4, Math.max(0, maxDistance - 3))
    : Math.min(4, Math.floor(map.width / 2));
  let batteryPosition = pickByCorridorOrAnchor(
    0.82,
    batteryAnchor,
    batteryMinSpawn,
    [extractionPosition, fuelPosition],
    4
  );

  const spacing = getActSpacing(map);
  if (sceneId === 3) {
    const opposite = pickOppositeSupplyCells(
      graph,
      walkableCells.filter((cell) => !isReserved(cell)),
      refugePosition,
      map.spawnMara,
      pharmacyPosition,
      extractionPosition,
      map,
      spacing
    );
    if (opposite) {
      fuelPosition = opposite.fuel;
      batteryPosition = opposite.battery;
      reserved.push(fuelPosition, batteryPosition);
    }
  }

  const pickups: WorldPickup[] = [
    {
      id: 'pickup-medicine',
      kind: 'medicine',
      position: { ...pharmacyPosition },
      collected: sceneId >= 3,
    },
    {
      id: 'pickup-fuel',
      kind: 'fuel',
      position: fuelPosition,
      collected: sceneId >= 4,
    },
    {
      id: 'pickup-battery',
      kind: 'battery',
      position: batteryPosition,
      collected: sceneId >= 4,
    },
  ];

  const lootSpecs: ReadonlyArray<{ kind: LootKind; amount: number; fraction: number }> =
    walkableCells.length >= 100
      ? [
          { kind: 'ammo', amount: 12, fraction: 0.18 },
          { kind: 'medkit', amount: 35, fraction: 0.36 },
          { kind: 'ammo', amount: 12, fraction: 0.54 },
          { kind: 'medkit', amount: 35, fraction: 0.72 },
          { kind: 'ammo', amount: 12, fraction: 0.88 },
        ]
      : walkableCells.length >= 12
        ? [
            { kind: 'ammo', amount: 12, fraction: 0.35 },
            { kind: 'medkit', amount: 35, fraction: 0.65 },
          ]
        : [];

  const lootPickups: LootPickup[] = [];
  const lootSpacing = 3 * patrolScale;
  for (let i = 0; i < lootSpecs.length; i++) {
    const spec = lootSpecs[i];
    const unreserved = walkableCells.filter((cell) => !isReserved(cell));
    if (unreserved.length === 0) break;

    const targetSteps = Math.max(1, Math.round(maxDistance * spec.fraction));
    const spaced = unreserved.filter((cell) =>
      lootPickups.every((existing) => gridDistance(cell, existing.position) >= lootSpacing)
    );
    const pool = spaced.length > 0 ? spaced : unreserved;
    pool.sort((a, b) => {
      const da = Math.abs((distances.get(coordKey(a)) ?? maxDistance) - targetSteps);
      const db = Math.abs((distances.get(coordKey(b)) ?? maxDistance) - targetSteps);
      return da - db || a.row - b.row || a.col - b.col;
    });

    const chosen = { ...pool[0] };
    reserved.push(chosen);
    lootPickups.push({
      id: `loot-${spec.kind}-${i + 1}`,
      kind: spec.kind,
      amount: spec.amount,
      position: chosen,
      collected: false,
    });
  }

  if (customAgents) {
    return {
      refugePosition,
      pharmacyPosition,
      extractionPosition,
      pickups,
      lootPickups,
      agents: customAgents.map((a) => ({
        ...a,
        position: { ...a.position },
        patrolWaypoints: a.patrolWaypoints
          ? a.patrolWaypoints.map((wp) => ({ ...wp }))
          : buildLocalPatrolWaypoints(a.position, allWalkable, map.spawnMara, rng, patrolScale),
      })),
    };
  }

  const agents: AgentSpawnConfig[] = [
    {
      id: 'survivor-radio',
      role: 'radio_survivor',
      position: { ...refugePosition },
      patrolWaypoints: [{ ...refugePosition }],
    },
  ];

  // Filter infected spawn candidates outside initial LOS and safe distance from Mara's spawn.
  const visionCheckRange = isFineGrid ? 11 : 6;
  const minSpawnDist = isFineGrid
    ? 10
    : Math.max(4, Math.min(7, Math.floor(Math.min(map.width, map.height) * 0.45)));

  const awayFromKeyPoints = (cell: GridCoord): boolean =>
    gridDistance(cell, refugePosition) >= spacing.keyPointGuard &&
    gridDistance(cell, extractionPosition) >= spacing.keyPointGuard;

  const stealthSafeCandidates = walkableCells.filter(
    (cell) =>
      gridDistance(cell, map.spawnMara) >= minSpawnDist &&
      awayFromKeyPoints(cell) &&
      !hasLineOfSight(graph, cell, map.spawnMara, visionCheckRange, opaqueCells)
  );

  const midSafeCandidates = walkableCells.filter(
    (cell) =>
      gridDistance(cell, map.spawnMara) >= (isFineGrid ? 6 : 3) &&
      awayFromKeyPoints(cell) &&
      !hasLineOfSight(graph, cell, map.spawnMara, visionCheckRange, opaqueCells)
  );

  const fallbackCandidates = walkableCells.filter(
    (cell) =>
      gridDistance(cell, map.spawnMara) >= 3 &&
      !sameCoord(cell, refugePosition)
  );

  const spawnPool =
    stealthSafeCandidates.length > 0
      ? [...stealthSafeCandidates]
      : midSafeCandidates.length > 0
        ? [...midSafeCandidates]
        : [...fallbackCandidates];
  rng.shuffle(spawnPool);

  const minSpacing = isFineGrid ? 3 : 2;
  const usedSpawns: GridCoord[] = [map.spawnMara, refugePosition];
  const takeSpawn = (): GridCoord | null => {
    for (const spacing of [minSpacing, 2]) {
      for (const candidate of spawnPool) {
        if (usedSpawns.every((u) => gridDistance(u, candidate) >= spacing)) {
          usedSpawns.push(candidate);
          return { ...candidate };
        }
      }
    }
    for (const candidate of spawnPool) {
      if (usedSpawns.every((u) => !sameCoord(u, candidate))) {
        usedSpawns.push(candidate);
        return { ...candidate };
      }
    }
    return null;
  };

  const maxInfectedForMap = Math.max(2, Math.floor(walkableCells.length / 10));
  const totalRequested = preset.explorerCount + preset.pursuerCount;
  const scale = totalRequested > maxInfectedForMap ? maxInfectedForMap / totalRequested : 1;
  const explorerCount = Math.max(1, Math.round(preset.explorerCount * scale));
  const pursuerCount = Math.max(1, Math.round(preset.pursuerCount * scale));

  // Act I: explorers watch the pharmacy as an alert chain so the metal door relays visibly.
  // They stay off the direct approach and out of sight of it so a stealth player can sneak in.
  const hasPharmacy = sceneId <= 2 && map.cells.some((cell) => cell.type === 'pharmacy');
  const approach = hasPharmacy ? runAStar(graph, map.spawnMara, pharmacyPosition, 'octile').path : [];
  const unseenByApproach = (cell: GridCoord): boolean =>
    approach.every(
      (step) =>
        gridDistance(step, cell) > visionCheckRange ||
        !hasLineOfSight(graph, cell, step, visionCheckRange, opaqueCells)
    );
  const offApproach = spawnPool.filter(
    (cell) =>
      approach.every((step) => gridDistance(step, cell) >= spacing.ringMin - 3) &&
      unseenByApproach(cell)
  );
  const pharmacyDoorway = hasPharmacy ? escapeCorridorCells(graph, pharmacyPosition, extractionPosition, 8) : [];
  const offDoorway = (cell: GridCoord): boolean =>
    pharmacyDoorway.every((step) => gridDistance(step, cell) > spacing.clearance + 1);
  let watchCells = hasPharmacy
    ? pickPharmacyWatchCells(
        graph,
        opaqueCells,
        pharmacyPosition,
        extractionPosition,
        offApproach.filter(offDoorway),
        [],
        [],
        explorerCount,
        spacing,
        visionCheckRange
      )
    : [];
  if (hasPharmacy && watchCells.length < explorerCount) {
    const wider = spawnPool.filter(
      (cell) =>
        offDoorway(cell) &&
        unseenByApproach(cell) &&
        approach.every((step) => gridDistance(step, cell) >= Math.max(3, spacing.ringMin - 5))
    );
    const extra = pickPharmacyWatchCells(
      graph,
      opaqueCells,
      pharmacyPosition,
      extractionPosition,
      wider,
      watchCells,
      [],
      explorerCount - watchCells.length,
      spacing,
      visionCheckRange
    );
    watchCells = [...watchCells, ...extra];
  }
  usedSpawns.push(...watchCells);

  const actOnePatrolCells = hasPharmacy
    ? walkableCells.filter(
        (cell) =>
          offDoorway(cell) &&
          unseenByApproach(cell) &&
          gridDistance(cell, pharmacyPosition) >= spacing.ringMin - 1
      )
    : walkableCells;
  const safePatrolPool = actOnePatrolCells.length >= 6 ? actOnePatrolCells : walkableCells;
  const actOnePursuerPool = hasPharmacy
    ? spawnPool.filter(
        (cell) =>
          gridDistance(cell, pharmacyPosition) >= spacing.ringMax + 4 &&
          offDoorway(cell) &&
          unseenByApproach(cell)
      )
    : [];
  const takeFromPool = (pool: readonly GridCoord[]): GridCoord | null => {
    for (const gap of [minSpacing, 2]) {
      for (const candidate of pool) {
        if (usedSpawns.every((u) => gridDistance(u, candidate) >= gap)) {
          usedSpawns.push(candidate);
          return { ...candidate };
        }
      }
    }
    return null;
  };
  const takeActOnePursuer = (): GridCoord | null =>
    (actOnePursuerPool.length > 0 ? takeFromPool(actOnePursuerPool) : null) ?? takeSpawn();

  // Act II: pursuers hold the middle band between the supplies and the refuge (the side doors).
  const refugeSteps = sceneId === 3 ? computeReachableDistances(graph, refugePosition).distances : null;
  const supplySteps = refugeSteps
    ? Math.min(refugeSteps.get(coordKey(fuelPosition)) ?? 0, refugeSteps.get(coordKey(batteryPosition)) ?? 0)
    : 0;
  const takeMiddleSpawn = (): GridCoord | null => {
    if (!refugeSteps || supplySteps === 0) return hasPharmacy ? takeActOnePursuer() : takeSpawn();
    for (const candidate of spawnPool) {
      const steps = refugeSteps.get(coordKey(candidate)) ?? 0;
      if (
        steps >= supplySteps * 0.35 &&
        steps <= supplySteps * 0.75 &&
        usedSpawns.every((u) => gridDistance(u, candidate) >= minSpacing)
      ) {
        usedSpawns.push(candidate);
        return { ...candidate };
      }
    }
    return takeSpawn();
  };

  for (let i = 1; i <= explorerCount; i++) {
    const watcher = watchCells[i - 1];
    const pos = watcher ?? (hasPharmacy ? takeActOnePursuer() : takeSpawn());
    if (!pos) break;
    agents.push({
      id: `explorer-${i}`,
      role: 'explorer',
      position: pos,
      // Watchers patrol tightly around their post, never into the shop or out of relay range.
      patrolWaypoints: watcher
        ? buildLocalPatrolWaypoints(pos, safePatrolPool, pharmacyPosition, rng, 0.5, spacing.ringMin - 1)
        : buildLocalPatrolWaypoints(pos, walkableCells, map.spawnMara, rng, patrolScale),
    });
  }

  for (let i = 1; i <= pursuerCount; i++) {
    const pos = takeMiddleSpawn();
    if (!pos) break;
    agents.push({
      id: `pursuer-${i}`,
      role: 'pursuer',
      position: pos,
      patrolWaypoints: hasPharmacy
        ? buildLocalPatrolWaypoints(pos, safePatrolPool, pharmacyPosition, rng, 1, spacing.ringMin - 1)
        : buildLocalPatrolWaypoints(pos, walkableCells, map.spawnMara, rng, patrolScale),
    });
  }

  return {
    refugePosition,
    pharmacyPosition,
    extractionPosition,
    pickups,
    lootPickups,
    agents,
  };
}
