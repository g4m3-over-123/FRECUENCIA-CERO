import * as THREE from 'three';
import type { GridCoord, MapDefinition } from '../core/contracts.ts';
import type { ExtendedWorldSnapshot } from '../core/gameplay/SimulationEngine.ts';
import { gridToWorld } from '../core/world/gridSpace.ts';
import type { MonitorSearchComparison } from './MonitorPanel.ts';

/**
 * Player guidance layer: paged tutorial (H), mission banner with a direction arrow and the
 * keys needed for the current step, one-time contextual tips and an on-screen algorithm chip.
 */

const kbd = (keys: string): string =>
  keys.split(' ').map((k) => `<kbd>${k.replace(/_/g, ' ')}</kbd>`).join('');

const row = (keys: string, text: string): string => `<li><span class="guide-keys">${kbd(keys)}</span><span>${text}</span></li>`;

const TUTORIAL_PAGES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Tu misión',
    body: `
      <p>Eres <b>Mara</b>. La ciudad está tomada por infectados que <b>solo reaccionan a lo que ven y oyen</b>: cada uno calcula su ruta hacia ti con <b>Dijkstra</b> o <b>A*</b>.</p>
      <ol class="guide-steps">
        <li><b>Acto I.</b> Llega a la farmacia y recoge los medicamentos.</li>
        <li>Sal por la avenida hasta el <b>faro verde</b>.</li>
        <li><b>Acto II.</b> En el complejo industrial recoge el <b>combustible</b> y la <b>batería</b>.</li>
        <li>Vuelve al <b>refugio</b> y quédate dentro mientras se calibra la radio.</li>
        <li>Corre al <b>punto de extracción</b> antes de que se cierre.</li>
      </ol>
      <p class="guide-note">Arriba en el centro siempre verás qué hacer, con qué tecla y una flecha hacia el objetivo.</p>`,
  },
  {
    title: 'Moverse sin hacer ruido',
    body: `
      <ul class="guide-keylist">
        ${row('Clic', 'Haz clic en la pantalla para controlar la cámara con el ratón')}
        ${row('W A S D', 'Caminar')}
        ${row('Ratón', 'Mirar alrededor')}
        ${row('Shift', 'Correr: más rápido, pero <b>hace ruido</b> y gasta estamina')}
        ${row('C', 'Agacharse: modo sigilo, <b>casi no haces ruido</b>')}
        ${row('Esc', 'Soltar el ratón para usar los botones del monitor')}
        ${row('P', 'Pausar / reanudar')}
      </ul>
      <p class="guide-note">Los pasos, los disparos y las puertas generan eventos de sonido. Un zombie solo te persigue si te ve o te oye dentro de su radio.</p>`,
  },
  {
    title: 'Armas y herramientas',
    body: `
      <ul class="guide-keylist">
        ${row('Clic_izq', 'Disparar (el disparo se oye lejos y atrae a la horda)')}
        ${row('R', 'Recargar')}
        ${row('1 2 3 4 5 6', 'Cambiar de arma (también con la <b>rueda del ratón</b>)')}
        ${row('F', 'Encender / apagar la <b>linterna</b>')}
        ${row('Q', 'Lanzar un <b>señuelo</b>: hace ruido lejos de ti y desvía a los zombies')}
        ${row('E', 'Poner una <b>barricada</b>: bloquea la celda y obliga a los zombies a <b>replanificar</b> su ruta')}
      </ul>
      <p class="guide-note">Para recoger medicamentos, combustible, batería, munición o botiquines solo camina sobre ellos.</p>`,
  },
  {
    title: 'Ver los algoritmos en acción',
    body: `
      <ul class="guide-keylist">
        ${row('Tab', '<b>Rayos X</b>: dibuja la ruta que calcula cada zombie, los <b>nodos expandidos</b> por la búsqueda, los anillos de sonido y los arcos de <b>alerta recursiva</b> entre agentes')}
        ${row('V', 'Con Rayos X: enfocar un solo agente (Shift+V: todos)')}
        ${row('G', 'Mostrar la cuadrícula del grafo')}
        ${row('M', 'Mostrar / ocultar el <b>monitor</b>: costo, nodos expandidos, tiempo en ms y tabla <b>Dijkstra vs A*</b> en vivo')}
        ${row('N', '<b>Mapa táctico grande</b>: rutas de todos los agentes y nodos que expande Dijkstra frente a A*')}
        ${row('H', 'Volver a ver este tutorial')}
      </ul>
      <p class="guide-note">En el monitor, el botón <b>Algoritmo</b> cambia entre Dijkstra y A* y <b>Coordinación</b> activa las alertas entre zombies. Abajo a la izquierda verás siempre el algoritmo activo y su última comparación.</p>`,
  },
];

