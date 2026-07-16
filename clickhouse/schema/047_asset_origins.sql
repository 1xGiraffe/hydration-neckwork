ALTER TABLE price_data.assets ADD COLUMN IF NOT EXISTS origin_ecosystem Nullable(String);
ALTER TABLE price_data.assets ADD COLUMN IF NOT EXISTS origin_chain_id Nullable(String);
ALTER TABLE price_data.assets ADD COLUMN IF NOT EXISTS origin_asset_id Nullable(String);
