-- Inbound XCM arrivals, attributed to the account that received them.
--
-- The chain never tells us who an arrival was for. An inbound message surfaces as
-- `MessageQueue.Processed` / `DmpQueue.ExecutedDownward` / `XcmpQueue.Success|Fail`,
-- whose payloads carry a message id and an outcome and nothing else: the beneficiary
-- lives inside the XCM program's `DepositAsset` instruction, which the runtime does
-- not emit. So `raw_xcm_activity.recipient` is NULL on every inbound and processed
-- row (measured: 0 of 988,879), and the asset landing appears only as a bare
-- `Tokens.Deposited` with no XCM marker on it.
--
-- The external journey enrichment does not close it: it resolves the ORIGIN sender
-- well (`from_hex` 97.5% filled) and the destination poorly (`to_hex` 17.2%), because
-- the origin is a signed extrinsic on the sending chain while the destination is in
-- that same un-emitted instruction.
--
-- WHERE THE ROWS COME FROM. The activity feed has always decoded these, at request
-- time, by walking back from a barrier event over the credits it terminates
-- (`xcmCreditRun` / `xcmInboundCreditsForBlocks` in api/src/services/explorerService.ts).
-- This table stores the output of THAT walk — the derivation calls it and writes what
-- it returns. It is not a second implementation, and deliberately so: a SQL
-- restatement was written first and measured against the walk, and drifted four ways
--   * barrier set missing `DmpQueue.ExecutedDownward` (dropped a pre-migration credit),
--   * credit set missing `Balances.Issued` / `Balances.Minted`,
--   * reserved accounts filtered as `modl|ETH\0` instead of `modl|sibl|para`,
--   * no handling of the crossable events a run must step OVER — without crossing
--     `EVM.Log`, 149 of the first 151 HOLLAR arrivals decode to nothing at all.
-- An era switch on the MessageQueue migration block looked correct and silently
-- dropped 6,608 further credits, because `ParachainSystem.DownwardMessagesProcessed`
-- still fires in extrinsic context 84,106 times after it. The walk pairs each credit
-- with its barrier's own execution context instead, which is era-agnostic.
--
-- So the gap this table closes is not "the feed cannot show arrivals" — it can. It is
-- that nothing in the DATABASE could attribute one, so no SQL consumer (analysis, the
-- Data API) could ask who received an inbound transfer.
--
-- `attribution` is explicit rather than guessed, per the rule that unresolved XCM
-- endpoints are shown as unresolved:
--   'exact'     — one barrier in the credit's execution context, so its message is
--                 unambiguous
--   'ambiguous' — several; the credit is real and correctly attributed to an account
--                 by the walk, but which message paid it is not established
-- `from_chain` is only named by MessageQueue-era barriers; DMP is from the relay by
-- construction and an XCMP barrier names no sibling, so it is left empty there.
--
-- Replacement key is (block_height, event_index): the credit's own identity, so a
-- replayed range recomputes the same rows rather than doubling them.
CREATE TABLE IF NOT EXISTS price_data.xcm_arrivals (
  `block_height` UInt32,
  `event_index` UInt32,
  `block_timestamp` DateTime,
  `account` String,
  `asset_id` UInt32,
  `amount` String,
  `message_id` String,
  `message_event_index` UInt32,
  `barriers_in_context` UInt8,
  `attribution` LowCardinality(String),
  `from_chain` String,
  `from_parachain_id` Nullable(UInt32),
  `computed_at` DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_height, event_index)
SETTINGS index_granularity = 1024;

-- Account-first twin, so an account's arrivals are a primary-key read rather than a
-- scan of the block-ordered table. Chained off the base table rather than re-derived,
-- so replay safety rides the base row's replacement identity.
CREATE TABLE IF NOT EXISTS price_data.xcm_arrivals_by_account (
  `account` String,
  `block_height` UInt32,
  `event_index` UInt32,
  `block_timestamp` DateTime,
  `asset_id` UInt32,
  `amount` String,
  `message_id` String,
  `attribution` LowCardinality(String),
  `from_chain` String,
  `from_parachain_id` Nullable(UInt32),
  `computed_at` DateTime
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (account, block_height, event_index)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.xcm_arrivals_by_account_mv
TO price_data.xcm_arrivals_by_account AS
SELECT account, block_height, event_index, block_timestamp, asset_id, amount,
       message_id, attribution, from_chain, from_parachain_id, computed_at
FROM price_data.xcm_arrivals;
