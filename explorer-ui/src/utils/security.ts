import type { WormholeAssetRow, WormholeChangeOrigin, WormholeFuse, WormholePeerRow, WormholeStatus } from '../types'

// Security-page pure helpers and the static reference tables the page renders
// beside its live data. Kept out of the component module so the load scale and
// the origin matrix can be imported by tests and by the page without dragging
// components along.

// One shared load scale for every gauge and meter on the page: green while there
// is room, amber past half, red past three quarters, and red for a tripped fuse.
export function loadColor(pct: number): string {
  if (pct >= 75) return 'var(--red)'
  if (pct >= 50) return 'var(--amber)'
  return 'var(--green)'
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0%'
  if (v < 0.01) return '<0.01%'
  return `${parseFloat(v.toFixed(digits))}%`
}

// A duration in whole blocks, said the way the pallet counts it. Hours up to
// two days, then days. The domain's own units are hours — the fuse period is
// spoken of as 24h, not one day — so the switch to days waits until hours stop
// being readable.
const DAY_THRESHOLD_HOURS = 48
function saidInUnits(mins: number): string {
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${Math.round(mins)} min`
  const hours = mins / 60
  if (hours < DAY_THRESHOLD_HOURS) return `${parseFloat(hours.toFixed(1))} h`
  return `${parseFloat((hours / 24).toFixed(1))} d`
}

// The pallet counts these windows in blocks; a reader wants them in hours. The
// rate that conversion uses is the caller's decision, because two different
// block times answer two different questions (api/src/services/blockTime.ts):
//
//   - A runtime CONSTANT — the fuse period, a scheduled lockdown span — is
//     derived from the runtime's slot time (`DAYS` = 43 200 blocks at 2s), so it
//     is said at the NOMINAL rate (`stats.nominalBlockSec`). At a measured
//     2.2s the pallet's 24h day would read 26.4h, which is not a number the
//     runtime has ever meant.
//   - A LIVE delta — blocks between the head and an unlock — plays out at the
//     pace the chain is actually producing, so it is said at the MEASURED rate
//     (`stats.avgBlockSec`).
//
// Both come from the same stats payload, and both follow the 2s migration on
// their own; neither is a constant in this file.
export function fmtBlocks(blocks: number, blockSec: number): string {
  return saidInUnits((blocks * blockSec) / 60)
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return saidInUnits(ms / 60_000)
}

// static reference

// Who can change each safety control, and how quickly. Bindings are the runtime's
// `Config` origins (runtime/hydradx/src); the committee thresholds come from
// EnsureProportionAtLeast<1,2> and <2,3> over the live member count, so they are
// rendered from the member count rather than hard-coded.
export interface ControlOrigin { control: string; committee: 'majority' | 'super' | null; others: string; speed: string }
export const CONTROL_ORIGINS: ControlOrigin[] = [
  { control: 'Circuit-breaker limits, lockdowns & egress config', committee: 'majority', others: 'Root · Omnipool admin referendum', speed: 'Immediate' },
  { control: 'Paused calls', committee: 'majority', others: 'Root · General admin referendum', speed: 'Immediate' },
  { control: 'Omnipool tradability & slip fee', committee: 'majority', others: 'Root · Omnipool admin referendum', speed: 'Immediate' },
  { control: 'Stablepool tradability', committee: 'majority', others: 'Root', speed: 'Immediate' },
  { control: 'Asset ban & registry rate limits', committee: 'majority', others: 'Root · General admin referendum', speed: 'Immediate' },
  { control: 'Bridge minter shutdown (NTT)', committee: 'majority', others: 'Root · General admin referendum', speed: 'Immediate' },
  { control: 'Emergency-admin dispatch (money market)', committee: 'majority', others: 'Root', speed: 'Immediate' },
  { control: 'XCMP channel suspension', committee: 'super', others: 'Root', speed: 'Immediate' },
  { control: 'Anything root-level, via the call whitelist', committee: 'majority', others: 'Whitelisted-caller referendum', speed: '≈4h 20m floor' },
  { control: 'Omnipool weight caps, token listing & removal', committee: null, others: 'Root · Omnipool admin referendum', speed: '7-day decision' },
  { control: 'HOLLAR Stability Module parameters', committee: null, others: 'Root · Economic parameters · General admin referendum', speed: '7-day decision' },
  { control: 'Duster whitelist', committee: null, others: 'Root · General admin referendum', speed: '7-day decision' },
  { control: 'Runtime upgrade', committee: null, others: 'Root referendum', speed: '7-day decision + 12h confirm' },
]

// Calls the runtime refuses to let the pause filter touch, so the committee can
// never switch off governance itself (runtime/hydradx/src/system.rs CallFilter).
export const UNPAUSABLE = ['System', 'Timestamp', 'ParachainSystem', 'Preimage', 'Referenda', 'ConvictionVoting', 'Whitelist', 'TransactionPause']

export interface Audit { date: string; firm: string; scope: string }
// Published reviews, from galacticcouncil/hydration-security. The docs site lists
// only the first two; the repository is the complete set.
export const AUDITS: Audit[] = [
  { date: 'Jun 2025', firm: 'Spearbit / Cantina', scope: 'HOLLAR Stability Module (peg support)' },
  { date: 'May 2025', firm: 'OAK Security', scope: 'Stablepools with drifting peg (draft)' },
  { date: 'Apr 2025', firm: 'Spearbit / Cantina', scope: 'Money-market on-chain liquidations' },
  { date: 'Jan 2025', firm: 'Spearbit / Cantina', scope: 'Aave v3 money-market deployment' },
  { date: 'Oct 2024', firm: 'Pashov Audit Group', scope: 'ERC-20 mapping' },
  { date: 'Jun 2024', firm: 'SRLabs', scope: 'EVM precompiles' },
  { date: 'Apr 2024', firm: 'Code4rena', scope: 'Omnipool, stablepools, oracles, circuit breaker' },
  { date: 'Jul 2023', firm: 'Runtime Verification', scope: 'Stableswap' },
  { date: 'Jun 2023', firm: 'Runtime Verification', scope: 'EMA oracle' },
  { date: 'Sep 2022', firm: 'Runtime Verification', scope: 'Omnipool' },
  { date: 'Mar 2022', firm: 'BlockScience', scope: 'Omnipool economics' },
]

export interface WormholeStatusMeta {
  // Badge wording in the assets table.
  label: string
  // Shared `.badge` modifier; `wh-quiet` is the page's own neutral chip.
  badge: string
  // The same verdict as a colour, for the beam edge and the overview card.
  tone: string
}
export const WORMHOLE_STATUS: Record<WormholeStatus, WormholeStatusMeta> = {
  ok: { label: 'Backed', badge: 'ok', tone: 'var(--green)' },
  surplus: { label: 'Surplus', badge: 'finalized', tone: 'var(--sky)' },
  attention: { label: 'Attention', badge: 'pending', tone: 'var(--amber)' },
  deficit: { label: 'Deficit', badge: 'fail', tone: 'var(--red)' },
  unverified: { label: 'Unverified', badge: 'pending', tone: 'var(--amber)' },
  unconfigured: { label: 'Unconfigured', badge: 'wh-quiet', tone: 'var(--text-low)' },
}

// Where a custody handle lives, per Wormhole chain id. Each chain names its own
// kind of thing: an EVM account, a Solana account, a Sui object.
const WORMHOLE_EXPLORERS: Record<number, { base: string; kind: string }> = {
  1: { base: 'https://orbmarkets.io/address/', kind: 'Orb' },
  2: { base: 'https://etherscan.io/address/', kind: 'Etherscan' },
  21: { base: 'https://suivision.xyz/object/', kind: 'SuiVision' },
  30: { base: 'https://basescan.org/address/', kind: 'BaseScan' },
  47: { base: 'https://hyperevmscan.io/address/', kind: 'HyperEVMScan' },
  72: { base: 'https://robinscan.io/address/', kind: 'Robinscan' },
}
export function wormholeExplorerLink(chainId: number, handle: string | null): { href: string; kind: string } | null {
  const meta = WORMHOLE_EXPLORERS[chainId]
  if (!meta || !handle) return null
  return { href: meta.base + encodeURIComponent(handle), kind: meta.kind }
}

// A Wormhole operation on the bridge's own explorer, keyed by its operation id.
export function wormholescanLink(id: string): string {
  return `https://wormholescan.io/#/tx/${encodeURIComponent(id)}`
}

