import type { AgentRole, GridCoord, MapDefinition, SceneId } from '../contracts.ts';
import type { SeededRng } from '../graph/seededRng.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { buildOpaqueCellSet, gridDistance, hasLineOfSight } from '../agents/perception.ts';

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
    description: 'Recoleccion de medicamentos; una puerta metalica ruidosa activa alertas locales.',
    objective: 'Recoge los medicamentos en la farmacia y sobrevive al ruido de la puerta metalica.',
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
  rng: SeededRng
): GridCoord[] {
  const nearby = walkableCells.filter(
    (cell) =>
      gridDistance(origin, cell) >= 2 &&
      gridDistance(origin, cell) <= 6 &&
      gridDistance(cell, safeAvoid) >= 3
  );

  const pool = nearby.length >= 3 ? [...nearby] : walkableCells.filter((c) => gridDistance(c, safeAvoid) >= 2);
  rng.shuffle(pool);

  const waypoints: GridCoord[] = [{ ...origin }];
  for (const candidate of pool) {
    if (waypoints.length >= 4) break;
    if (waypoints.every((wp) => gridDistance(wp, candidate) >= 2)) {
      waypoints.push({ ...candidate });
    }
  }

  return waypoints;
}

/**
 * Dynamically derives key scene points, supply pickups, and safe anti-omniscience spawns
 * for any valid MapDefinition (10x10, 20x20, 32x32, 50x50).
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
  const center: GridCoord = {
    row: Math.floor(map.height / 2),
    col: Math.floor(map.width / 2),
  };

  const walkableCells: GridCoord[] = map.cells
    .filter((cell) => cell.walkable)
    .map((cell) => ({ row: cell.row, col: cell.col }));

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

  const pickDistinctWalkable = (anchor: GridCoord, minDistFromSpawn: number): GridCoord => {
    const candidates = walkableCells
      .filter(
        (cell) =>
          gridDistance(cell, map.spawnMara) >= minDistFromSpawn &&
          reserved.every((r) => !sameCoord(r, cell))
      )
      .sort((a, b) => gridDistance(a, anchor) - gridDistance(b, anchor));

    const chosen = candidates[0] ?? walkableCells[walkableCells.length - 1] ?? { ...map.spawnMara };
    reserved.push(chosen);
    return { ...chosen };
  };

  const fuelPosition = pickDistinctWalkable(center, Math.min(3, Math.floor(map.width / 3)));
  const batteryAnchor: GridCoord = {
    row: Math.min(map.height - 1, Math.floor(map.height * 0.65)),
    col: Math.min(map.width - 1, Math.floor(map.width * 0.65)),
  };
  const batteryPosition = pickDistinctWalkable(batteryAnchor, Math.min(4, Math.floor(map.width / 2)));

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

  if (customAgents) {
    return {
      refugePosition,
      pharmacyPosition,
      extractionPosition,
      pickups,
      agents: customAgents.map((a) => ({
        ...a,
        position: { ...a.position },
        patrolWaypoints: a.patrolWaypoints
          ? a.patrolWaypoints.map((wp) => ({ ...wp }))
          : buildLocalPatrolWaypoints(a.position, walkableCells, map.spawnMara, rng),
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
  const minSpawnDist = Math.max(4, Math.min(7, Math.floor(Math.min(map.width, map.height) * 0.45)));
  const stealthSafeCandidates = walkableCells.filter(
    (cell) =>
      gridDistance(cell, map.spawnMara) >= minSpawnDist &&
      !sameCoord(cell, refugePosition) &&
      !hasLineOfSight(graph, cell, map.spawnMara, 6, opaqueCells)
  );

  const fallbackCandidates = walkableCells.filter(
    (cell) =>
      gridDistance(cell, map.spawnMara) >= 3 &&
      !sameCoord(cell, refugePosition)
  );

  const spawnPool = stealthSafeCandidates.length > 0 ? [...stealthSafeCandidates] : [...fallbackCandidates];
  rng.shuffle(spawnPool);

  const usedSpawns: GridCoord[] = [map.spawnMara, refugePosition];
  const takeSpawn = (): GridCoord | null => {
    for (const candidate of spawnPool) {
      if (usedSpawns.every((u) => gridDistance(u, candidate) >= 2)) {
        usedSpawns.push(candidate);
        return { ...candidate };
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

  for (let i = 1; i <= explorerCount; i++) {
    const pos = takeSpawn();
    if (!pos) break;
    agents.push({
      id: `explorer-${i}`,
      role: 'explorer',
      position: pos,
      patrolWaypoints: buildLocalPatrolWaypoints(pos, walkableCells, map.spawnMara, rng),
    });
  }

  for (let i = 1; i <= pursuerCount; i++) {
    const pos = takeSpawn();
    if (!pos) break;
    agents.push({
      id: `pursuer-${i}`,
      role: 'pursuer',
      position: pos,
      patrolWaypoints: buildLocalPatrolWaypoints(pos, walkableCells, map.spawnMara, rng),
    });
  }

  return {
    refugePosition,
    pharmacyPosition,
    extractionPosition,
    pickups,
    agents,
  };
}
