-- Isolated Aave markets may share an underlying reserve (HOLLAR) while using
-- different liquidity/borrow indices.  Preserve the emitting pool on reserve
-- observations so API reconstruction never mixes those indices.
ALTER TABLE price_data.raw_money_market_reserves
    ADD COLUMN IF NOT EXISTS pool_address String DEFAULT '' AFTER contract_address;
