import type {
  AgentSnapshot, AlgorithmType, CellType, GridCoord, MapDefinition, SearchResult, WorldSnapshot,
} from '../core/contracts.ts';
import { AudioManager } from '../render/AudioManager.ts';

const maps = {
  map_street: 'Calle FPV (street.glb) · 46 × 56',
  map_small: 'Barrio sur · 20 × 20',
  map_medium: 'Centro urbano · 32 × 32',
  map_large: 'Distrito industrial · 50 × 50',
  map_industrial: 'Complejo industrial (Acto II)',
} as const;

export type MonitorMapId = keyof typeof maps;

export async function loadMonitorMap(id: MonitorMapId, signal?: AbortSignal): Promise<MapDefinition> {
  const response = await fetch(`${import.meta.env.BASE_URL}maps/${id}.json`, { signal });
  if (!response.ok) throw new Error(`No se pudo cargar ${id} (${response.status})`);
  return response.json() as Promise<MapDefinition>;
}

export interface MonitorCallbacks {
  onStart?: () => void;
  onRestart?: () => void;
  onPauseChange?: (paused: boolean) => void;
  onAlgorithmChange?: (algorithm: AlgorithmType) => void;
  onCoordinationChange?: (enabled: boolean) => void;
  onXrayChange?: (enabled: boolean) => void;
  onDecoy?: () => void;
  onBarricade?: () => void;
  onMapChange?: (map: MapDefinition) => void;
  /** Demo lifeline: jump straight to the start of an act. */
  onActJump?: (act: MonitorAct) => void;
}

export type MonitorAct = 'act1' | 'act2';

export interface CinematicCard {
  kicker: string;
  title: string;
  body: string;
  durationMs: number;
  /** Optional clip under public/ (e.g. assets/cinematics/intro.mp4); used only if it exists. */
  video?: string;
}

const OUTCOME_CARD_MS = 2800;
const outcomeCards: Record<'victory' | 'defeat', Omit<CinematicCard, 'durationMs'>> = {
  victory: {
    kicker: 'Frecuencia restablecida',
    title: 'Mara sale de la zona cero',
    body: 'La señal del refugio guió la extracción. Esta noche, alguien respondió.',
    video: 'assets/cinematics/victory.mp4',
  },
  defeat: {
    kicker: 'Señal perdida',
    title: 'El silencio se la llevó',
    body: 'La ciudad volvió a callar. La radio sigue esperando a alguien más.',
    video: 'assets/cinematics/defeat.mp4',
  },
};

export interface MonitorSearchComparison {
  // Both results must use the same graph state and endpoints.
  origin: GridCoord;
  destination: GridCoord;
  dijkstra: SearchResult;
  astar: SearchResult;
}

export interface MonitorAgentTelemetry {
  perception?: string;
  search?: SearchResult;
  comparison?: MonitorSearchComparison;
}

export interface MonitorTelemetry {
  objective?: string;
  hasFuel?: boolean;
  hasBattery?: boolean;
  decoys?: number;
  barricades?: number;
  coordinationEnabled?: boolean;
  xrayEnabled?: boolean;
  outcome?: 'playing' | 'victory' | 'defeat';
  agents?: Readonly<Record<string, MonitorAgentTelemetry>>;
}

const scenes = {
  1: ['Ciudad silenciosa', 'Avanza por las calles sin llamar la atención.'],
  2: ['La farmacia', 'Recoge los medicamentos y reacciona al ruido de la puerta.'],
  3: ['La horda', 'Atraviesa el cruce y consigue el combustible.'],
  4: ['El refugio', 'Instala la batería y activa la radio.'],
  5: ['Extracción', 'Alcanza la salida antes de que se cierre la ruta.'],
} as const;

