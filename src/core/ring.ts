/** Fixed-capacity circular buffer. Overwrites the oldest entry on overflow. */
export class Ring<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;
  private _seq = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    this.buf = new Array<T | undefined>(this.capacity);
  }

  push(v: T): void {
    this._seq++;
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
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

  /** Entries with `seq > since`. Assumes pushed entries expose a numeric `seq`. */
  since(seq: number): T[] {
    return this.all().filter((e) => typeof (e as { seq?: number })?.seq === 'number' && (e as { seq: number }).seq > seq);
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