interface MissionStep {
  text: string;
  keys?: string;
  target?: GridCoord;
}

interface TipDef {
  text: string;
  keys?: string;
  ms?: number;
}

const TIMED_TIPS: ReadonlyArray<[number, string, TipDef]> = [
  [3, 'flashlight', { text: 'Está oscuro: enciende la linterna', keys: 'F' }],
  [14, 'weapons', { text: 'Cambia de arma con los números o la rueda del ratón. Recarga con R', keys: '1-6 R' }],
  [28, 'xray', { text: 'Activa los Rayos X para ver las rutas que calculan los zombies', keys: 'Tab' }],
  [45, 'monitor', { text: 'Abre el monitor para ver costo, nodos y tiempo de Dijkstra vs A*', keys: 'M' }],
  [60, 'bigmap', { text: 'Abre el mapa táctico grande para comparar cómo exploran los algoritmos', keys: 'N' }],
  [80, 'help', { text: 'Puedes volver a ver todos los controles cuando quieras', keys: 'H' }],
];

export interface GameGuideOptions {
  onTutorialClosed: () => void;
}

export class GameGuide {
  private readonly tutorial = document.createElement('div');
  private readonly mission = document.createElement('div');
  private readonly tips = document.createElement('div');
  private readonly algo = document.createElement('div');
  private page = 0;
  private playTime = 0;
  private readonly shown = new Set<string>();
  private readonly forward = { x: 0, z: -1 };
  private readonly tmpDir = new THREE.Vector3();

