import type { SceneId } from '../contracts.ts';

export interface ScenePreset {
  id: SceneId;
  name: string;
  description: string;
}

export const SCENE_PRESETS: ScenePreset[] = [
  { id: 1, name: 'Scene 1', description: 'TODO: Initial patrol and stealth baseline.' },
  { id: 2, name: 'Scene 2', description: 'TODO: Noise attraction and local perception.' },
  { id: 3, name: 'Scene 3', description: 'TODO: Recursive radio/horde alert spread.' },
  { id: 4, name: 'Scene 4', description: 'TODO: Pharmacy recovery and barricades.' },
  { id: 5, name: 'Scene 5', description: 'TODO: Extraction run under active pursuit.' },
];