export const SECURITY_LINKS = {
  audits: 'https://github.com/galacticcouncil/hydration-security',
  bounty: 'https://immunefi.com/bug-bounty/hydration/',
  docs: 'https://docs.hydration.net/security/intro',
}

// ---- Wormhole multi-peer helpers ----

// A peer's status, as its own chip. A lockbox's `ok` says it covers what the
// transfers through Hydration put into it; a spoke's that its supply was read.
export const WORMHOLE_PEER_STATUS: Record<WormholePeerRow['status'], { label: string; badge: string }> = {
  ok: { label: 'OK', badge: 'ok' },
  attention: { label: 'Attention', badge: 'pending' },
  unverified: { label: 'Unverified', badge: 'pending' },
  unconfigured: { label: 'No endpoint', badge: 'wh-quiet' },
}

// A chain on a fuse plate, where only a few characters fit.
const CHAIN_SHORT: Record<number, string> = { 1: 'SOL', 2: 'ETH', 21: 'SUI', 30: 'BASE', 47: 'HL', 72: 'RH', 73: 'HDX' }
export function chainShort(chainId: number, name: string): string {
  return CHAIN_SHORT[chainId] ?? name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase()
}

// Every chain of an asset that holds custody, Hydration first when it is one.
// An API from before the multi-peer model has no `peers`: its single origin is
// then the one lockbox, exactly as the row always meant.
export function lockboxChains(row: WormholeAssetRow, hydrationChainId: number): { chainId: number; name: string }[] {
  const peers = row.peers ?? []
  if (!peers.length) return row.hydrationRole === 'lockbox' ? [{ chainId: hydrationChainId, name: 'Hydration' }] : [{ chainId: row.originChainId, name: row.originChainName }]
  const out = peers.filter(p => p.role === 'lockbox').map(p => ({ chainId: p.chainId, name: p.chainName }))
  return row.hydrationRole === 'lockbox' ? [{ chainId: hydrationChainId, name: 'Hydration' }, ...out] : out
}

