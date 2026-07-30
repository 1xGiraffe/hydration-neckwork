export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
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
