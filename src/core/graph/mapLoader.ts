import type { MapDefinition } from '../contracts.ts';

/**
 * Validates and normalizes raw map JSON into a MapDefinition.
 */
export function parseMapDefinition(raw: unknown): MapDefinition {
  // TODO: Add full schema validation for cells, dimensions, and spawn/extraction bounds.
  return raw as MapDefinition;
}
