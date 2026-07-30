interface IntegerEnvironmentBounds {
  min?: number
  max?: number
}

export function integerFromEnvironment(name: string, fallback: number, bounds: IntegerEnvironmentBounds = {}): number {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  const min = bounds.min ?? 1
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

export function stringFromEnvironment(name: string, fallback: string): string {
  const value = process.env[name]
  return value == null || value === '' ? fallback : value
}

export function optionalStringFromEnvironment(name: string): string | undefined {
  const value = process.env[name]
  return value == null || value === '' ? undefined : value
}
