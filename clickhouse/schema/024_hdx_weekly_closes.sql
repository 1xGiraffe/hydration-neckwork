-- HDX's weekly closes for the /hdx history (api/src/services/hdxWeeklyCloses.ts): the
-- holder structure, the rotation links behind its holding ages and the realized price
-- each read every account's whole series of weekly closes, which from
-- account_balance_weekly (every asset, account-first, one argMax state per row) was a
-- 1.2 GiB read per statement. A generation holds the weeks before its `cut` of HDX and
-- the HDX bonds, each (account, asset) series stated only where its close changes
-- (~0.36M of HDX's ~2.0M closes); the readers carry a close forward through the weeks
-- they have none for, and take the weeks from the cut on from raw_balance_observations.
-- Written by the explorer api's `hdx-history` refresher as its own partition, published
-- by the pointer row in hdx_weekly_closes_state once complete; a fresh database builds
-- its first generation on the first read. Reproducible from account_balance_weekly.
CREATE TABLE IF NOT EXISTS price_data.hdx_weekly_closes (`snapshot_id` String, `account_id` String, `asset_id` String, `week_start` Date, `balance` UInt256) ENGINE = MergeTree PARTITION BY snapshot_id ORDER BY (snapshot_id, account_id, asset_id, week_start) SETTINGS index_granularity = 8192;
CREATE TABLE IF NOT EXISTS price_data.hdx_weekly_closes_state (`snapshot_key` String, `snapshot_id` String, `cut` Date, `cut_height` UInt32, `source_at` DateTime, `assets` Array(String), `row_count` UInt64, `computed_at` DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(computed_at) ORDER BY snapshot_key SETTINGS index_granularity = 64;

-- The server time of the newest insert into each week of account_balance_weekly: a
-- generation of hdx_weekly_closes is stale once a week before its cut took an insert at
-- or after its read began (a backfill, or a week's last blocks landing after the cut).
-- Chained off account_balance_weekly, so every insert reaches it, whatever wrote it.
-- Needs no history: a generation compares only inserts after its own read.
CREATE TABLE IF NOT EXISTS price_data.account_balance_weekly_marks (`week_start` Date, `inserted_at` SimpleAggregateFunction(max, DateTime)) ENGINE = AggregatingMergeTree ORDER BY week_start SETTINGS index_granularity = 64;
CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.account_balance_weekly_marks_mv TO price_data.account_balance_weekly_marks (`week_start` Date, `inserted_at` DateTime) AS SELECT week_start, max(now()) AS inserted_at FROM price_data.account_balance_weekly GROUP BY week_start;
