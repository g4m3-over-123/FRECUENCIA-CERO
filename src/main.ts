import './ui/styles.css';
import type { GridCoord, SceneId, SoundEvent } from './core/contracts.ts';
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
import { GameGuide } from './ui/GameGuide.ts';
import { GameHud } from './ui/GameHud.ts';
import {
  MonitorPanel,
  type MonitorAct,
  type MonitorMapId,
  type MonitorSearchComparison,
  type MonitorTelemetry,
} from './ui/MonitorPanel.ts';

/**
 * Integration entry point (shared base, coordinate changes with the team). URL parameters:
 *   ?map=map_street|map_industrial|map_small|map_medium|map_large   (default map_street)
 *   ?scene=1..5    initial storyboard scene (default 1; Act II starts at 3)
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
const initialScene = parseScene(params.get('scene'), mapId);
const KNOWN_MAPS: readonly MonitorMapId[] = ['map_street', 'map_industrial', 'map_small', 'map_medium', 'map_large'];

/** Act I (street + pharmacy) hands over to Act II (industrial complex, scene 3) at the avenue exit. */
const ACT_TRANSITION_MS = 3000;
const RADIO_CUT_MS = 4000;
const INTRO_CUT_MS = 3500;

function parseScene(raw: string | null, map: string): SceneId {
  const fallback: SceneId = map === 'map_industrial' ? 3 : 1;
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return (Number.isInteger(value) && value >= 1 && value <= 5 ? value : fallback) as SceneId;
}

function actUrl(act: MonitorAct): string {
  const query = new URLSearchParams();
  query.set('map', act === 'act1' ? 'map_street' : 'map_industrial');
  query.set('scene', act === 'act1' ? '1' : '3');
  query.set('autostart', '1');
  if (params.has('seed')) query.set('seed', String(seed));
  if (params.get('xray') === '1') query.set('xray', '1');
  return `${window.location.pathname}?${query.toString()}`;
}

