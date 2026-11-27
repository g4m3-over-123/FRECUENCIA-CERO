import './ui/styles.css';
import type { GridCoord, SoundEvent } from './core/contracts.ts';
import { parseMapDefinition } from './core/graph/mapLoader.ts';
import { SimulationEngine, type ExtendedWorldSnapshot } from './core/gameplay/SimulationEngine.ts';
import { MockWorld } from './dev/mockSnapshot.ts';
import { GameLoop, tickMsForMap, type SimulationSource } from './game/GameLoop.ts';
import type { AgentView, DebugView } from './game/views.ts';
import { AudioManager, type AudioCue } from './render/AudioManager.ts';
import { SceneManager } from './render/SceneManager.ts';
import { AgentCapsules } from './render/characters/AgentCapsules.ts';
import { DebugVisuals } from './render/debug/DebugVisuals.ts';
import { PlayerController } from './render/player/PlayerController.ts';
import { WeaponController } from './render/weapons/WeaponController.ts';
import { WorldBuilder } from './render/world/WorldBuilder.ts';
import { WorldStateView } from './render/world/WorldStateView.ts';
import { GameHud } from './ui/GameHud.ts';
import {
  MonitorPanel,
  type MonitorMapId,
  type MonitorSearchComparison,
  type MonitorTelemetry,
} from './ui/MonitorPanel.ts';

/**
 * Integration entry point (shared base, coordinate changes with the team). URL parameters:
 *   ?map=map_street|map_small|map_medium|map_large   (default map_street)
 *   ?mock=1        fake snapshots instead of the SimulationEngine (render/HUD work)
 *   ?seed=1337     simulation seed
 *   ?autostart=1   skip the start dialog (demos, headless checks)
 *   ?xray=1        start with the X-ray overlay on
 */

const params = new URLSearchParams(window.location.search);
const mapId = params.get('map') ?? 'map_street';
const useMock = params.get('mock') === '1';
const autostart = params.get('autostart') === '1';
const seed = Number(params.get('seed') ?? 1337);
const KNOWN_MAPS: readonly MonitorMapId[] = ['map_street', 'map_small', 'map_medium', 'map_large'];

const key = (cell: GridCoord): string => `${cell.row},${cell.col}`;

/** Maps engine sound ids to the clips in public/assets/audio/. Front B owns the final mapping. */
function cueForSound(sound: SoundEvent): Exclude<AudioCue, 'ambient'> | undefined {
  const id = sound.sourceId;
  if (id === 'mara_step' || id === 'mara_sprint') return 'step';
  if (id === 'pharmacy_metal_door') return 'metal_door';
  if (/^decoy-\d+$/.test(id)) return 'decoy';
  if (id === 'barricade_place') return 'barricade';
  if (id.startsWith('refuge_radio') || id.startsWith('radio_')) return 'radio';
  return undefined;
}

async function loadMap(id: string) {
  const response = await fetch(`${import.meta.env.BASE_URL}maps/${id}.json`);
  if (!response.ok) throw new Error(`Map ${id} not found (${response.status})`);
  return parseMapDefinition(await response.json());
}

