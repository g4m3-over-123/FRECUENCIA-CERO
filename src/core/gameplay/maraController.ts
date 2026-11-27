import type { GridCoord, MaraSnapshot, SoundEvent } from '../contracts.ts';

export interface MaraInputState {
  moveDirection: GridCoord;
  sprinting: boolean;
  crouching: boolean;
  emitDecoy: boolean;
}

/**
 * Pure simulation controller for Mara's movement, stamina, and noise emission.
 */
export function updateMaraState(
  mara: MaraSnapshot,
  _input: MaraInputState,
  _tick: number
): { mara: MaraSnapshot; emittedSound: SoundEvent | null } {
  // TODO: Update Mara grid position, stamina consumption, and sound events.
  return { mara, emittedSound: null };
}