const roles = { explorer: 'Explorador', pursuer: 'Perseguidor', radio_survivor: 'Superviviente' };
const states = {
  idle: 'En espera', patrol: 'Patrulla', investigate: 'Investiga', pursue: 'Persigue',
  alert: 'En alerta', stunned: 'Aturdido', attack: 'Ataca', dead: 'Muerto',
};
const evidence = { vision: 'Visión', sound: 'Sonido', alert: 'Alerta' };
const logCategories = { search: 'Búsqueda', alert: 'Alerta', agent: 'Agente', gameplay: 'Partida', system: 'Sistema' };
const cellColors: Record<CellType, string> = {
  street: '#252d3b', sidewalk: '#4a566c', building: '#151c29', obstacle: '#9c6657',
  barricade: '#e5ac73', pharmacy: '#80d6a5', refuge: '#f0bf76', extraction: '#f3948c',
};
const roleColors = { explorer: '#a3e635', pursuer: '#f87171', radio_survivor: '#60a5fa' };
const CELL_PX = 10;

/** Optional telemetry the engine adds on top of AgentSnapshot (ExtendedAgentSnapshot). */
interface LiveAgentExtras {
  currentPath?: GridCoord[];
  knownBlockedCells?: GridCoord[];
  planChanges?: number;
}

const numberFormat = new Intl.NumberFormat('es', { maximumFractionDigits: 3 });
const coordinate = (value: GridCoord): string => `${value.row}, ${value.col}`;
const flag = (value: boolean | undefined): string => value === undefined ? '—' : value ? 'Sí' : 'No';

export class MonitorPanel {
  private readonly root = document.createElement('aside');
  private readonly fields = new Map<string, HTMLElement>();
  private readonly panels: HTMLElement;
  private readonly collapse: HTMLButtonElement;
  private readonly agentSelect: HTMLSelectElement;
  private readonly mapSelect: HTMLSelectElement;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly health: HTMLProgressElement;
  private readonly logList: HTMLUListElement;
  private readonly logEmpty: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly dialogAction: HTMLButtonElement;
  private readonly dialogDismiss: HTMLButtonElement;
  private readonly algorithm: HTMLButtonElement;
  private readonly coordination: HTMLButtonElement;
  private readonly xray: HTMLButtonElement;
  private readonly pause: HTMLButtonElement;
  private snapshot?: WorldSnapshot;
  private telemetry: MonitorTelemetry = {};
  private requestedMap?: AbortController;
  private map?: MapDefinition;
  private baseMap?: HTMLCanvasElement;
  private logSignature = '';
  private agentSignature = '';
  private outcome: 'playing' | 'victory' | 'defeat' = 'playing';
  private dialogMode: 'start' | 'victory' | 'defeat' = 'start';
  private cinematic?: HTMLElement;
  private cinematicTimer?: number;
  private finishCinematic?: () => void;

