/**
 * Min-heap priority queue used by shortest-path algorithms.
 * push / pop: O(log n). peek / size: O(1). Space: O(n).
 * Ties are broken by insertion order (FIFO) to keep results deterministic.
 */
export class BinaryHeap<T> {
  private priorities: number[] = [];
  private order: number[] = [];
  private values: T[] = [];
  private counter = 0;

  get size(): number {
    return this.values.length;
  }

  isEmpty(): boolean {
    return this.values.length === 0;
  }

  clear(): void {
    this.priorities = [];
    this.order = [];
    this.values = [];
    this.counter = 0;
  }

  peek(): T | undefined {
    return this.values[0];
  }

  peekPriority(): number | undefined {
    return this.priorities[0];
  }

  push(value: T, priority: number): void {
    this.values.push(value);
    this.priorities.push(priority);
    this.order.push(this.counter++);
    this.siftUp(this.values.length - 1);
  }

  pop(): T | undefined {
    const n = this.values.length;
    if (n === 0) return undefined;
    const top = this.values[0];
    const last = n - 1;
    if (last > 0) this.swap(0, last);
    this.values.pop();
    this.priorities.pop();
    this.order.pop();
    if (this.values.length > 1) this.siftDown(0);
    return top;
  }

  private less(a: number, b: number): boolean {
    const pa = this.priorities[a];
    const pb = this.priorities[b];
    return pa < pb || (pa === pb && this.order[a] < this.order[b]);
  }

  private swap(a: number, b: number): void {
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
    [this.order[a], this.order[b]] = [this.order[b], this.order[a]];
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(index: number): void {
    const n = this.values.length;
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }
}
