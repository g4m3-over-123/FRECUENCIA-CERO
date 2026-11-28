import * as THREE from 'three';
import { GUNSHOT_SOURCE_ID } from '../core/contracts.ts';
import type { AgentState, GridCoord, MapDefinition, SoundEvent, WorldSnapshot } from '../core/contracts.ts';
import { gridToWorld } from '../core/world/gridSpace.ts';

const gains = {
  step: 0.27, metal_door: 0.48, decoy: 0.46, zombie_alert: 0.52,
  barricade: 0.45, radio: 0.48, ambient: 0.08,
  gunshot: 0.52, reload: 0.34, dry_fire: 0.21, impact: 0.42,
  growl: 0.60, zombie_growl_2: 0.60, zombie_attack: 0.70,
  zombie_hurt: 0.62, zombie_death: 0.68, zombie_idle: 0.38,
} as const;

export type AudioCue = keyof typeof gains;
type SoundCue = Exclude<AudioCue, 'ambient'>;
type WeaponCue = 'gunshot' | 'reload' | 'dry_fire';
type GrowlCue = 'growl' | 'zombie_growl_2';

const sourceCues: Readonly<Record<string, SoundCue>> = {
  mara: 'step', step: 'step', mara_step: 'step', mara_sprint: 'step',
  metal_door: 'metal_door', pharmacy_metal_door: 'metal_door',
  decoy: 'decoy', zombie_alert: 'zombie_alert', barricade: 'barricade',
  barricade_place: 'barricade', radio: 'radio',
};

const combatCues: readonly SoundCue[] = [
  'gunshot', 'reload', 'dry_fire', 'impact',
  'growl', 'zombie_alert', 'zombie_growl_2', 'zombie_attack', 'zombie_hurt', 'zombie_death', 'zombie_idle',
];
const MAX_VOICES = 12;
const MAX_DISTANCE = 36;

interface SpatialScene {
  camera: THREE.Camera;
  map: MapDefinition;
  player: AudioManager | null;
}

interface Voice {
  source: AudioBufferSourceNode;
  panner: PannerNode;
  gain: GainNode;
  agentId?: string;
}

interface Clip {
  element: HTMLAudioElement;
  agentId?: string;
}

interface HeardAgent {
  state: AgentState;
  health: number;
  growledAt: number;
  idledAt: number;
  nextGrowl: GrowlCue;
}

function agentSeed(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return sum;
}

function defaultCue(sound: SoundEvent): SoundCue | undefined {
  const id = sound.sourceId;
  if (Object.hasOwn(sourceCues, id)) return sourceCues[id];
  if (/^decoy-\d+$/.test(id)) return 'decoy';
  if (id.startsWith('refuge_radio') || id.startsWith('radio_')) return 'radio';
  return undefined;
}

export class AudioManager {
  private static scene: SpatialScene | undefined;

  // The scene is mounted before the monitor constructs the audio manager.
  static bindScene(scene: THREE.Scene, map: MapDefinition): () => void {
    const camera = scene.children.find((child): child is THREE.Camera => child instanceof THREE.Camera);
    if (!camera) return () => undefined;
    AudioManager.scene?.player?.releaseSpatialAudio();
    const binding: SpatialScene = { camera, map, player: null };
    AudioManager.scene = binding;
    return () => {
      binding.player?.releaseSpatialAudio();
      if (AudioManager.scene === binding) AudioManager.scene = undefined;
    };
  }

  static playWeaponCue(camera: THREE.Camera, cue: WeaponCue, position: THREE.Vector3): void {
    const scene = AudioManager.scene;
    if (scene?.camera !== camera || !scene.player) return;
    scene.player.unlock();
    scene.player.playAt(cue, position);
  }

  private readonly binding = AudioManager.scene;
  private readonly clips = new Map<AudioCue, Clip>();
  private readonly buffers = new Map<SoundCue, Promise<AudioBuffer | null>>();
  private readonly voices = new Set<Voice>();
  private readonly playedSounds = new Map<string, number>();
  private readonly agents = new Map<string, HeardAgent>();
  private readonly cameraPosition = new THREE.Vector3();
  private activeAlerts = new Set<string>();
  private listener?: THREE.AudioListener;
  private lastTick = -1;
  private generation = 0;
  private ambientRequested = false;
  private unlocked = false;
  private muted = false;

