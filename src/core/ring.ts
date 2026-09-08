/** Fixed-capacity circular buffer. Overwrites the oldest entry on overflow. */
export class Ring<T extends { seq?: number }> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;
  private _seq = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    this.buf = new Array<T | undefined>(this.capacity);
  }

  /**
   * Pushes an item. If item.seq is not set, Ring assigns its monotonic sequence number.
   * Returns the assigned sequence number.
   */
  push(v: T): number {
    this._seq++;
    if (v.seq === undefined || v.seq === null) {
      v.seq = this._seq;
    }
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return v.seq;
  }

  all(): T[] {
    const out: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const v = this.buf[(start + i) % this.capacity];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  /**
   * Returns entries with seq > given seq without materialising the entire buffer first.
   */
  since(seq: number): T[] {
    const out: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const v = this.buf[(start + i) % this.capacity];
      if (v !== undefined && typeof v.seq === 'number' && v.seq > seq) {
        out.push(v);
      }
    }
    return out;
  }

  clear(): void {
    this.buf = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  get seq(): number {
    return this._seq;
  }

  get size(): number {
    return this.count;
  }
}
