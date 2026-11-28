import type { ExtendedWorldSnapshot } from '../core/gameplay/SimulationEngine.ts';
import { WEAPON_ORDER, getWeaponDefinition } from '../core/gameplay/weapons.ts';

/**
 * FPS HUD: crosshair, health, stamina, ammo, scene objective, hit marker, damage flash,
 * reload / low ammo warnings, extraction countdown and a "click to play" hint while the
 * mouse is free. Front D owns this file.
 */
const LOW_HEALTH = 30;
export class GameHud {
  private readonly root = document.createElement('div');
  private readonly fields = new Map<string, HTMLElement>();
  private readonly weaponSlots = new Map<string, HTMLElement>();
  private hitTimer = 0;
  private damageTimer = 0;
  private lastHealth: number | null = null;

  constructor(container: HTMLElement) {
    this.root.className = 'game-hud';
    const slotsMarkup = WEAPON_ORDER
      .map((id, i) => `<span class="hud-slot" data-weapon="${id}">${i + 1} ${getWeaponDefinition(id).shortLabel}</span>`)
      .join('');
    this.root.innerHTML = `
      <div class="hud-damage" data-field="damage" aria-hidden="true"></div>
      <div class="hud-crosshair" aria-hidden="true"></div>
      <div class="hud-hitmarker" data-field="hit" aria-hidden="true"></div>
      <div class="hud-top">
        <p class="hud-scene" data-field="scene"></p>
        <p class="hud-objective" data-field="objective"></p>
      </div>
      <div class="hud-bottom-left">
        <div class="hud-bar" data-field="health-row"><span>Salud</span><meter min="0" max="100" data-field="health-bar"></meter><b data-field="health"></b></div>
        <div class="hud-bar"><span>Estamina</span><meter min="0" max="100" data-field="stamina-bar"></meter><b data-field="posture"></b></div>
      </div>
      <div class="hud-bottom-right">
        <p class="hud-status" data-field="status" role="status"></p>
        <p class="hud-weapon" data-field="weapon"></p>
        <p class="hud-ammo" data-field="ammo-row"><b data-field="ammo"></b><span data-field="reserve"></span></p>
        <div class="hud-weapons" data-field="weapon-slots">${slotsMarkup}</div>
        <p class="hud-meta" data-field="tools"></p>
      </div>
      <div class="hud-lock" data-field="lock">
        <p><b>Haz clic para jugar</b></p>
        <p>WASD mover · Shift correr (ruido) · C agacharse (silencio) · Clic disparar (mucho ruido) · R recargar · 1-6 / Rueda cambiar arma</p>
        <p>Q señuelo · E barricada · F linterna · Tab Rayos X (V enfocar agente) · G cuadrícula · M panel · P pausa · Esc liberar ratón</p>
      </div>`;
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-field]')) {
      this.fields.set(el.dataset.field!, el);
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-weapon]')) {
      this.weaponSlots.set(el.dataset.weapon!, el);
    }
    container.appendChild(this.root);
  }

  update(snapshot: ExtendedWorldSnapshot, pointerLocked: boolean, dt: number, objectiveOverride?: string): void {
    const { mara } = snapshot;
    const def = getWeaponDefinition(mara.weapon.id);
    this.set('scene', `${snapshot.sceneId}. ${snapshot.sceneName}`);
    this.set('objective', objectiveOverride ?? snapshot.sceneObjective);
    this.set('health', String(Math.round(mara.health)));
    this.set('posture', mara.posture === 'stealth' ? 'sigilo' : mara.posture === 'sprint' ? 'corriendo' : 'caminando');
    (this.fields.get('health-bar') as HTMLMeterElement).value = mara.health;
    (this.fields.get('stamina-bar') as HTMLMeterElement).value = mara.stamina;
    this.set('weapon', def.label);
    this.set('ammo', String(mara.weapon.ammoInMagazine));
    this.set('reserve', ` / ${mara.weapon.ammoReserve}`);
    this.set('tools', `Señuelos ${mara.decoysRemaining} · Barricadas ${mara.barricadesRemaining}`);
    for (const [id, el] of this.weaponSlots) el.classList.toggle('active', id === mara.weapon.id);

    const { weapon } = mara;
    const ammoRow = this.fields.get('ammo-row')!;
    const low = weapon.ammoInMagazine <= Math.ceil(weapon.magazineSize / 4);
    ammoRow.classList.toggle('reloading', weapon.reloading);
    ammoRow.classList.toggle('low', !weapon.reloading && low);
    this.fields.get('health-row')!.classList.toggle('critical', mara.health <= LOW_HEALTH);
    let status = '';
    if (weapon.reloading) status = 'Recargando...';
    else if (weapon.ammoInMagazine === 0) status = weapon.ammoReserve > 0 ? 'Sin balas: R para recargar' : 'Sin munición';
    else if (snapshot.sceneId === 4 && !snapshot.radioActivated && snapshot.radioInstallProgress > 0) {
      status = `Calibrando radio del refugio: ${snapshot.radioInstallProgress}% · Integridad ${snapshot.refugeIntegrity}%`;
    } else if (snapshot.sceneId === 4 && snapshot.refugeIntegrity < 100) {
      status = `Refugio bajo ataque · Integridad ${snapshot.refugeIntegrity}%`;
    } else if (snapshot.extractionOpen && snapshot.extractionTicksRemaining !== null) {
      status = `Extracción abierta: ${snapshot.extractionTicksRemaining} ticks`;
    } else if (snapshot.paused) status = 'En pausa';
    this.set('status', status);

    if (this.lastHealth !== null && mara.health < this.lastHealth) this.damageTimer = 0.25;
    this.lastHealth = mara.health;
    this.damageTimer = Math.max(0, this.damageTimer - dt);
    this.fields.get('damage')!.classList.toggle('visible', this.damageTimer > 0);
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