async function bootstrap(): Promise<void> {
  const appRoot = document.getElementById('app');
  if (!appRoot) throw new Error('Root element #app not found');

  const viewport = document.createElement('div');
  viewport.className = 'scene-viewport';
  const gameHudContainer = document.createElement('div');
  const hudContainer = document.createElement('div');
  hudContainer.className = 'hud-overlay';
  appRoot.append(viewport, gameHudContainer, hudContainer);

  const map = await loadMap(mapId);
  const sceneManager = new SceneManager(viewport, { autoloadStreetPreview: false });
  sceneManager.setPreviewWalkEnabled(false);
  const scene = sceneManager.scene;

  const world = new WorldBuilder(scene);
  await world.build(map);

  const source: SimulationSource = useMock ? new MockWorld(map, seed) : new SimulationEngine(map, 1, { seed });
  const loop = new GameLoop(source, tickMsForMap(map));

  const worldState = new WorldStateView(scene, map);
  const agents: AgentView = new AgentCapsules(scene, map);
  const xray: DebugView = new DebugVisuals(scene, map);
  const hud = new GameHud(gameHudContainer);

  let barricades = new Set<string>();
  loop.onTick((snapshot) => {
    barricades = new Set(snapshot.barricades.map(key));
  });

  const player = new PlayerController(sceneManager, map, (command) => loop.send(command), {
    isDynamicallyBlocked: (cell) => barricades.has(key(cell)),
    canSprint: () => loop.latest().mara.stamina >= 8,
  });
  const weapon = new WeaponController(
    sceneManager,
    {
      agents: () => agents.getHitTargets(),
      world: () => [...world.getCollidables(), ...worldState.getCollidables()],
      ammoInMagazine: () => loop.latest().mara.weapon.ammoInMagazine,
    },
    (command) => loop.send(command)
  );
  weapon.onShot((shot) => {
    if (shot.hitAgentId) hud.showHitMarker();
  });
  player.spawn(map.spawnMara);

  // Live Dijkstra vs A* for the monitor: one agent every few ticks, same graph and endpoints.
  const comparisons = new Map<string, MonitorSearchComparison>();
  let compareCursor = 0;
  loop.onTick((snapshot) => {
    if (!source.compareAlgorithms || snapshot.tick % 8 !== 0) return;
    const candidates = snapshot.agents.filter(
      (a) =>
        a.role !== 'radio_survivor' &&
        a.state !== 'dead' &&
        a.targetPosition !== null &&
        (a.targetPosition.row !== a.position.row || a.targetPosition.col !== a.position.col)
    );
    if (candidates.length === 0) return;
    const agent = candidates[compareCursor++ % candidates.length];
    const result = source.compareAlgorithms(agent.position, agent.targetPosition!);
    comparisons.set(agent.id, { origin: agent.position, destination: agent.targetPosition!, ...result });
  });

  const telemetry = (snapshot: ExtendedWorldSnapshot): MonitorTelemetry => ({
    objective: snapshot.sceneObjective,
    hasFuel: snapshot.mara.hasFuel,
    hasBattery: snapshot.mara.hasBattery,
    decoys: snapshot.mara.decoysRemaining,
    barricades: snapshot.mara.barricadesRemaining,
    coordinationEnabled: snapshot.coordinationEnabled,
    xrayEnabled: xray.isEnabled(),
    outcome: snapshot.status,
    agents: Object.fromEntries(
      snapshot.agents.map((a) => [
        a.id,
        {
          perception: a.perceptionSummary,
          ...(a.lastSearch ? { search: a.lastSearch } : {}),
          ...(comparisons.has(a.id) ? { comparison: comparisons.get(a.id)! } : {}),
        },
      ])
    ),
  });

  const setPlaying = (playing: boolean): void => {
    player.setEnabled(playing);
    weapon.setEnabled(playing);
  };

  const startGame = (): void => {
    loop.start();
    setPlaying(true);
    sceneManager.lockPointer();
  };

  const panel = new MonitorPanel(
    hudContainer,
    {
      onStart: startGame,
      onRestart: () => {
        comparisons.clear();
        loop.reset();
        player.spawn(map.spawnMara);
        startGame();
      },
      onPauseChange: (paused) => {
        source.setPaused(paused);
        loop.refresh();
        panel.update(loop.latest(), telemetry(loop.latest()));
      },
      onAlgorithmChange: (algorithm) => {
        source.setAlgorithm(algorithm, loop.latest().heuristic);
        loop.refresh();
        panel.update(loop.latest(), telemetry(loop.latest()));
      },
      onCoordinationChange: (enabled) => {
        source.setCoordinationEnabled(enabled);
        loop.refresh();
        panel.update(loop.latest(), telemetry(loop.latest()));
      },
      onXrayChange: (enabled) => {
        xray.setEnabled(enabled);
        panel.update(loop.latest(), telemetry(loop.latest()));
      },
      onDecoy: () => loop.send({ type: 'decoy' }),
      onBarricade: () => loop.send({ type: 'barricade' }),
      onMapChange: (next) => {
        const query = new URLSearchParams(window.location.search);
        query.set('map', next.id);
        window.location.search = query.toString();
      },
    },
    new AudioManager(cueForSound)
  );
  if ((KNOWN_MAPS as readonly string[]).includes(map.id)) panel.showMap(map.id as MonitorMapId);
  panel.update(loop.latest(), telemetry(loop.latest()));

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (event.repeat) return;
    switch (event.code) {
      case 'Tab':
        event.preventDefault();
        xray.setEnabled(!xray.isEnabled());
        panel.update(loop.latest(), telemetry(loop.latest()));
        break;
      case 'KeyG':
        world.toggleGridOverlay();
        break;
      case 'KeyM':
        hudContainer.hidden = !hudContainer.hidden;
        if (!hudContainer.hidden) sceneManager.unlockPointer();
        break;
      case 'KeyQ':
        if (loop.isRunning()) loop.send({ type: 'decoy' });
        break;
      case 'KeyE':
        if (loop.isRunning()) loop.send({ type: 'barricade' });
        break;
      case 'KeyP':
        source.setPaused(!loop.latest().paused);
        loop.refresh();
        break;
    }
  });

  if (params.get('xray') === '1') xray.setEnabled(true);
  if (autostart) {
    panel.closeDialog();
    loop.start();
    setPlaying(true);
  }

  let lastStatus = loop.latest().status;
  sceneManager.start((dt) => {
    if (loop.isRunning() && loop.latest().status === 'playing') player.update(dt);
    const frame = loop.frame(dt);
    worldState.update(frame.current, dt);
    agents.sync(frame);
    xray.sync(frame);
    weapon.update(dt);
    hud.update(loop.latest(), sceneManager.isPointerLocked(), dt);
    if (frame.ticked) panel.update(frame.current, telemetry(frame.current));
    if (frame.current.status !== lastStatus) {
      lastStatus = frame.current.status;
      if (lastStatus !== 'playing') {
        setPlaying(false);
        sceneManager.unlockPointer();
        panel.update(frame.current, telemetry(frame.current));
      }
    }
  });

  if (import.meta.env.DEV) {
    // Console helpers for the team: __game.loop.latest(), __game.weapon.fire(), ...
    Object.assign(window, { __game: { map, source, loop, player, weapon, world, xray, sceneManager } });
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  const message = document.createElement('pre');
  message.style.cssText = 'color:#f87171;padding:16px;white-space:pre-wrap';
  message.textContent = `No se pudo iniciar el juego:\n${String(error)}`;
  document.body.appendChild(message);
});
