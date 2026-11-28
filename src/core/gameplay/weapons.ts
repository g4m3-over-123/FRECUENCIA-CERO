import type { WeaponSnapshot } from '../contracts.ts';

/**
 * Weapon table and ammo/reload state transitions for Front C gameplay.
 * Every shot is loud on purpose: shooting must attract the horde.
 */
export interface WeaponDefinition {
  id: string;
  damage: number;
  magazineSize: number;
  initialReserve: number;
  maxReserve: number;
  /** Sound radius in cells. */
  soundRadius: number;
  soundIntensity: number;
  /** Ticks to bring the weapon up and down again, whatever the number of rounds. */
  reloadDurationTicks: number;
  /** Extra ticks for each round loaded, so a full reload takes longer than a top-up. */
  reloadTicksPerRound: number;
}

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    damage: 35,
    magazineSize: 8,
    initialReserve: 36,
    maxReserve: 72,
    soundRadius: 22,
    soundIntensity: 1,
    reloadDurationTicks: 2,
    reloadTicksPerRound: 1,
  },
} as const satisfies Record<string, WeaponDefinition>;

export type WeaponId = keyof typeof WEAPONS;

export const DEFAULT_WEAPON: WeaponId = 'pistol';

export function getWeaponDefinition(id: string): WeaponDefinition {
  return (WEAPONS as Record<string, WeaponDefinition>)[id] ?? WEAPONS[DEFAULT_WEAPON];
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
    durationTicks: def.reloadDurationTicks + def.reloadTicksPerRound * taken,
    rounds: taken,
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
