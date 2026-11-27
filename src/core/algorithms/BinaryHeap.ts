/**
 * Min-heap priority queue used by shortest-path algorithms.
 */
export class BinaryHeap<T> {
  private items: Array<{ priority: number; value: T }> = [];

  get size(): number {
    return this.items.length;
  }

  push(value: T, priority: number): void {
    // TODO: Maintain heap invariant with sift-up.
    this.items.push({ priority, value });
  }

  pop(): T | undefined {
    // TODO: Extract minimum element and restore heap invariant with sift-down.
    return this.items.shift()?.value;
  }
}
