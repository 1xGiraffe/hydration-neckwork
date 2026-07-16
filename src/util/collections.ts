export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

export function blockHeightRange(rows: { block_height: number }[]): { min: number; max: number } {
  let min = rows[0].block_height
  let max = rows[0].block_height
  for (let index = 1; index < rows.length; index++) {
    const height = rows[index].block_height
    if (height < min) min = height
    if (height > max) max = height
  }
  return { min, max }
}

export async function forEachConcurrent<T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++
      if (index >= items.length) return
      await handler(items[index])
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
