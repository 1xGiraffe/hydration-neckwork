import type { AssetMetadata } from '../registry/types.ts'

export interface RawBlockRow {
  block_height: number
  block_hash: string
  parent_hash: string
  state_root: string | null
  extrinsics_root: string | null
  block_timestamp: string
  spec_version: number
  ingest_source: string
}

export interface RawExtrinsicRow {
  block_height: number
  block_timestamp: string
  extrinsic_index: number
  extrinsic_hash: string
  version: number
  signer: string | null
  fee: string | null
  tip: string | null
  success: number
  signature_json: string | null
  call_name: string
  call_args_json: string
  error_json: string | null
  ingest_source: string
}

export interface RawCallRow {
  block_height: number
  block_timestamp: string
  extrinsic_index: number | null
  call_address: string
  parent_call_address: string | null
  call_name: string
  origin_json: string | null
  args_json: string
  success: number | null
  error_json: string | null
  ingest_source: string
}

export interface RawEventRow {
  block_height: number
  block_timestamp: string
  event_index: number
  extrinsic_index: number | null
  call_address: string | null
  phase: string
  event_name: string
  args_json: string
  ingest_source: string
}

export interface RawBlockSnapshotRow {
  block_height: number
  block_hash: string
  block_timestamp: string
  spec_version: number
  snapshot_version: number
  families: string[]
  payload_format: string
  payload_json: string
  payload_sha256: string
  ingest_source: string
}

export interface RawIngestionStateRow {
  pipeline_id: string
  last_block: number
  last_hash: string
  mode: string
  state_json?: string
  updated_at?: string
}

export interface SnapshotOmnipoolAsset {
  asset_id: number
  hub_reserve: string
  reserve: string
  shares: string
  protocol_shares: string
  cap: string
  tradable: number
}

export interface SnapshotXykPoolState {
  pool_account: string
  asset_a: number
  asset_b: number
  reserve_a: string
  reserve_b: string
}

export interface SnapshotStableswapPoolState {
  pool_id: number
  assets: number[]
  reserves: string[]
  amplification: string
  fee: number
  total_issuance?: string
  peg_multipliers?: [string, string][]
  initial_amplification: number
  final_amplification: number
  initial_block: number
  final_block: number
}

export interface SnapshotState {
  assets: AssetMetadata[]
  atoken_equivalences: [number, number][]
  lp_equivalences: [number, number][]
  omnipool_account: string
  omnipool_assets: SnapshotOmnipoolAsset[]
  xyk_pools: SnapshotXykPoolState[]
  stableswap_pools: SnapshotStableswapPoolState[]
}

export interface SnapshotPayload {
  schema_version: number
  block: {
    height: number
    hash: string
    timestamp: string
    spec_version: number
  }
  assets: {
    items: AssetMetadata[]
    atoken_equivalences: [number, number][]
    lp_equivalences: [number, number][]
  }
  omnipool: {
    account: string
    assets: SnapshotOmnipoolAsset[]
  }
  xyk: {
    pools: SnapshotXykPoolState[]
  }
  stableswap: {
    pools: SnapshotStableswapPoolState[]
  }
}