  constructor(private readonly cueForSound: (sound: SoundEvent) => SoundCue | undefined = defaultCue) {
    if (this.binding) {
      this.binding.player?.releaseSpatialAudio();
      this.binding.player = this;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.stopVoices();
      for (const { element } of this.clips.values()) element.pause();
    } else {
      this.unlock();
      if (this.ambientRequested) this.playCue('ambient');
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  startAmbient(): void {
    this.ambientRequested = true;
    this.unlock();
    this.playCue('ambient');
  }

  stopAmbient(): void {
    this.ambientRequested = false;
    this.clips.get('ambient')?.element.pause();
  }

  playCue(name: string): void {
    if (Object.hasOwn(gains, name)) this.playClip(name as AudioCue);
  }

  private playClip(cue: AudioCue, agentId?: string): void {
    if (this.muted || (this.binding && this.binding.player !== this)) return;
    let clip = this.clips.get(cue);
    if (!clip) {
      const element = new Audio(this.url(cue));
      element.preload = 'auto';
      element.loop = cue === 'ambient';
      element.volume = gains[cue];
      clip = { element };
      this.clips.set(cue, clip);
    }
    const { element } = clip;
    if (cue === 'ambient' && !element.paused) return;
    if (cue !== 'ambient') element.currentTime = 0;
    clip.agentId = agentId;
    void element.play().catch(() => undefined);
  }

  reset(): void {
    this.lastTick = -1;
    this.playedSounds.clear();
    this.activeAlerts.clear();
    this.agents.clear();
    this.stopVoices();
    for (const [cue, { element }] of this.clips) if (cue !== 'ambient') element.pause();
  }

  update(snapshot: WorldSnapshot): void {
    if (snapshot.tick < this.lastTick) this.reset();
    if (snapshot.tick !== this.lastTick) {
      for (const [id, tick] of this.playedSounds) {
        if (tick < snapshot.tick - 2) this.playedSounds.delete(id);
      }
    }
    this.lastTick = snapshot.tick;

    for (const sound of snapshot.soundEvents) {
      const repeated = this.playedSounds.has(sound.id);
      this.playedSounds.set(sound.id, snapshot.tick);
      // The local weapon already played the shot when the engine accepted it.
      if (repeated || snapshot.paused || sound.sourceId === GUNSHOT_SOURCE_ID) continue;
      const cue = this.cueForSound(sound) ?? defaultCue(sound);
      if (cue) this.playAt(cue, this.worldPosition(sound.position, .8));
    }

    const seen = new Set<string>();
    for (const agent of snapshot.agents) {
      if (agent.role === 'radio_survivor') continue;
      seen.add(agent.id);
      const previous = this.agents.get(agent.id);
      const state = agent.health <= 0 ? 'dead' : agent.state;
      const seed = agentSeed(agent.id);
      let growledAt = previous?.growledAt ?? -Infinity;
      let idledAt = previous?.idledAt ?? (snapshot.elapsedMs - (seed % 5) * 1500);
      let nextGrowl: GrowlCue = previous?.nextGrowl ?? (seed % 2 === 0 ? 'growl' : 'zombie_growl_2');
      if (state === 'dead' && previous && previous.state !== 'dead') this.stopAgentVoices(agent.id);
      if (!snapshot.paused && previous && previous.state !== 'dead') {
        if (agent.health < previous.health) {
          this.playAt('impact', this.worldPosition(agent.position, 1.05));
          if (state !== 'dead') {
            this.playAt('zombie_hurt', this.worldPosition(agent.position, 1.4), agent.id);
          }
        }
        if (state === 'dead') {
          this.playAt('zombie_death', this.worldPosition(agent.position, 1.2));
        } else if (state === 'attack' && previous.state !== 'attack') {
          this.playAt('zombie_attack', this.worldPosition(agent.position, 1.45), agent.id);
          growledAt = snapshot.elapsedMs;
        } else if (
          (state === 'pursue' || state === 'alert') &&
          state !== previous.state &&
          snapshot.elapsedMs - growledAt >= 950
        ) {
          this.playAt(nextGrowl, this.worldPosition(agent.position, 1.45), agent.id);
          nextGrowl = nextGrowl === 'growl' ? 'zombie_growl_2' : 'growl';
          growledAt = snapshot.elapsedMs;
        } else if (
          (state === 'patrol' || state === 'investigate') &&
          snapshot.elapsedMs - idledAt >= 7500
        ) {
          this.playAt('zombie_idle', this.worldPosition(agent.position, 1.4), agent.id);
          idledAt = snapshot.elapsedMs;
        }
      }
      this.agents.set(agent.id, { state, health: agent.health, growledAt, idledAt, nextGrowl });
    }
    for (const id of this.agents.keys()) {
      if (seen.has(id)) continue;
      this.agents.delete(id);
      this.stopAgentVoices(id);
    }

    const activeAlerts = new Set<string>();
    for (const alert of snapshot.activeAlerts) {
      const key = JSON.stringify([alert.originAgentId, alert.hops.map(({ fromAgentId, toAgentId, depth }) => [fromAgentId, toAgentId, depth])]);
      const repeated = this.activeAlerts.has(key) || activeAlerts.has(key);
      activeAlerts.add(key);
      if (snapshot.paused || repeated) continue;
      const state = this.agents.get(alert.originAgentId)?.state;
      if (state && state !== 'dead') {
        const origin = snapshot.agents.find((agent) => agent.id === alert.originAgentId);
        if (origin) this.playAt('zombie_alert', this.worldPosition(origin.position, 1.4), origin.id);
      }
    }
    this.activeAlerts = activeAlerts;
  }

  private unlock(): void {
    if (this.muted || (this.binding && this.binding.player !== this)) return;
    this.unlocked = true;
    if (!this.binding) return;
    let listener = this.listener;
    if (!listener) {
      try {
        listener = new THREE.AudioListener();
      } catch {
        return;
      }
      this.binding.camera.add(listener);
      this.listener = listener;
      for (const cue of combatCues) void this.loadBuffer(cue, listener.context);
    }
    if (listener.context.state === 'suspended') void listener.context.resume().catch(() => undefined);
  }

  private playAt(cue: SoundCue, position?: THREE.Vector3, agentId?: string): void {
    if (this.muted || !this.unlocked) return;
    const listener = this.listener;
    if (!listener || !position) {
      this.playClip(cue, agentId);
      return;
    }
    listener.getWorldPosition(this.cameraPosition);
    if (position.distanceToSquared(this.cameraPosition) > MAX_DISTANCE * MAX_DISTANCE) return;
    const generation = this.generation;
    const location = position.clone();
    const { context } = listener;
    void this.loadBuffer(cue, context).then((buffer) => {
      if (!buffer || generation !== this.generation || context.state !== 'running') return;
      if (agentId !== undefined && (this.agents.get(agentId)?.state ?? 'dead') === 'dead') return;
      this.startVoice(listener, buffer, cue, location, agentId);
    }).catch(() => undefined);
  }

  private startVoice(
    listener: THREE.AudioListener,
    buffer: AudioBuffer,
    cue: SoundCue,
    position: THREE.Vector3,
    agentId?: string,
  ): void {
    const oldest = this.voices.values().next().value;
    if (this.voices.size >= MAX_VOICES && oldest) this.releaseVoice(oldest, true);
    const { context } = listener;
    const source = context.createBufferSource();
    const panner = context.createPanner();
    const gain = context.createGain();
    source.buffer = buffer;
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = cue === 'gunshot' ? 2 : 1.6;
    panner.maxDistance = MAX_DISTANCE;
    panner.rolloffFactor = 1.15;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    gain.gain.value = gains[cue];
    const voice: Voice = { source, panner, gain, agentId };
    this.voices.add(voice);
    try {
      source.connect(panner).connect(gain).connect(listener.getInput());
      source.onended = () => this.releaseVoice(voice, false);
      source.start();
    } catch {
      this.releaseVoice(voice, false);
    }
  }

  private releaseVoice(voice: Voice, stop: boolean): void {
    if (!this.voices.delete(voice)) return;
    voice.source.onended = null;
    if (stop) {
      try {
        voice.source.stop();
      } catch {
        // Disconnect the nodes even if the source could not be stopped.
      }
    }
    voice.source.disconnect();
    voice.panner.disconnect();
    voice.gain.disconnect();
  }

  private stopVoices(): void {
    this.generation++;
    for (const voice of this.voices) this.releaseVoice(voice, true);
  }

  private stopAgentVoices(id: string): void {
    for (const voice of this.voices) {
      if (voice.agentId === id) this.releaseVoice(voice, true);
    }
    for (const { agentId, element } of this.clips.values()) {
      if (agentId === id) element.pause();
    }
  }

  private releaseSpatialAudio(): void {
    if (this.binding?.player === this) this.binding.player = null;
    this.reset();
    this.stopAmbient();
    this.unlocked = false;
    this.listener?.removeFromParent();
    this.listener?.getInput().disconnect();
    this.listener = undefined;
  }

  private worldPosition(cell: GridCoord, height: number): THREE.Vector3 | undefined {
    if (!this.binding) return undefined;
    const { x, z } = gridToWorld(cell, this.binding.map);
    return new THREE.Vector3(x, height, z);
  }

  private loadBuffer(cue: SoundCue, context: AudioContext): Promise<AudioBuffer | null> {
    let buffer = this.buffers.get(cue);
    if (!buffer) {
      buffer = fetch(this.url(cue)).then((response) => {
        if (!response.ok) throw new Error(`Audio file not found: ${cue}`);
        return response.arrayBuffer();
      }).then((data) => context.decodeAudioData(data)).catch(() => null);
      this.buffers.set(cue, buffer);
    }
    return buffer;
  }

  private url(cue: AudioCue): string {
    return `${import.meta.env.BASE_URL}assets/audio/${cue}.wav`;
  }
}