  constructor(
    container: HTMLElement,
    private readonly callbacks: MonitorCallbacks = {},
    private readonly audio = new AudioManager(),
  ) {
    this.root.className = 'monitor-panel';
    this.root.setAttribute('aria-labelledby', 'monitor-title');
    this.root.innerHTML = `
      <header class="monitor-header">
        <div><p class="monitor-kicker">Z3R0-FRECUENCY</p><h1 id="monitor-title">Monitor de campo</h1></div>
        <button type="button" class="monitor-small" data-control="collapse" aria-expanded="true" aria-controls="monitor-content">Plegar</button>
      </header>
      <div class="monitor-content" id="monitor-content">
        <section class="monitor-section mission" aria-labelledby="monitor-mission">
          <div class="monitor-section-title"><h2 id="monitor-mission">Misión</h2><span class="monitor-status" data-field="status">Sin telemetría</span></div>
          <p class="monitor-scene" data-field="scene">Sin partida activa</p>
          <p class="monitor-objective" data-field="objective">Selecciona un mapa para explorar el sector.</p>
          <div class="monitor-health"><label for="monitor-health">Salud</label><progress id="monitor-health" max="100" aria-label="Salud de Mara"></progress><span data-field="health">—</span></div>
          <dl class="monitor-inventory">
            <div><dt>Medicina</dt><dd data-field="medicine">—</dd></div>
            <div><dt>Combustible</dt><dd data-field="fuel">—</dd></div>
            <div><dt>Batería</dt><dd data-field="battery">—</dd></div>
            <div><dt>Señuelos</dt><dd data-field="decoys">—</dd></div>
            <div><dt>Barricadas</dt><dd data-field="barricades">—</dd></div>
          </dl>
        </section>

        <section class="monitor-section" aria-labelledby="monitor-map-title">
          <div class="monitor-section-title"><h2 id="monitor-map-title">Mapa táctico</h2><span class="monitor-meta" data-field="map-size">—</span></div>
          <label class="monitor-sr-only" for="monitor-map">Sector del mapa</label>
          <select id="monitor-map">
            ${Object.entries(maps).map(([id, label]) => `<option value="${id}"${id === 'map_street' ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
          <div class="monitor-map-frame"><canvas class="monitor-map" width="250" height="250" role="img" aria-label="Mapa cenital del sector"></canvas></div>
          <p class="monitor-meta" data-field="map-status" role="status">Cargando mapa…</p>
          <ul class="monitor-legend" aria-label="Leyenda del mapa">
            <li class="spawn">Mara</li><li class="pharmacy">Farmacia</li><li class="refuge">Refugio</li><li class="extraction">Extracción</li>
            <li class="explorer">Explorador</li><li class="pursuer">Perseguidor</li><li class="barricade">Barricada</li>
          </ul>
        </section>

        <section class="monitor-section" aria-labelledby="monitor-actions">
          <div class="monitor-section-title"><h2 id="monitor-actions">Controles</h2><span class="monitor-meta" data-field="tick">Tick —</span></div>
          <div class="monitor-controls">
            <button type="button" data-control="algorithm">Algoritmo</button>
            <button type="button" data-control="coordination" aria-pressed="false">Coordinación</button>
            <button type="button" data-control="xray" aria-pressed="false">Rayos X</button>
            <button type="button" data-control="decoy">Lanzar señuelo</button>
            <button type="button" data-control="barricade">Poner barricada</button>
            <button type="button" data-control="pause">Pausar</button>
            <button type="button" data-control="restart">Reiniciar</button>
            <button type="button" data-control="mute" aria-pressed="false">Silenciar audio</button>
          </div>
        </section>

        <section class="monitor-section" aria-labelledby="monitor-demo-title">
          <div class="monitor-section-title"><h2 id="monitor-demo-title">Sustentación</h2><span class="monitor-meta">Saltos rápidos</span></div>
          <div class="monitor-controls monitor-acts">
            <button type="button" data-control="act1">Acto I: Calle y Farmacia</button>
            <button type="button" data-control="act2">Acto II: Complejo Industrial (Escena 3)</button>
          </div>
        </section>

        <section class="monitor-section" aria-labelledby="monitor-agent-title">
          <div class="monitor-section-title"><h2 id="monitor-agent-title">Inspección de agentes</h2><span class="monitor-meta" data-field="agent-count">0 agentes</span></div>
          <label class="monitor-sr-only" for="monitor-agent">Agente a inspeccionar</label>
          <select id="monitor-agent" disabled><option value="">Sin agentes</option></select>
          <dl class="monitor-data">
            <dt>Estado</dt><dd data-field="state">—</dd>
            <dt>Objetivo</dt><dd data-field="target">—</dd>
            <dt>Percepción</dt><dd data-field="perception">—</dd>
            <dt>Heurística</dt><dd data-field="heuristic">—</dd>
            <dt>Costo</dt><dd data-field="cost">—</dd>
            <dt>Nodos expandidos</dt><dd data-field="expanded">—</dd>
            <dt>Tiempo de búsqueda</dt><dd data-field="duration">—</dd>
            <dt>Replanificaciones</dt><dd data-field="replans">—</dd>
            <dt>Bloqueos que cree</dt><dd data-field="believed-blocked">—</dd>
          </dl>
          <details class="monitor-route"><summary>Ruta actual</summary><p data-field="route">—</p></details>
        </section>

        <section class="monitor-section" aria-labelledby="monitor-search-title">
          <h2 id="monitor-search-title">Dijkstra vs. A*</h2>
          <p class="monitor-meta" data-field="comparison">Sin búsquedas comparables.</p>
          <table class="monitor-table">
            <thead><tr><th scope="col">Método</th><th scope="col">Costo</th><th scope="col">Nodos</th><th scope="col">ms</th></tr></thead>
            <tbody>
              <tr><th scope="row">Dijkstra</th><td data-field="dijkstra-cost">—</td><td data-field="dijkstra-nodes">—</td><td data-field="dijkstra-time">—</td></tr>
              <tr><th scope="row">A*</th><td data-field="astar-cost">—</td><td data-field="astar-nodes">—</td><td data-field="astar-time">—</td></tr>
            </tbody>
          </table>
        </section>

        <section class="monitor-section" aria-labelledby="monitor-log-title">
          <h2 id="monitor-log-title">Registro de actividad</h2>
          <p class="monitor-meta" data-field="log-empty">Aún no hay eventos.</p>
          <ul class="monitor-log" aria-labelledby="monitor-log-title"></ul>
        </section>
      </div>
      <dialog class="monitor-dialog" aria-labelledby="monitor-dialog-title">
        <p class="monitor-kicker">Z3R0-FRECUENCY</p>
        <h2 id="monitor-dialog-title" data-field="dialog-title">El último refugio</h2>
        <p data-field="dialog-body">Reúne suministros, activa la radio del refugio y alcanza el punto de extracción.</p>
        <div class="monitor-dialog-actions">
          <button type="button" data-control="dialog-action"></button>
          <button type="button" data-control="dialog-dismiss" hidden>Ver monitor</button>
        </div>
      </dialog>`;

    for (const element of this.root.querySelectorAll<HTMLElement>('[data-field]')) {
      this.fields.set(element.dataset.field!, element);
    }
    this.panels = this.element('#monitor-content');
    this.collapse = this.button('collapse');
    this.agentSelect = this.element('#monitor-agent');
    this.mapSelect = this.element('#monitor-map');
    this.mapCanvas = this.element('.monitor-map');
    this.health = this.element('#monitor-health');
    this.logList = this.element('.monitor-log');
    this.logEmpty = this.element('[data-field="log-empty"]');
    this.dialog = this.element('.monitor-dialog');
    this.dialogAction = this.button('dialog-action');
    this.dialogDismiss = this.button('dialog-dismiss');
    this.algorithm = this.button('algorithm');
    this.coordination = this.button('coordination');
    this.xray = this.button('xray');
    this.pause = this.button('pause');

    container.appendChild(this.root);
    this.bindControls();
    this.showDialog('start');
    void this.selectMap('map_street', false);
  }

  /** Shows a map in the tactical view without notifying onMapChange (used at startup). */
  showMap(id: MonitorMapId): void {
    this.mapSelect.value = id;
    void this.selectMap(id, false);
  }

  /** Closes the start/end dialog programmatically (e.g. ?autostart=1). */
  closeDialog(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /**
   * Full-screen cinematic card. Resolves after durationMs (or when the clip ends).
   * A newer card cancels the previous one, which resolves immediately.
   */
  async playCinematic(card: CinematicCard): Promise<void> {
    this.finishCinematic?.();
    const overlay = document.createElement('div');
    overlay.className = 'cinematic-card';
    overlay.setAttribute('role', 'status');
    overlay.innerHTML = `<div class="cinematic-inner"><p class="monitor-kicker"></p><h2></h2><p class="cinematic-body"></p><span class="cinematic-bar"></span></div>`;
    overlay.querySelector('.monitor-kicker')!.textContent = card.kicker;
    overlay.querySelector('h2')!.textContent = card.title;
    overlay.querySelector('.cinematic-body')!.textContent = card.body;
    overlay.style.setProperty('--cinematic-ms', `${card.durationMs}ms`);
    this.cinematic = overlay;

    const video = card.video ? await this.loadClip(card.video) : undefined;
    if (this.cinematic !== overlay) return;
    if (video) overlay.prepend(video);
    document.body.appendChild(overlay);

    await new Promise<void>((resolve) => {
      const done = (): void => {
        window.clearTimeout(this.cinematicTimer);
        if (this.finishCinematic === done) this.finishCinematic = undefined;
        if (this.cinematic === overlay) this.cinematic = undefined;
        overlay.classList.add('is-leaving');
        window.setTimeout(() => overlay.remove(), 350);
        resolve();
      };
      this.finishCinematic = done;
      if (video) {
        video.addEventListener('ended', done, { once: true });
        video.play().catch(() => undefined);
      }
      this.cinematicTimer = window.setTimeout(done, video ? Math.max(card.durationMs, 15_000) : card.durationMs);
    });
  }

  /** Returns a <video> only if the file exists and is really a video (Vite answers 404s with HTML). */
  private async loadClip(path: string): Promise<HTMLVideoElement | undefined> {
    try {
      const url = `${import.meta.env.BASE_URL}${path}`;
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('video/')) return undefined;
      const video = document.createElement('video');
      video.className = 'cinematic-video';
      video.src = url;
      video.muted = this.audio.isMuted();
      video.playsInline = true;
      return video;
    } catch {
      return undefined;
    }
  }

  update(snapshot: WorldSnapshot, telemetry: MonitorTelemetry = {}): void {
    this.snapshot = snapshot;
    this.telemetry = telemetry;
    const [scene, objective] = scenes[snapshot.sceneId];
    const { mara } = snapshot;
    const outcome = telemetry.outcome ?? (mara.health <= 0 ? 'defeat' : mara.reachedExtraction ? 'victory' : 'playing');

    this.set('status', outcome === 'victory' ? 'Victoria' : outcome === 'defeat' ? 'Derrota' : snapshot.paused ? 'En pausa' : 'En curso');
    this.set('scene', `${snapshot.sceneId}. ${scene}`);
    this.set('objective', telemetry.objective ?? objective);
    this.set('tick', `Tick ${snapshot.tick}`);
    this.health.value = mara.health;
    this.set('health', `${numberFormat.format(mara.health)} / 100`);
    this.set('medicine', flag(mara.hasMedicalKit));
    this.set('fuel', flag(telemetry.hasFuel));
    this.set('battery', flag(telemetry.hasBattery));
    this.set('decoys', telemetry.decoys?.toString());
    this.set('barricades', telemetry.barricades?.toString());
    this.algorithm.textContent = snapshot.algorithm === 'astar' ? 'Algoritmo · A*' : 'Algoritmo · Dijkstra';
    this.pause.textContent = snapshot.paused ? 'Reanudar' : 'Pausar';
    this.coordination.setAttribute('aria-pressed', String(telemetry.coordinationEnabled ?? false));
    this.xray.setAttribute('aria-pressed', String(telemetry.xrayEnabled ?? false));
    this.setAgents(snapshot.agents);
    this.updateInspector();
    this.updateLog(snapshot);
    this.drawLive(snapshot);
    this.audio.update(snapshot);

    if (outcome !== this.outcome && outcome !== 'playing') {
      this.audio.stopAmbient();
      void this.playCinematic({ ...outcomeCards[outcome], durationMs: OUTCOME_CARD_MS }).then(() => {
        if (this.outcome === outcome) this.showDialog(outcome);
      });
    } else if (outcome === 'playing' && this.outcome !== 'playing') {
      this.finishCinematic?.();
      if (this.dialog.open) this.dialog.close();
    }
    this.outcome = outcome;
  }

  private bindControls(): void {
    const { callbacks } = this;
    const connect = (control: HTMLButtonElement, callback?: () => void): void => {
      control.disabled = !callback;
      if (callback) control.addEventListener('click', callback);
    };

    connect(this.algorithm, callbacks.onAlgorithmChange && (() => callbacks.onAlgorithmChange?.(this.snapshot?.algorithm === 'astar' ? 'dijkstra' : 'astar')));
    connect(this.coordination, callbacks.onCoordinationChange && (() => callbacks.onCoordinationChange?.(!this.telemetry.coordinationEnabled)));
    connect(this.xray, callbacks.onXrayChange && (() => callbacks.onXrayChange?.(!this.telemetry.xrayEnabled)));
    connect(this.pause, callbacks.onPauseChange && (() => callbacks.onPauseChange?.(!this.snapshot?.paused)));
    connect(this.button('decoy'), callbacks.onDecoy);
    connect(this.button('barricade'), callbacks.onBarricade);
    connect(this.button('restart'), callbacks.onRestart && (() => this.restart()));
    connect(this.button('act1'), callbacks.onActJump && (() => callbacks.onActJump?.('act1')));
    connect(this.button('act2'), callbacks.onActJump && (() => callbacks.onActJump?.('act2')));

    this.collapse.addEventListener('click', () => {
      this.panels.hidden = !this.panels.hidden;
      this.collapse.textContent = this.panels.hidden ? 'Abrir' : 'Plegar';
      this.collapse.setAttribute('aria-expanded', String(!this.panels.hidden));
    });
    this.button('mute').addEventListener('click', (event) => {
      const muted = !this.audio.isMuted();
      this.audio.setMuted(muted);
      const button = event.currentTarget as HTMLButtonElement;
      button.setAttribute('aria-pressed', String(muted));
      button.textContent = muted ? 'Activar audio' : 'Silenciar audio';
    });
    this.agentSelect.addEventListener('change', () => {
      this.updateInspector();
      if (this.snapshot) this.drawLive(this.snapshot);
    });
    this.mapSelect.addEventListener('change', () => void this.selectMap(this.mapSelect.value as MonitorMapId, true));
    this.dialogAction.addEventListener('click', () => {
      this.dialog.close();
      if (this.dialogMode === 'start') {
        this.audio.startAmbient();
        callbacks.onStart?.();
      } else if (callbacks.onRestart) {
        this.restart();
      }
    });
    this.dialogDismiss.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('cancel', (event) => {
      if (this.dialogMode === 'start' && callbacks.onStart) event.preventDefault();
    });
  }

  private restart(): void {
    this.audio.reset();
    this.audio.startAmbient();
    this.callbacks.onRestart?.();
  }

  private showDialog(mode: 'start' | 'victory' | 'defeat'): void {
    this.dialogMode = mode;
    this.dialogDismiss.hidden = mode === 'start' || !this.callbacks.onRestart;
    if (mode === 'start') {
      this.dialogAction.textContent = this.callbacks.onStart ? 'Iniciar partida' : 'Abrir monitor';
    } else {
      this.set('dialog-title', mode === 'victory' ? 'Extracción completada' : 'Misión fallida');
      this.set('dialog-body', mode === 'victory' ? 'Mara alcanzó el punto de extracción.' : 'Mara no pudo completar la misión.');
      this.dialogAction.textContent = this.callbacks.onRestart ? 'Volver a intentar' : 'Ver monitor';
    }
    if (!this.dialog.open) this.dialog.showModal();
    this.dialogAction.focus();
  }

  private async selectMap(id: MonitorMapId, notify: boolean): Promise<void> {
    this.requestedMap?.abort();
    const request = new AbortController();
    this.requestedMap = request;
    this.set('map-status', 'Cargando mapa…');
    let map: MapDefinition;
    try {
      map = await loadMonitorMap(id, request.signal);
    } catch {
      if (request.signal.aborted) return;
      if (this.map) this.mapSelect.value = this.map.id;
      this.set('map-status', 'No se pudo cargar el sector.');
      return;
    }
    if (request.signal.aborted) return;
    this.map = map;
    this.drawMap(map);
    this.set('map-size', `${map.width} × ${map.height}`);
    this.set('map-status', map.name);
    if (notify) {
      if (this.callbacks.onMapChange) this.audio.reset();
      this.callbacks.onMapChange?.(map);
    }
  }

  /** Static layer (cells) drawn once per map into an offscreen canvas. */
  private drawMap(map: MapDefinition): void {
    const base = document.createElement('canvas');
    base.width = map.width * CELL_PX;
    base.height = map.height * CELL_PX;
    const context = base.getContext('2d');
    if (!context) return;
    for (const cell of map.cells) {
      context.fillStyle = cellColors[cell.type];
      context.fillRect(cell.col * CELL_PX, cell.row * CELL_PX, CELL_PX - 0.5, CELL_PX - 0.5);
    }
    this.baseMap = base;
    this.mapCanvas.width = base.width;
    this.mapCanvas.height = base.height;
    this.mapCanvas.setAttribute('aria-label', `${map.name}, mapa de ${map.width} por ${map.height} celdas`);
    if (this.snapshot) this.drawLive(this.snapshot);
    else {
      this.mapCanvas.getContext('2d')?.drawImage(base, 0, 0);
      this.dot(map.spawnMara, '#a9e7ff', 4.5);
    }
  }

  /** Live layer: barricades, agents (selected one with its path) and Mara. */
  private drawLive(snapshot: WorldSnapshot): void {
    const context = this.mapCanvas.getContext('2d');
    const map = this.map;
    if (!context || !this.baseMap || !map) return;
    context.drawImage(this.baseMap, 0, 0);
    const inside = (p: GridCoord): boolean => p.row >= 0 && p.col >= 0 && p.row < map.height && p.col < map.width;

    const barricades = (snapshot as { barricades?: GridCoord[] }).barricades ?? [];
    context.fillStyle = cellColors.barricade;
    for (const b of barricades) if (inside(b)) context.fillRect(b.col * CELL_PX, b.row * CELL_PX, CELL_PX - 0.5, CELL_PX - 0.5);

    const selected = snapshot.agents.find(({ id }) => id === this.agentSelect.value) as (AgentSnapshot & LiveAgentExtras) | undefined;
    if (selected?.currentPath && selected.currentPath.length > 1 && selected.state !== 'dead') {
      context.strokeStyle = roleColors[selected.role];
      context.lineWidth = 2;
      context.beginPath();
      selected.currentPath.forEach((p, i) => {
        const x = p.col * CELL_PX + CELL_PX / 2;
        const y = p.row * CELL_PX + CELL_PX / 2;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    }
    for (const agent of snapshot.agents) {
      if (!inside(agent.position)) continue;
      this.dot(agent.position, agent.state === 'dead' ? '#55606f' : roleColors[agent.role], agent.id === selected?.id ? 5 : 3.5);
    }
    if (selected && selected.state !== 'dead') {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(selected.position.col * CELL_PX + CELL_PX / 2, selected.position.row * CELL_PX + CELL_PX / 2, 7.5, 0, Math.PI * 2);
      context.stroke();
    }
    if (inside(snapshot.mara.position)) this.dot(snapshot.mara.position, '#a9e7ff', 5);
  }

  private dot(cell: GridCoord, color: string, radius: number): void {
    const context = this.mapCanvas.getContext('2d');
    if (!context) return;
    context.fillStyle = color;
    context.beginPath();
    context.arc(cell.col * CELL_PX + CELL_PX / 2, cell.row * CELL_PX + CELL_PX / 2, radius, 0, Math.PI * 2);
    context.fill();
  }

  private setAgents(agents: AgentSnapshot[]): void {
    this.set('agent-count', `${agents.length} ${agents.length === 1 ? 'agente' : 'agentes'}`);
    const signature = JSON.stringify(agents.map(({ id, role }) => [id, role]));
    if (signature === this.agentSignature) return;
    this.agentSignature = signature;
    const selected = this.agentSelect.value;
    this.agentSelect.disabled = agents.length === 0;
    this.agentSelect.replaceChildren(...(agents.length
      ? agents.map(({ id, role }) => new Option(`${roles[role]} · ${id}`, id))
      : [new Option('Sin agentes', '')]));
    if (agents.some(({ id }) => id === selected)) this.agentSelect.value = selected;
  }

  private updateInspector(): void {
    const agent = this.snapshot?.agents.find(({ id }) => id === this.agentSelect.value);
    const data = agent ? this.telemetry.agents?.[agent.id] : undefined;
    const search = data?.search;
    const memory = agent?.memory;
    this.set('state', agent && states[agent.state]);
    this.set('target', agent?.targetPosition ? coordinate(agent.targetPosition) : undefined);
    this.set('perception', data?.perception ?? (memory ? `${evidence[memory.source]} (${coordinate(memory.position)}) · tick ${memory.lastSeenTick}` : agent ? 'Sin evidencia' : undefined));
    this.set('heuristic', this.snapshot?.algorithm === 'astar' ? this.snapshot.heuristic : undefined);
    this.set('cost', search && this.searchCost(search));
    this.set('expanded', search?.expandedCount.toString());
    this.set('duration', search && `${numberFormat.format(search.executionTimeMs)} ms`);
    this.set('route', search && (search.found ? search.path.map(coordinate).join(' → ') : 'Sin ruta'));
    const extras = agent as (AgentSnapshot & LiveAgentExtras) | undefined;
    this.set('replans', extras?.planChanges?.toString());
    this.set('believed-blocked', extras?.knownBlockedCells
      ? (extras.knownBlockedCells.length ? extras.knownBlockedCells.slice(0, 4).map(coordinate).join(' · ') + (extras.knownBlockedCells.length > 4 ? ` (+${extras.knownBlockedCells.length - 4})` : '') : 'Ninguno')
      : undefined);
    const comparison = data?.comparison;
    this.set('comparison', comparison ? `${coordinate(comparison.origin)} → ${coordinate(comparison.destination)}` : 'Sin búsquedas comparables.');
    this.setSearchRow('dijkstra', comparison?.dijkstra);
    this.setSearchRow('astar', comparison?.astar);
  }

  private searchCost(result: SearchResult): string {
    return result.found ? numberFormat.format(result.totalCost) : 'Sin ruta';
  }

  private setSearchRow(algorithm: AlgorithmType, result?: SearchResult): void {
    this.set(`${algorithm}-cost`, result && this.searchCost(result));
    this.set(`${algorithm}-nodes`, result?.expandedCount.toString());
    this.set(`${algorithm}-time`, result && numberFormat.format(result.executionTimeMs));
  }

  private updateLog(snapshot: WorldSnapshot): void {
    const entries = snapshot.logs.slice(-8).reverse();
    const signature = JSON.stringify(entries);
    if (signature === this.logSignature) return;
    this.logSignature = signature;
    this.logEmpty.hidden = entries.length > 0;
    this.logList.replaceChildren(...entries.map((entry) => {
      const row = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = `${logCategories[entry.category]} · ${entry.tick}`;
      row.append(label, entry.message);
      return row;
    }));
  }

  private element<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Falta el elemento del monitor ${selector}`);
    return element;
  }

  private button(control: string): HTMLButtonElement {
    return this.element(`[data-control="${control}"]`);
  }

  private set(field: string, value = '—'): void {
    const element = this.fields.get(field);
    if (element && element.textContent !== value) element.textContent = value;
  }
}
