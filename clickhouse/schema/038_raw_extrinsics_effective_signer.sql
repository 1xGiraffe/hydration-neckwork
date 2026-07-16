-- Initiator recovered for natively-unsigned *user* extrinsics that carry no
-- Substrate signature, so `signer` is NULL even though a real account triggered
-- them. Two cases populate this:
--   * Ethereum.transact                     -> H160 sender from the Ethereum.Executed event
--   * MultiTransactionPayment.dispatch_permit-> H160 owner from the call args
-- In both cases the H160 is stored in its truncated AccountId32 form
-- (0x45544800 + 20-byte H160 + zero pad), matching how EVM activity is keyed
-- elsewhere. NULL for natively-signed extrinsics (use `signer`) and for genuine
-- inherents / permissionless keeper ops (Timestamp.set, HSM.execute_arbitrage…).
-- Read paths use coalesce(signer, effective_signer) for the effective initiator.
ALTER TABLE price_data.raw_extrinsics
    ADD COLUMN IF NOT EXISTS effective_signer Nullable(String) AFTER signer;
