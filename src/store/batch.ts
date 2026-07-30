function assertPositiveChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('Batch flush threshold must be a positive integer')
  }
}

export function* chunkRows<T>(rows: readonly T[], chunkSize: number): Generator<T[]> {
  assertPositiveChunkSize(chunkSize)
  for (let index = 0; index < rows.length; index += chunkSize) {
    yield rows.slice(index, index + chunkSize)
  }
}

export class BatchAccumulator<T> {
  private buffer: T[] = []
  private readonly flushThreshold: number

  constructor(flushThreshold: number = 10_000) {
    assertPositiveChunkSize(flushThreshold)
    this.flushThreshold = flushThreshold
  }

  add(rows: T[]): void {
    for (const row of rows) {
      this.buffer.push(row)
    }
  }

  flush(): T[] {
    const rows = this.buffer
    this.buffer = []
    return rows
  }

  flushChunks(): T[][] {
    const rows = this.flush()
    return [...chunkRows(rows, this.flushThreshold)]
  }

  get size(): number {
    return this.buffer.length
  }
}