// "Ethereum + Robinhood" — the backing, said as the chains that hold it.
export function joinChains(names: readonly string[]): string {
  return names.length ? names.join(' + ') : '—'
}

// Who made a peer change, in a few words.
export function changeOriginLabel(origin: WormholeChangeOrigin): string {
  if (origin.kind === 'technical-committee') return origin.motionIndex != null ? `TC motion #${origin.motionIndex}` : 'Technical Committee'
  if (origin.kind === 'account') return `${origin.account.slice(0, 6)}…${origin.account.slice(-4)}`
  if (origin.kind === 'scheduled') return 'scheduled dispatch'
  return 'unknown origin'
}

/**
 * One direction of the traffic between Hydration and a peer, as the two
 * limiters it has to clear: entering Hydration it leaves the peer (the peer's
 * OUTBOUND leg) and arrives here (Hydration's INBOUND leg for that chain);
 * leaving, the reverse. The tile draws whichever has less left — the one that
 * binds — and the tooltip states both.
 */
export interface PeerFuseLeg {
  dir: 'in' | 'out'
  peerSide: WormholeFuse | null
  hydrationSide: WormholeFuse | null
  binding: WormholeFuse | null
  bindingSide: 'peer' | 'hydration' | null
}
export function peerFuseLeg(peer: Pick<WormholePeerRow, 'limits'>, dir: 'in' | 'out'): PeerFuseLeg {
  const peerSide = (dir === 'in' ? peer.limits?.peerOut : peer.limits?.peerIn) ?? null
  const hydrationSide = (dir === 'in' ? peer.limits?.hydrationIn : peer.limits?.hydrationOut) ?? null
  // Less headroom binds; on a tie the peer's leg is named, since that is the
  // one a transfer meets first entering Hydration and last leaving it.
  const left = (f: WormholeFuse) => BigInt(f.capacity)
  // Either side unread leaves the whole leg unread: the side that was read
  // alone would claim a headroom the other may not allow.
  const binding = peerSide == null || hydrationSide == null ? null
    : left(hydrationSide) < left(peerSide) ? hydrationSide : peerSide
  return { dir, peerSide, hydrationSide, binding, bindingSide: binding == null ? null : binding === peerSide ? 'peer' : 'hydration' }
}

// Hydration's own legs used to be uncapped everywhere (the u64 trimmed
// ceiling, 184,467,440,737 tokens). A leg below this is a real limit someone set.
export const HYDRATION_UNCAPPED_TOKENS = 1e11
