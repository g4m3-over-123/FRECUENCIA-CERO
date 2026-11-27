import * as THREE from 'three';
import { GUNSHOT_SOURCE_ID } from '../core/contracts.ts';
import type { AgentState, GridCoord, MapDefinition, SoundEvent, WorldSnapshot } from '../core/contracts.ts';
import { gridToWorld } from '../core/world/gridSpace.ts';

const gains = {
  step: 0.27, metal_door: 0.48, decoy: 0.46, zombie_alert: 0.28,
  barricade: 0.45, radio: 0.48, ambient: 0.22,
  gunshot: 0.52, reload: 0.34, dry_fire: 0.21, impact: 0.42, growl: 0.38,
} as const;

export type AudioCue = keyof typeof gains;
type SoundCue = Exclude<AudioCue, 'ambient'>;
type WeaponCue = 'gunshot' | 'reload' | 'dry_fire';

const sourceCues: Readonly<Record<string, SoundCue>> = {
  mara: 'step', step: 'step', mara_step: 'step', mara_sprint: 'step',
  metal_door: 'metal_door', pharmacy_metal_door: 'metal_door',
  decoy: 'decoy', zombie_alert: 'zombie_alert', barricade: 'barricade',
  barricade_place: 'barricade', radio: 'radio',
};

const combatCues: readonly SoundCue[] = ['gunshot', 'reload', 'dry_fire', 'impact', 'growl'];
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
}

interface HeardAgent {
  state: AgentState;
  health: number;
  growledAt: number;
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
  private readonly clips = new Map<AudioCue, HTMLAudioElement>();
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
    if (this.binding) this.binding.player = this;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.stopVoices();
      for (const clip of this.clips.values()) clip.pause();
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
    this.clips.get('ambient')?.pause();
  }

  playCue(name: string): void {
    if (this.muted || !Object.hasOwn(gains, name)) return;
    const cue = name as AudioCue;
    let clip = this.clips.get(cue);
    if (!clip) {
      clip = new Audio(this.url(cue));
      clip.preload = 'auto';
      clip.loop = cue === 'ambient';
      clip.volume = gains[cue];
      this.clips.set(cue, clip);
    }
    if (cue === 'ambient' && !clip.paused) return;
    if (cue !== 'ambient') clip.currentTime = 0;
    void clip.play().catch(() => undefined);
  }

  reset(): void {
    this.lastTick = -1;
    this.playedSounds.clear();
    this.activeAlerts.clear();
    this.agents.clear();
    this.stopVoices();
    for (const [cue, clip] of this.clips) if (cue !== 'ambient') clip.pause();
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
      let growledAt = previous?.growledAt ?? -Infinity;
      if (!snapshot.paused && previous) {
        if (agent.health < previous.health) this.playAt('impact', this.worldPosition(agent.position, 1.05));
        const agitated = agent.state === 'pursue' || agent.state === 'attack' || agent.state === 'alert';
        if (agitated && agent.state !== previous.state && snapshot.elapsedMs - growledAt >= 950) {
          this.playAt('growl', this.worldPosition(agent.position, 1.45));
          growledAt = snapshot.elapsedMs;
        }
      }
      this.agents.set(agent.id, { state: agent.state, health: agent.health, growledAt });
    }
    for (const id of this.agents.keys()) if (!seen.has(id)) this.agents.delete(id);

    const activeAlerts = new Set<string>();
    for (const alert of snapshot.activeAlerts) {
      if (alert.hops.length === 0) continue;
      const key = JSON.stringify([alert.originAgentId, alert.hops.map(({ fromAgentId, toAgentId, depth }) => [fromAgentId, toAgentId, depth])]);
      activeAlerts.add(key);
      if (!snapshot.paused && !this.activeAlerts.has(key)) {
        const origin = snapshot.agents.find((agent) => agent.id === alert.originAgentId);
        this.playAt('zombie_alert', origin ? this.worldPosition(origin.position, 1.4) : undefined);
      }
    }
    this.activeAlerts = activeAlerts;
  }

  private unlock(): void {
    if (this.muted) return;
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

  private playAt(cue: SoundCue, position?: THREE.Vector3): void {
    if (this.muted || !this.unlocked) return;
    const listener = this.listener;
    if (!listener || !position) {
      this.playCue(cue);
      return;
    }
    listener.getWorldPosition(this.cameraPosition);
    if (position.distanceToSquared(this.cameraPosition) > MAX_DISTANCE * MAX_DISTANCE) return;
    const generation = this.generation;
    const location = position.clone();
    const { context } = listener;
    void this.loadBuffer(cue, context).then((buffer) => {
      if (!buffer || generation !== this.generation || context.state !== 'running') return;
      this.startVoice(listener, buffer, cue, location);
    }).catch(() => undefined);
  }

  private startVoice(listener: THREE.AudioListener, buffer: AudioBuffer, cue: SoundCue, position: THREE.Vector3): void {
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
    source.connect(panner).connect(gain).connect(listener.getInput());
    const voice = { source, panner, gain };
    this.voices.add(voice);
    source.onended = () => this.releaseVoice(voice, false);
    source.start();
  }

  private releaseVoice(voice: Voice, stop: boolean): void {
    if (!this.voices.delete(voice)) return;
    voice.source.onended = null;
    if (stop) voice.source.stop();
    voice.source.disconnect();
    voice.panner.disconnect();
    voice.gain.disconnect();
  }

  private stopVoices(): void {
    this.generation++;
    for (const voice of this.voices) this.releaseVoice(voice, true);
  }

  private releaseSpatialAudio(): void {
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