  constructor(
    container: HTMLElement,
    private readonly map: MapDefinition,
    private readonly camera: THREE.Camera,
    private readonly options: GameGuideOptions,
  ) {
    this.tutorial.className = 'guide-tutorial';
    this.tutorial.hidden = true;
    this.tutorial.setAttribute('role', 'dialog');
    this.tutorial.setAttribute('aria-modal', 'true');
    this.tutorial.setAttribute('aria-labelledby', 'guide-title');

    this.mission.className = 'guide-mission';
    this.mission.hidden = true;
    this.mission.innerHTML = `
      <div class="guide-arrow" aria-hidden="true"><span></span></div>
      <div class="guide-mission-text">
        <p class="guide-mission-kicker">Qué hacer ahora <b data-g="dist"></b></p>
        <p data-g="text"></p>
        <p class="guide-mission-keys" data-g="keys"></p>
      </div>`;

    this.tips.className = 'guide-tips';
    this.tips.setAttribute('role', 'status');
    this.algo.className = 'guide-algo';
    this.algo.hidden = true;

    container.append(this.mission, this.tips, this.algo);
    document.body.appendChild(this.tutorial);
    window.addEventListener('keydown', (event) => {
      if (this.tutorial.hidden) return;
      if (event.code === 'ArrowRight' || event.code === 'Enter') this.go(1);
      else if (event.code === 'ArrowLeft') this.go(-1);
      else if (event.code === 'Escape' || event.code === 'KeyH') this.closeTutorial();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  isTutorialOpen(): boolean {
    return !this.tutorial.hidden;
  }

  openTutorial(page = 0): void {
    this.page = page;
    this.renderPage();
    this.tutorial.hidden = false;
    this.tutorial.querySelector<HTMLButtonElement>('[data-g="next"]')?.focus();
  }

  closeTutorial(): void {
    if (this.tutorial.hidden) return;
    this.tutorial.hidden = true;
    this.options.onTutorialClosed();
  }

  /** Short message near the bottom of the screen. */
  toast(text: string, keys?: string, ms = 6000): void {
    const el = document.createElement('p');
    el.className = 'guide-tip';
    el.innerHTML = `${keys ? `<span class="guide-keys">${kbd(keys)}</span>` : ''}<span></span>`;
    el.querySelector('span:last-child')!.textContent = text;
    this.tips.prepend(el);
    while (this.tips.children.length > 3) this.tips.lastElementChild?.remove();
    window.setTimeout(() => {
      el.classList.add('is-leaving');
      window.setTimeout(() => el.remove(), 400);
    }, ms);
  }

  private once(id: string, tip: TipDef): void {
    if (this.shown.has(id)) return;
    this.shown.add(id);
    this.toast(tip.text, tip.keys, tip.ms);
  }

  update(
    snapshot: ExtendedWorldSnapshot,
    dt: number,
    state: { running: boolean; flashlight: boolean; xray: boolean; leavingAct: boolean; comparison?: MonitorSearchComparison },
  ): void {
    const playing = state.running && snapshot.status === 'playing' && !snapshot.paused && this.tutorial.hidden;
    this.mission.hidden = !(state.running && snapshot.status === 'playing');
    this.algo.hidden = !state.running;
    this.updateAlgo(snapshot, state.comparison);
    if (this.mission.hidden) return;

    const step = this.missionStep(snapshot, state.leavingAct);
    this.setText('text', step.text);
    const keysEl = this.mission.querySelector<HTMLElement>('[data-g="keys"]')!;
    const keysHtml = step.keys ? kbd(step.keys) : '';
    if (keysEl.innerHTML !== keysHtml) keysEl.innerHTML = keysHtml;
    this.updateArrow(step.target);

    if (!playing) return;
    this.playTime += dt;
    for (const [at, id, tip] of TIMED_TIPS) {
      if (this.playTime < at) continue;
      if (id === 'flashlight' && state.flashlight) { this.shown.add(id); continue; }
      if (id === 'xray' && state.xray) { this.shown.add(id); continue; }
      this.once(id, tip);
    }
    const { mara } = snapshot;
    if (snapshot.agents.some((a) => a.role !== 'radio_survivor' && (a.state === 'pursue' || a.state === 'attack'))) {
      this.once('spotted', { text: 'Te detectaron. Lanza un señuelo para desviarlos o pon una barricada para cortarles la ruta', keys: 'Q E', ms: 8000 });
    }
    if (snapshot.activeAlerts.length > 0) {
      this.once('alert', { text: 'Un zombie avisó a otros (alerta recursiva). Con Rayos X verás los arcos de la alerta', keys: 'Tab', ms: 8000 });
    }
    if (mara.weapon.ammoInMagazine === 0 && mara.weapon.ammoReserve > 0) {
      this.once('reload', { text: 'Cargador vacío: recarga', keys: 'R' });
    }
    if (mara.health <= 40) {
      this.once('health', { text: 'Salud baja: busca botiquines y evita el combate. Agáchate para no hacer ruido', keys: 'C', ms: 7000 });
    }
    if (snapshot.barricades.length > 0) {
      this.once('barricade', { text: 'Barricada puesta: los zombies que la encuentren recalculan su ruta (mira el monitor: Replanificaciones)', ms: 8000 });
    }
  }

  private missionStep(s: ExtendedWorldSnapshot, leavingAct: boolean): MissionStep {
    const { mara } = s;
    const pickup = (kind: string): GridCoord | undefined => s.pickups.find((p) => p.kind === kind && !p.collected)?.position;
    if (leavingAct) return { text: 'Acto I completado. Cargando el complejo industrial...' };
    if (s.extractionOpen || s.sceneId === 5) {
      const ticks = s.extractionTicksRemaining;
      return {
        text: `Corre al punto de extracción${ticks !== null ? ` (quedan ${ticks} ticks)` : ''}`,
        keys: 'Shift W',
        target: this.map.extractionPoint,
      };
    }
    if (s.sceneId === 4) {
      const progress = s.radioInstallProgress;
      return {
        text: progress > 0
          ? `Quédate en el refugio: calibrando la radio ${progress}% · integridad ${s.refugeIntegrity}%. Defiéndelo con barricadas`
          : 'Vuelve al refugio y quédate dentro para instalar la batería y activar la radio',
        keys: progress > 0 ? 'E Clic_izq' : 'W A S D',
        target: s.refugePosition,
      };
    }
    if (this.map.id === 'map_street' && mara.hasMedicalKit) {
      return { text: 'Medicamentos asegurados. Sal de la farmacia y llega al faro verde al final de la avenida', keys: 'Shift W', target: this.map.extractionPoint };
    }
    if (s.sceneId === 3) {
      const missing = [!mara.hasFuel && 'combustible', !mara.hasBattery && 'batería'].filter(Boolean).join(' y ');
      const target = (!mara.hasFuel && pickup('fuel')) || (!mara.hasBattery && pickup('battery')) || undefined;
      return { text: `Recoge ${missing || 'los suministros'}: camina sobre el objeto`, keys: 'W A S D', target };
    }
    if (s.sceneId === 2 || !mara.hasMedicalKit && pickup('medicine') && this.distance(mara.position, s.pharmacyPosition) <= 6) {
      return { text: 'Entra a la farmacia y pasa sobre los medicamentos para recogerlos', keys: 'W A S D', target: pickup('medicine') ?? s.pharmacyPosition };
    }
    return { text: 'Llega a la farmacia sin que te detecten. Agáchate para moverte en silencio', keys: 'W A S D C', target: s.pharmacyPosition };
  }

  private distance(a: GridCoord, b: GridCoord): number {
    return Math.hypot(a.row - b.row, a.col - b.col);
  }

  private updateArrow(target?: GridCoord): void {
    const arrow = this.mission.querySelector<HTMLElement>('.guide-arrow')!;
    arrow.hidden = !target;
    if (!target) {
      this.setText('dist', '');
      return;
    }
    const to = gridToWorld(target, this.map);
    const pos = this.camera.position;
    const dx = to.x - pos.x;
    const dz = to.z - pos.z;
    const meters = Math.hypot(dx, dz);
    this.camera.getWorldDirection(this.tmpDir);
    const len = Math.hypot(this.tmpDir.x, this.tmpDir.z) || 1;
    this.forward.x = this.tmpDir.x / len;
    this.forward.z = this.tmpDir.z / len;
    const ahead = dx * this.forward.x + dz * this.forward.z;
    const right = dx * -this.forward.z + dz * this.forward.x;
    const deg = (Math.atan2(right, ahead) * 180) / Math.PI;
    arrow.style.setProperty('--angle', `${deg.toFixed(1)}deg`);
    this.setText('dist', meters < 2.5 ? '· aquí' : `· ${Math.round(meters)} m`);
  }

  private updateAlgo(s: ExtendedWorldSnapshot, comparison?: MonitorSearchComparison): void {
    const fmt = (n: number): string => (n < 10 ? n.toFixed(3) : n.toFixed(1));
    const active = s.algorithm === 'astar' ? `A* (${s.heuristic})` : 'Dijkstra';
    let html = `<p class="guide-algo-title">Algoritmo de los zombies: <b>${active}</b></p>`;
    if (comparison && comparison.dijkstra.found && comparison.astar.found) {
      const { dijkstra: d, astar: a } = comparison;
      const saved = d.expandedCount > 0 ? Math.round((1 - a.expandedCount / d.expandedCount) * 100) : 0;
      html += `
        <table><thead><tr><th></th><th>Costo</th><th>Nodos</th><th>ms</th></tr></thead><tbody>
        <tr><th>Dijkstra</th><td>${fmt(d.totalCost)}</td><td>${d.expandedCount}</td><td>${fmt(d.executionTimeMs)}</td></tr>
        <tr><th>A*</th><td>${fmt(a.totalCost)}</td><td>${a.expandedCount}</td><td>${fmt(a.executionTimeMs)}</td></tr>
        </tbody></table>
        <p class="guide-algo-note">Misma ruta (${comparison.origin.row},${comparison.origin.col}) → (${comparison.destination.row},${comparison.destination.col}): A* expande ${saved}% menos nodos</p>`;
    } else {
      html += '<p class="guide-algo-note">Esperando a que un zombie calcule una ruta...</p>';
    }
    html += '<p class="guide-algo-note"><kbd>M</kbd> monitor · <kbd>N</kbd> mapa grande · <kbd>Tab</kbd> Rayos X</p>';
    if (this.algo.innerHTML !== html) this.algo.innerHTML = html;
  }

  private go(delta: number): void {
    const next = this.page + delta;
    if (next >= TUTORIAL_PAGES.length) {
      this.closeTutorial();
      return;
    }
    this.page = Math.max(0, next);
    this.renderPage();
  }

  private renderPage(): void {
    const page = TUTORIAL_PAGES[this.page];
    const last = this.page === TUTORIAL_PAGES.length - 1;
    this.tutorial.innerHTML = `
      <div class="guide-card">
        <p class="guide-kicker">Tutorial · ${this.page + 1} de ${TUTORIAL_PAGES.length}</p>
        <h2 id="guide-title">${page.title}</h2>
        <div class="guide-body">${page.body}</div>
        <div class="guide-dots">${TUTORIAL_PAGES.map((_, i) => `<span class="${i === this.page ? 'on' : ''}"></span>`).join('')}</div>
        <div class="guide-actions">
          <button type="button" data-g="skip">Saltar tutorial</button>
          <span></span>
          <button type="button" data-g="prev" ${this.page === 0 ? 'disabled' : ''}>Anterior</button>
          <button type="button" data-g="next" class="primary">${last ? 'Empezar a jugar' : 'Siguiente'}</button>
        </div>
      </div>`;
    this.tutorial.querySelector('[data-g="skip"]')!.addEventListener('click', () => this.closeTutorial());
    this.tutorial.querySelector('[data-g="prev"]')!.addEventListener('click', () => this.go(-1));
    const next = this.tutorial.querySelector<HTMLButtonElement>('[data-g="next"]')!;
    next.addEventListener('click', () => this.go(1));
    next.focus();
  }

  private setText(field: string, value: string): void {
    const el = this.mission.querySelector<HTMLElement>(`[data-g="${field}"]`);
    if (el && el.textContent !== value) el.textContent = value;
  }
}
