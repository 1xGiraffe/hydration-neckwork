export function defisimAccountTarget(account: { accountId: string; address: string } | null, fallback?: string | null): string | undefined {
  if (!account) return fallback ?? undefined
  // DefiSim expects an H160 for EVM accounts; substrate accounts use the raw
  // AccountId32 understood by its chain RPC layer.
  return /^0x[0-9a-f]{40}$/i.test(account.address) ? account.address : account.accountId
}
