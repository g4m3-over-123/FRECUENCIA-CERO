import type { WeaponSnapshot } from '../contracts.ts';

export type WeaponFireCue =
  | 'gunshot_spas12'
  | 'gunshot_m4'
  | 'gunshot_persuader'
  | 'gunshot_mac10'
  | 'gunshot_sawnoff';

export type WeaponReloadCue =
  | 'reload_shotgun'
  | 'reload_m4'
  | 'reload_mag';

/**
 * Weapon table and ammo/reload state transitions for Front C gameplay.
 * Every shot emits acoustic radius/intensity scaled to its firearm archetype.
 */
export interface WeaponDefinition {
  id: string;
  label: string;
  shortLabel: string;
  damage: number;
  magazineSize: number;
  initialReserve: number;
  maxReserve: number;
  /** Sound radius in cells. */
  soundRadius: number;
  soundIntensity: number;
  fireCooldownMs: number;
  reloadMode: 'shell' | 'magazine';
  /** Ticks to bring the weapon up and down again, whatever the number of rounds. */
  reloadDurationTicks: number;
  /** Extra ticks for each round loaded (rounded up), so shell reloads scale with missing shells. */
  reloadTicksPerRound: number;
  fireAudioCue: WeaponFireCue;
  reloadAudioCue: WeaponReloadCue;
}

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    label: 'SPAS-12',
    shortLabel: 'SPAS-12',
    damage: 35,
    magazineSize: 8,
    initialReserve: 36,
    maxReserve: 72,
    soundRadius: 22,
    soundIntensity: 1,
    fireCooldownMs: 320,
    reloadMode: 'shell',
    reloadDurationTicks: 2,
    reloadTicksPerRound: 1.5,
    fireAudioCue: 'gunshot_spas12',
    reloadAudioCue: 'reload_shotgun',
  },
  m4: {
    id: 'm4',
    label: 'M4 Carbine',
    shortLabel: 'M4',
    damage: 26,
    magazineSize: 30,
    initialReserve: 90,
    maxReserve: 180,
    soundRadius: 24,
    soundIntensity: 1,
    fireCooldownMs: 115,
    reloadMode: 'magazine',
    reloadDurationTicks: 6,
    reloadTicksPerRound: 0,
    fireAudioCue: 'gunshot_m4',
    reloadAudioCue: 'reload_m4',
  },
  persuader: {
    id: 'persuader',
    label: 'Persuader',
    shortLabel: 'Persuader',
    damage: 28,
    magazineSize: 12,
    initialReserve: 48,
    maxReserve: 96,
    soundRadius: 16,
    soundIntensity: 0.9,
    fireCooldownMs: 190,
    reloadMode: 'magazine',
    reloadDurationTicks: 4,
    reloadTicksPerRound: 0,
    fireAudioCue: 'gunshot_persuader',
    reloadAudioCue: 'reload_mag',
  },
  dual_mac10: {
    id: 'dual_mac10',
    label: 'Dual MAC-10',
    shortLabel: 'MAC-10',
    damage: 18,
    magazineSize: 32,
    initialReserve: 128,
    maxReserve: 256,
    soundRadius: 10,
    soundIntensity: 0.65,
    fireCooldownMs: 95,
    reloadMode: 'magazine',
    reloadDurationTicks: 5,
    reloadTicksPerRound: 0,
    fireAudioCue: 'gunshot_mac10',
    reloadAudioCue: 'reload_mag',
  },
  sawnoff: {
    id: 'sawnoff',
    label: 'Sawed-Off',
    shortLabel: 'Sawed-Off',
    damage: 70,
    magazineSize: 2,
    initialReserve: 16,
    maxReserve: 32,
    soundRadius: 26,
    soundIntensity: 1,
    fireCooldownMs: 420,
    reloadMode: 'magazine',
    reloadDurationTicks: 5,
    reloadTicksPerRound: 0,
    fireAudioCue: 'gunshot_sawnoff',
    reloadAudioCue: 'reload_shotgun',
  },
  dual_sawnoffs: {
    id: 'dual_sawnoffs',
    label: 'Dual Sawed-Off',
    shortLabel: 'Dual S-O',
    damage: 55,
    magazineSize: 4,
    initialReserve: 24,
    maxReserve: 48,
    soundRadius: 28,
    soundIntensity: 1,
    fireCooldownMs: 280,
    reloadMode: 'magazine',
    reloadDurationTicks: 6,
    reloadTicksPerRound: 0,
    fireAudioCue: 'gunshot_sawnoff',
    reloadAudioCue: 'reload_shotgun',
  },
} as const satisfies Record<string, WeaponDefinition>;

