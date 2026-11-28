import type { ExtendedWorldSnapshot } from '../core/gameplay/SimulationEngine.ts';

/**
 * Phase 0 FPS HUD: crosshair, health, stamina, ammo, scene objective, hit marker and
 * a "click to play" hint while the mouse is free. Front D owns this file.
 */
export class GameHud {
  private readonly root = document.createElement('div');
  private readonly fields = new Map<string, HTMLElement>();
  private hitTimer = 0;

  constructor(container: HTMLElement) {
    this.root.className = 'game-hud';
    this.root.innerHTML = `
      <div class="hud-crosshair" aria-hidden="true"></div>
      <div class="hud-hitmarker" data-field="hit" aria-hidden="true"></div>
      <div class="hud-top">
        <p class="hud-scene" data-field="scene"></p>
        <p class="hud-objective" data-field="objective"></p>
      </div>
      <div class="hud-bottom-left">
        <div class="hud-bar"><span>Salud</span><meter min="0" max="100" data-field="health-bar"></meter><b data-field="health"></b></div>
        <div class="hud-bar"><span>Estamina</span><meter min="0" max="100" data-field="stamina-bar"></meter><b data-field="posture"></b></div>
      </div>
      <div class="hud-bottom-right">
        <p class="hud-ammo"><b data-field="ammo"></b><span data-field="reserve"></span></p>
        <p class="hud-meta" data-field="tools"></p>
      </div>
      <div class="hud-lock" data-field="lock">
        <p><b>Haz clic para jugar</b></p>
        <p>WASD mover · Shift correr (ruido) · C agacharse (silencio) · Clic disparar (mucho ruido) · R recargar</p>
        <p>Q señuelo · E barricada · F linterna · Tab Rayos X · G cuadrícula · M panel · Esc liberar ratón</p>
      </div>`;
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-field]')) {
      this.fields.set(el.dataset.field!, el);
    }
    container.appendChild(this.root);
  }

  update(snapshot: ExtendedWorldSnapshot, pointerLocked: boolean, dt: number): void {
    const { mara } = snapshot;
    this.set('scene', `${snapshot.sceneId}. ${snapshot.sceneName}`);
    this.set('objective', snapshot.sceneObjective);
    this.set('health', String(Math.round(mara.health)));
    this.set('posture', mara.posture === 'stealth' ? 'sigilo' : mara.posture === 'sprint' ? 'corriendo' : 'caminando');
    (this.fields.get('health-bar') as HTMLMeterElement).value = mara.health;
    (this.fields.get('stamina-bar') as HTMLMeterElement).value = mara.stamina;
    this.set('ammo', String(mara.weapon.ammoInMagazine));
    this.set('reserve', ` / ${mara.weapon.ammoReserve}`);
    this.set('tools', `Señuelos ${mara.decoysRemaining} · Barricadas ${mara.barricadesRemaining}`);
    this.fields.get('lock')!.hidden = pointerLocked || snapshot.status !== 'playing';
    this.hitTimer = Math.max(0, this.hitTimer - dt);
    this.fields.get('hit')!.classList.toggle('visible', this.hitTimer > 0);
  }

  showHitMarker(): void {
    this.hitTimer = 0.15;
  }

  private set(field: string, value: string): void {
    const el = this.fields.get(field);
    if (el && el.textContent !== value) el.textContent = value;
  }
}
