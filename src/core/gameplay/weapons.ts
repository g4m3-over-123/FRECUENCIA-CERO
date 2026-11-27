import type { WeaponSnapshot } from '../contracts.ts';

/**
 * Phase 0 weapon table. Front C (gameplay) owns balance: fire rate, reload time,
 * more weapons. Every shot is loud on purpose: shooting must attract the horde.
 */
export interface WeaponDefinition {
  id: string;
  damage: number;
  magazineSize: number;
  initialReserve: number;
  /** Sound radius in cells. */
  soundRadius: number;
  soundIntensity: number;
}

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    damage: 35,
    magazineSize: 12,
    initialReserve: 36,
    soundRadius: 20,
    soundIntensity: 1,
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

/** Consumes one round. Returns null when the magazine is empty. */
export function consumeRound(weapon: WeaponSnapshot): WeaponSnapshot | null {
  if (weapon.reloading || weapon.ammoInMagazine <= 0) return null;
  return { ...weapon, ammoInMagazine: weapon.ammoInMagazine - 1 };
}

/** Phase 0: instant reload. Front C can turn this into a timed reload using `reloading`. */
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
