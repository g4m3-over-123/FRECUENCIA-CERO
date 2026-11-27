/**
 * Deterministic PRNG for reproducible simulations and benchmarks.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    // TODO: Replace with Mulberry32 or xorshift32 implementation.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    return this.state / 0xffffffff;
  }
}
