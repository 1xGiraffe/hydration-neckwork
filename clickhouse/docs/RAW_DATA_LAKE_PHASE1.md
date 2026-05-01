# Raw Data Lake Phase 1

## Scope

Phase 1 adds the minimum raw historical layer needed to:

- ingest Hydration execution data once
- persist it in `ClickHouse`
- let `preis` stop replaying historical storage from chain infrastructure
- preserve the current live `RPC` path

This phase does **not** replace the existing `prices`, `blocks`, `assets`, or OHLC tables. It adds a new `raw_*` namespace alongside the current derived price tables.

## Tables

Phase 1 introduces these tables:

- `raw_blocks` in [clickhouse/schema/021_raw_blocks.sql](../schema/021_raw_blocks.sql)
- `raw_extrinsics` in [clickhouse/schema/022_raw_extrinsics.sql](../schema/022_raw_extrinsics.sql)
- `raw_calls` in [clickhouse/schema/023_raw_calls.sql](../schema/023_raw_calls.sql)
- `raw_events` in [clickhouse/schema/024_raw_events.sql](../schema/024_raw_events.sql)
- `raw_block_snapshots` in [clickhouse/schema/025_raw_block_snapshots.sql](../schema/025_raw_block_snapshots.sql)
- `raw_ingestion_state` in [clickhouse/schema/026_raw_ingestion_state.sql](../schema/026_raw_ingestion_state.sql)

## Why These Tables

`raw_blocks`, `raw_extrinsics`, `raw_calls`, and `raw_events` capture execution history.

`raw_block_snapshots` captures state-at-block for the storage families that are expensive to reconstruct during replay.

`raw_ingestion_state` lets the raw historical indexer checkpoint independently of the existing price indexer.

## Snapshot Payload v1

`raw_block_snapshots.payload_json` should store one JSON document per block. The document should be schema-versioned and intentionally limited to the state needed by `preis` first.

Suggested payload for `snapshot_version = 1`:

```json
{
  "schema_version": 1,
  "block": {
    "height": 123,
    "hash": "0x...",
    "timestamp": "2026-01-01 00:00:00",
    "spec_version": 400
  },
  "assets": {
    "items": [
      {
        "assetId": 0,
        "symbol": "HDX",
        "name": "Hydration",
        "decimals": 12,
        "assetType": "Token",
        "parachainId": null
      }
    ],
    "atoken_equivalences": [
      [5, 1005]
    ],
    "lp_equivalences": [
      [690, 69]
    ]
  },
  "omnipool": {
    "account": "0x...",
    "assets": [
      {
        "asset_id": 0,
        "hub_reserve": "123",
        "reserve": "456",
        "shares": "789",
        "protocol_shares": "10",
        "cap": "11",
        "tradable": 63
      }
    ]
  },
  "xyk": {
    "pools": [
      {
        "pool_account": "0x...",
        "asset_a": 5,
        "asset_b": 10,
        "reserve_a": "123",
        "reserve_b": "456"
      }
    ]
  },
  "stableswap": {
    "pools": [
      {
        "pool_id": 1,
        "assets": [10, 22],
        "reserves": ["123", "456"],
        "amplification": "100",
        "initial_amplification": 100,
        "final_amplification": 100,
        "initial_block": 1000000,
        "final_block": 1000000,
        "fee": 30,
        "total_issuance": "789",
        "peg_multipliers": [["1", "1000000"]]
      }
    ]
  }
}
```

## Ingestion Rules

- Use `SQD` for blocks, extrinsics, calls, and events.
- Use `RPC` or SQD-backed storage reads for the state that feeds `raw_block_snapshots`.
- Keep `raw_blocks` and `raw_block_snapshots` aligned one-to-one by `block_height`.
- Phase 1 prioritizes historical persistence first, but the processor can continue tailing live finalized blocks once caught up.
- Use `ReplacingMergeTree` in the raw tables so a block can be safely re-ingested if needed.

## Recommended Processor Split

Implement a dedicated raw historical indexer instead of overloading the current price indexer.

Suggested repo shape:

- `src/raw/processor.ts`
- `src/raw/indexer.ts`
- `src/raw/store.ts`
- `src/raw/types.ts`
- `src/raw/snapshot.ts`
- `src/raw/json.ts`

The current `src/indexer.ts` should remain the downstream pricing pipeline for now.

## Required Processor Fields

The raw historical processor will need broader fields than the current price processor. At minimum:

- block timestamp
- block hash
- block parent hash
- block spec version
- extrinsic hash
- extrinsic fee
- call name
- call args
- call origin
- call success / error
- event name
- event args

## Phase 1 Implementation Checklist

- [ ] Apply `021`-`026` ClickHouse migrations.
- [ ] Add a dedicated raw processor entrypoint under `src/raw/`.
- [ ] Expand processor fields so blocks, extrinsics, calls, and events can be persisted directly.
- [ ] Create a `RawClickHouseStore` with batched inserts and per-table deduplication tokens.
- [ ] Write `raw_blocks` for every processed block.
- [ ] Write `raw_extrinsics`, `raw_calls`, and `raw_events` for every processed block.
- [ ] Build snapshot payload v1 from the same storage reads currently used by `preis`.
- [ ] Write one `raw_block_snapshots` row per block for historical backfill.
- [ ] Add `raw_ingestion_state` checkpoint save/load logic.
- [ ] Add rollback support for `raw_*` tables in the CLI.
- [ ] Add a standalone raw backfill command or entrypoint.
- [ ] Validate row counts by block range: `raw_blocks`, `raw_events`, and `raw_block_snapshots`.
- [ ] Add a `ClickHouseStateReader` for historical replay in `preis`.
- [ ] Route historical `preis` replay to `ClickHouseStateReader` and keep live replay on `RPC`.

## Validation Queries

Check block coverage:

```sql
SELECT min(block_height), max(block_height), count()
FROM price_data.raw_blocks;
```

Check event density:

```sql
SELECT event_name, count()
FROM price_data.raw_events
GROUP BY event_name
ORDER BY count() DESC
LIMIT 25;
```

Check snapshot coverage and payload size:

```sql
SELECT
  min(block_height),
  max(block_height),
  count(),
  round(avg(payload_size_bytes), 2) AS avg_payload_bytes
FROM price_data.raw_block_snapshots;
```

Check ingestion state:

```sql
SELECT *
FROM price_data.raw_ingestion_state FINAL;
```

## Rollout Order

1. Deploy the raw tables.
2. Backfill execution data and snapshots historically.
3. Verify coverage and payload integrity.
4. Add the historical ClickHouse reader to `preis`.
5. Switch historical replay to ClickHouse.
6. Keep live mode on `RPC`.

## Out of Scope for Phase 1

- full account-balance history tables
- token-distribution materializations
- normalized trade tables
- GraphQL or other serving layers
- full arbitrary storage coverage for every pallet

These can be added later once the raw historical foundation is in place.