function introCard(id: string, scene: SceneId) {
  if (id === 'map_industrial') {
    return {
      kicker: `Acto II · Escena ${scene}`,
      title: 'Complejo industrial',
      body: 'Con los medicamentos a salvo, Mara necesita combustible y una batería. La horda ya la escucha.',
      durationMs: INTRO_CUT_MS,
      video: 'assets/cinematics/act2.mp4',
    };
  }
  return {
    kicker: 'Acto I · Frecuencia Cero',
    title: 'Calle y farmacia',
    body: 'Cuarenta y dos noches de silencio. Domina el ruido y llega a la farmacia.',
    durationMs: INTRO_CUT_MS,
    video: 'assets/cinematics/intro.mp4',
  };
}

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

  const source: SimulationSource = useMock ? new MockWorld(map, seed) : new SimulationEngine(map, initialScene, { seed });
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
    collision: world.getPlayerCollision(),
  });
  const weapon = new WeaponController(
    sceneManager,
    {
      agents: () => agents.getHitTargets(),
      world: () => [...world.getCollidables(), ...worldState.getCollidables()],
      ammoInMagazine: () => loop.latest().mara.weapon.ammoInMagazine,
      weaponId: () => loop.latest().mara.weapon.id,
    },
    (command) => loop.send(command)
  );
  weapon.onShot((shot) => {
    if (shot.hitAgentId) hud.showHitMarker();
  });
  player.spawn(map.spawnMara);

  // Live Dijkstra vs A* for the monitor: one agent every few ticks, same graph and endpoints.
  const comparisons = new Map<string, MonitorSearchComparison>();
  let lastComparison: MonitorSearchComparison | undefined;
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
    // Prefer long routes: short hops make Dijkstra and A* look identical.
    const far = candidates.filter((a) => Math.abs(a.targetPosition!.row - a.position.row) + Math.abs(a.targetPosition!.col - a.position.col) >= 6);
    const pool = far.length > 0 ? far : candidates;
    const agent = pool[compareCursor++ % pool.length];
    const result = source.compareAlgorithms(agent.position, agent.targetPosition!);
    lastComparison = { origin: agent.position, destination: agent.targetPosition!, ...result };
    comparisons.set(agent.id, lastComparison);
  });

  const objectiveFor = (snapshot: ExtendedWorldSnapshot): string =>
    map.id === 'map_street' && snapshot.mara.hasMedicalKit && !actTransition
      ? 'Medicina asegurada: sal de la farmacia y alcanza el faro verde al final de la avenida rumbo al complejo industrial.'
      : snapshot.sceneObjective;

  const telemetry = (snapshot: ExtendedWorldSnapshot): MonitorTelemetry => ({
    objective: objectiveFor(snapshot),
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

  // Cinematic cuts: intro (first start), radio activated (4 s pause), act handover. Victory/defeat live in MonitorPanel.
  let introShown = false;
  let radioWasActive = loop.latest().radioActivated ?? false;
  let actTransition = false;
  const playIntro = async (): Promise<void> => {
    if (introShown) return;
    introShown = true;
    await panel.playCinematic(introCard(map.id, initialScene));
  };

  // Tutorial: shown after the intro on the first start, reopened any time with H (pauses the game).
  let tutorialShown = autostart;
  let resumeAfterTutorial: (() => void) | undefined;
  const guide = new GameGuide(gameHudContainer, map, sceneManager.camera, {
    onTutorialClosed: () => {
      const resume = resumeAfterTutorial;
      resumeAfterTutorial = undefined;
      resume?.();
    },
  });
  const openTutorial = (): void => {
    if (guide.isTutorialOpen() || !loop.isRunning() || loop.latest().status !== 'playing') return;
    const wasPaused = loop.latest().paused;
    source.setPaused(true);
    loop.refresh();
    setPlaying(false);
    sceneManager.unlockPointer();
    resumeAfterTutorial = () => {
      if (!wasPaused) source.setPaused(false);
      loop.refresh();
      setPlaying(true);
      sceneManager.lockPointer();
    };
    guide.openTutorial();
  };

  const begin = (): void => {
    loop.start();
    setPlaying(true);
    sceneManager.lockPointer();
  };

  // The intro video plays first, then the tutorial; the game starts only once both are closed.
  const startGame = async (): Promise<void> => {
    await playIntro();
    if (!tutorialShown) {
      tutorialShown = true;
      resumeAfterTutorial = begin;
      guide.openTutorial();
      return;
    }
    begin();
  };

  loop.onTick((snapshot) => {
    const radio = snapshot.radioActivated ?? false;
    if (radio && !radioWasActive && snapshot.status === 'playing') {
      source.setPaused(true);
      loop.refresh();
      setPlaying(false);
      sceneManager.unlockPointer();
      void panel
        .playCinematic({
          kicker: 'Radio activada · Superviviente rescatado',
          title: 'La extracción está abierta',
          body: 'La señal del refugio confirmó el rescate. Sigue el faro verde junto al superviviente antes de que se cierre.',
          durationMs: RADIO_CUT_MS,
        })
        .then(() => {
          if (loop.latest().status !== 'playing') return;
          source.setPaused(false);
          loop.refresh();
          setPlaying(true);
        });
    }
    radioWasActive = radio;

    if (
      map.id === 'map_street' &&
      !actTransition &&
      snapshot.status === 'playing' &&
      snapshot.mara.hasMedicalKit &&
      Math.max(
        Math.abs(snapshot.mara.position.row - map.extractionPoint.row),
        Math.abs(snapshot.mara.position.col - map.extractionPoint.col)
      ) <= 2
    ) {
      actTransition = true;
      source.setPaused(true);
      loop.refresh();
      setPlaying(false);
      sceneManager.unlockPointer();
      void panel
        .playCinematic({
          kicker: 'Acto I completado',
          title: 'Rumbo al complejo industrial',
          body: 'Mara deja la avenida con los medicamentos. El combustible y la batería esperan entre las naves.',
          durationMs: ACT_TRANSITION_MS,
        })
        .then(() => window.location.assign(actUrl('act2')));
    }
  });

  const panel = new MonitorPanel(
    hudContainer,
    {
      onStart: () => void startGame(),
      onRestart: () => {
        comparisons.clear();
        lastComparison = undefined;
        if (source instanceof SimulationEngine) source.setScene(initialScene);
        loop.reset();
        radioWasActive = loop.latest().radioActivated ?? false;
        player.spawn(map.spawnMara);
        void startGame();
      },
      onPauseChange: (paused) => {
        source.setPaused(paused);
        loop.refresh();
        panel.update(loop.latest(), telemetry(loop.latest()));
      },
      onAlgorithmChange: (algorithm) => {
        source.setAlgorithm(algorithm, loop.latest().heuristic);
        guide.toast(algorithm === 'astar'
          ? 'Ahora los zombies usan A*: la heurística guía la búsqueda y expande menos nodos'
          : 'Ahora los zombies usan Dijkstra: explora en todas direcciones hasta encontrar la ruta más barata');
        loop.refresh();
        panel.update(loop.latest(), telemetry(loop.latest()));
      },
      onCoordinationChange: (enabled) => {
        source.setCoordinationEnabled(enabled);
        guide.toast(enabled
          ? 'Coordinación activada: un zombie que te detecta alerta de forma recursiva a los cercanos'
          : 'Coordinación desactivada: cada zombie actúa aislado, solo con lo que ve y oye');
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
        query.delete('scene');
        window.location.search = query.toString();
      },
      onActJump: (act) => window.location.assign(actUrl(act)),
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
        if (xray.isEnabled()) {
          guide.toast('Rayos X: líneas = ruta calculada por cada zombie · cuadros = nodos expandidos · arcos = alertas recursivas', 'Tab V', 8000);
        }
        panel.update(loop.latest(), telemetry(loop.latest()));
        break;
      case 'KeyG':
        world.toggleGridOverlay();
        break;
      case 'KeyM':
        hudContainer.hidden = !hudContainer.hidden;
        document.body.classList.toggle('monitor-open', !hudContainer.hidden);
        if (!hudContainer.hidden) sceneManager.unlockPointer();
        break;
      case 'KeyN':
        if (panel.toggleMapExpanded()) sceneManager.unlockPointer();
        break;
      case 'KeyH':
        openTutorial();
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

  document.body.classList.toggle('monitor-open', !hudContainer.hidden);
  if (params.get('xray') === '1') xray.setEnabled(true);
  if (autostart) {
    panel.closeDialog();
    void playIntro().then(() => {
      loop.start();
      setPlaying(true);
    });
  }

  let lastStatus = loop.latest().status;
  sceneManager.start((dt) => {
    if (loop.isRunning() && loop.latest().status === 'playing') player.update(dt);
    const frame = loop.frame(dt);
    worldState.update(frame.current, dt);
    agents.sync(frame);
    xray.sync(frame);
    weapon.update(dt);
    const latest = loop.latest();
    hud.update(latest, sceneManager.isPointerLocked(), dt, objectiveFor(latest), guide.isTutorialOpen() || panel.isMapExpanded());
    guide.update(latest, dt, {
      running: loop.isRunning(),
      flashlight: sceneManager.isFlashlightEnabled(),
      xray: xray.isEnabled(),
      leavingAct: actTransition,
      comparison: lastComparison,
    });
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
