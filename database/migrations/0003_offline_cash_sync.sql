ALTER TABLE pos_devices
  ADD COLUMN last_order_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (last_order_sequence >= 0);

-- Keep existing order and idempotency rows intact. Offline sales are attributed
-- to their registered device because a device credential is not a cashier login.
ALTER TABLE orders ALTER COLUMN cashier_id DROP NOT NULL;
ALTER TABLE orders
  ADD CONSTRAINT orders_cashier_source_check
    CHECK (source = 'offline' OR cashier_id IS NOT NULL);

ALTER TABLE order_sync_receipts ALTER COLUMN cashier_id DROP NOT NULL;
ALTER TABLE order_sync_receipts
  ADD CONSTRAINT order_sync_receipts_actor_check
    CHECK (cashier_id IS NOT NULL OR device_id IS NOT NULL);

ALTER TABLE pos_offline_leases
  DROP CONSTRAINT IF EXISTS pos_offline_leases_capabilities_check;
ALTER TABLE pos_offline_leases
  ADD CONSTRAINT pos_offline_leases_capabilities_check CHECK (
    capabilities = '["catalog:read"]'::jsonb
    OR capabilities = '["catalog:read","orders:cash:offline"]'::jsonb
  );

CREATE INDEX IF NOT EXISTS orders_source_created_idx
  ON orders(source, created_at DESC);
