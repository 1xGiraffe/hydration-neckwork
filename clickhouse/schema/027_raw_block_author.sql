ALTER TABLE price_data.raw_blocks
ADD COLUMN IF NOT EXISTS author Nullable(String) AFTER spec_version;