export type WeaponId = keyof typeof WEAPONS;

export const WEAPON_ORDER: readonly WeaponId[] = [
  'pistol',
  'm4',
  'persuader',
  'dual_mac10',
  'sawnoff',
  'dual_sawnoffs',
];

export const DEFAULT_WEAPON: WeaponId = 'pistol';

export function isWeaponId(id: string): id is WeaponId {
  return Object.hasOwn(WEAPONS, id);
}

export function getWeaponDefinition(id: string): WeaponDefinition {
  return isWeaponId(id) ? WEAPONS[id] : WEAPONS[DEFAULT_WEAPON];
}

export function createWeaponSnapshot(id: WeaponId = DEFAULT_WEAPON): WeaponSnapshot {
  const def = WEAPONS[id];
  return {
    id: def.id,
    ammoInMagazine: def.magazineSize,
    magazineSize: def.magazineSize,
    ammoReserve: def.initialReserve,
    reloading: false,
  };
}

/** Consumes one round. Returns null when reloading or magazine is empty. */
export function consumeRound(weapon: WeaponSnapshot): WeaponSnapshot | null {
  if (weapon.reloading || weapon.ammoInMagazine <= 0) return null;
  return { ...weapon, ammoInMagazine: weapon.ammoInMagazine - 1 };
}

/** Instant reload used by mock snapshots. */
export function reloadWeapon(weapon: WeaponSnapshot): WeaponSnapshot {
  const missing = weapon.magazineSize - weapon.ammoInMagazine;
  const taken = Math.min(missing, weapon.ammoReserve);
  return {
    ...weapon,
    ammoInMagazine: weapon.ammoInMagazine + taken,
    ammoReserve: weapon.ammoReserve - taken,
    reloading: false,
  };
}

/**
 * Begins a timed reload: loads rounds into the magazine immediately (keeping
 * Phase 0 snapshot & WeaponController contracts intact) while marking `reloading: true`
 * so `consumeRound` blocks firing until `durationTicks` elapse.
 */
export function startTimedReload(
  weapon: WeaponSnapshot
): { weapon: WeaponSnapshot; durationTicks: number; rounds: number } | null {
  if (weapon.reloading || weapon.ammoInMagazine >= weapon.magazineSize || weapon.ammoReserve <= 0) {
    return null;
  }
  const def = getWeaponDefinition(weapon.id);
  const missing = weapon.magazineSize - weapon.ammoInMagazine;
  const taken = Math.min(missing, weapon.ammoReserve);
  return {
    weapon: {
      ...weapon,
      ammoInMagazine: weapon.ammoInMagazine + taken,
      ammoReserve: weapon.ammoReserve - taken,
      reloading: true,
    },
    durationTicks: def.reloadDurationTicks + Math.ceil(def.reloadTicksPerRound * taken),
    rounds: taken,
  };
}

/** Refunds pre-loaded rounds if a timed reload is cancelled mid-animation (e.g. weapon switch). */
export function cancelTimedReload(weapon: WeaponSnapshot, pendingRounds: number): WeaponSnapshot {
  if (!weapon.reloading) return weapon;
  const def = getWeaponDefinition(weapon.id);
  const refund = Math.max(0, Math.min(pendingRounds, weapon.ammoInMagazine));
  return {
    ...weapon,
    ammoInMagazine: weapon.ammoInMagazine - refund,
    ammoReserve: Math.min(def.maxReserve, weapon.ammoReserve + refund),
    reloading: false,
  };
}

/** Completes a timed reload once its duration ticks expire. */
export function finishReload(weapon: WeaponSnapshot): WeaponSnapshot {
  return { ...weapon, reloading: false };
}

/** Adds scavenged rounds to reserve, capped at the weapon's maxReserve. */
export function addAmmoToReserve(weapon: WeaponSnapshot, amount: number): WeaponSnapshot {
  const def = getWeaponDefinition(weapon.id);
  const gain = Math.max(0, Math.floor(amount));
  return {
    ...weapon,
    ammoReserve: Math.min(def.maxReserve, weapon.ammoReserve + gain),
  };
}
