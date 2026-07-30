const MAX_BLOCK_HEIGHT = 0xffff_ffff

export interface BlockRangeOptions {
  fromBlock?: number
  toBlock?: number
}

function assertBlockHeight(value: number, option: '--from-block' | '--to-block'): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BLOCK_HEIGHT) {
    throw new RangeError(`${option} must be an integer between 0 and ${MAX_BLOCK_HEIGHT}`)
  }
}

export function parseBlockHeight(raw: string, option: '--from-block' | '--to-block'): number {
  if (!/^\d+$/.test(raw)) {
    throw new RangeError(`${option} must be an integer between 0 and ${MAX_BLOCK_HEIGHT}`)
  }

  const value = Number(raw)
  assertBlockHeight(value, option)
  return value
}

export function validateBlockRange({ fromBlock, toBlock }: BlockRangeOptions): void {
  if (fromBlock != null) assertBlockHeight(fromBlock, '--from-block')
  if (toBlock != null) assertBlockHeight(toBlock, '--to-block')
  if (fromBlock != null && toBlock != null && toBlock < fromBlock) {
    throw new RangeError(`--to-block (${toBlock}) must be greater than or equal to --from-block (${fromBlock})`)
  }
}
