import type { SoundEvent, WorldSnapshot } from '../core/contracts.ts';

const gains = {
  step: 0.32,
  metal_door: 0.48,
  decoy: 0.46,
  zombie_alert: 0.36,
  barricade: 0.45,
  radio: 0.48,
  ambient: 0.22,
} as const;

export type AudioCue = keyof typeof gains;
type SoundCue = Exclude<AudioCue, 'ambient'>;

const sourceCues: Readonly<Record<string, SoundCue>> = {
  mara: 'step',
  step: 'step',
  metal_door: 'metal_door',
  decoy: 'decoy',
  zombie_alert: 'zombie_alert',
  barricade: 'barricade',
  radio: 'radio',
};

export class AudioManager {
  private readonly clips = new Map<AudioCue, HTMLAudioElement>();
  private readonly playedSounds = new Set<string>();
  private activeAlerts = new Set<string>();
  private lastTick = -1;
  private ambientRequested = false;
  private muted = false;

  constructor(
    private readonly cueForSound: (sound: SoundEvent) => SoundCue | undefined =
      (sound) => Object.hasOwn(sourceCues, sound.sourceId) ? sourceCues[sound.sourceId] : undefined,
  ) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      for (const clip of this.clips.values()) clip.pause();
    } else if (this.ambientRequested) {
      this.startAmbient();
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  startAmbient(): void {
    this.ambientRequested = true;
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
      const base = import.meta.env.BASE_URL;
      clip = new Audio(`${base}assets/audio/${cue}.wav`);
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
    for (const [cue, clip] of this.clips) if (cue !== 'ambient') clip.pause();
  }

  update(snapshot: WorldSnapshot): void {
    if (snapshot.tick < this.lastTick) this.reset();
    this.lastTick = snapshot.tick;

    for (const sound of snapshot.soundEvents) {
      if (this.playedSounds.has(sound.id)) continue;
      this.playedSounds.add(sound.id);
      const cue = this.cueForSound(sound);
      if (cue && !snapshot.paused) this.playCue(cue);
    }

    const activeAlerts = new Set(snapshot.activeAlerts.filter((alert) => alert.hops.length > 0)
      .map((alert) => JSON.stringify([alert.originAgentId, alert.hops.map((hop) => [hop.fromAgentId, hop.toAgentId, hop.depth])])));
    if (!snapshot.paused && [...activeAlerts].some((key) => !this.activeAlerts.has(key))) {
      this.playCue('zombie_alert');
    }
    this.activeAlerts = activeAlerts;
  }
}
