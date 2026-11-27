import type { WorldSnapshot } from '../core/contracts.ts';

/**
 * Glassmorphic HUD monitor displaying simulation status, algorithm metrics, and telemetry.
 */
export class MonitorPanel {
  private readonly root: HTMLElement;
  private readonly tickValueEl: HTMLElement;
  private readonly algorithmValueEl: HTMLElement;
  private readonly agentsValueEl: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('aside');
    this.root.className = 'monitor-panel';
    this.root.innerHTML = `
      <header class="monitor-header">
        <h1 class="monitor-title">Z3R0-FRECUENCY</h1>
        <span class="monitor-badge">ONLINE</span>
      </header>
      <div class="monitor-meta">
        <div class="monitor-row">
          <span>Tick</span>
          <span class="monitor-value" data-field="tick">0</span>
        </div>
        <div class="monitor-row">
          <span>Algorithm</span>
          <span class="monitor-value" data-field="algorithm">astar (octile)</span>
        </div>
        <div class="monitor-row">
          <span>Active Agents</span>
          <span class="monitor-value" data-field="agents">0</span>
        </div>
      </div>
    `;

    this.tickValueEl = this.root.querySelector('[data-field="tick"]') as HTMLElement;
    this.algorithmValueEl = this.root.querySelector('[data-field="algorithm"]') as HTMLElement;
    this.agentsValueEl = this.root.querySelector('[data-field="agents"]') as HTMLElement;

    container.appendChild(this.root);
  }

  update(snapshot: WorldSnapshot): void {
    // TODO: Extend telemetry bindings for search costs, alert recursion stack, and logs.
    this.tickValueEl.textContent = String(snapshot.tick);
    this.algorithmValueEl.textContent = `${snapshot.algorithm} (${snapshot.heuristic})`;
    this.agentsValueEl.textContent = String(snapshot.agents.length);
  }
}
