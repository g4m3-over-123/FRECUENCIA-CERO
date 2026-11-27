/**
 * Web Audio API sound cues for footsteps, radio alerts, and ambient tension.
 */
export class AudioManager {
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  playCue(_name: string): void {
    // TODO: Load and trigger spatial/UI audio clips.
  }
}
