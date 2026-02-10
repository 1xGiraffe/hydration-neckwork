CREATE TABLE IF NOT EXISTS price_data.runtime_upgrades
(
    block_height UInt32,
    spec_version UInt32,
    prev_spec_version UInt32,
    detected_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY block_height
SETTINGS index_granularity = 8192;
