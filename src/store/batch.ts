export class BatchAccumulator<T> {
  private buffer: T[] = []
  private readonly flushThreshold: number

  constructor(flushThreshold: number = 10_000) {
    this.flushThreshold = flushThreshold
  }

  add(rows: T[]): void {
    this.buffer.push(...rows)
  }

  shouldFlush(): boolean {
    return this.buffer.length >= this.flushThreshold
  }

  flush(): T[] {
    const rows = this.buffer
    this.buffer = []
    return rows
  }

  remaining(): T[] {
    return this.buffer
  }

  get size(): number {
    return this.buffer.length
  }
}
