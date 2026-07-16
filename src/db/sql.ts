export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}
