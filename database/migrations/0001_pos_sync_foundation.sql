CREATE TABLE pos_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX pos_devices_active_idx ON pos_devices(created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO catalog_state(id, version) VALUES (1, 0);

CREATE TABLE catalog_snapshots (
  version BIGINT PRIMARY KEY CHECK (version >= 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'online',
  ADD COLUMN device_id UUID REFERENCES pos_devices(id) ON DELETE RESTRICT,
  ADD COLUMN device_sequence BIGINT CHECK (device_sequence IS NULL OR device_sequence > 0),
  ADD COLUMN catalog_version BIGINT REFERENCES catalog_snapshots(version) ON DELETE RESTRICT,
  ADD COLUMN client_created_at TIMESTAMPTZ,
  ADD CONSTRAINT orders_source_check CHECK (source IN ('online', 'offline')),
  ADD CONSTRAINT orders_sync_metadata_check CHECK (
    (source = 'online' AND device_id IS NULL AND device_sequence IS NULL AND client_created_at IS NULL)
    OR
    (source = 'offline' AND device_id IS NOT NULL AND device_sequence IS NOT NULL
      AND catalog_version IS NOT NULL AND client_created_at IS NOT NULL)
  ),
  ADD CONSTRAINT orders_device_sequence_unique UNIQUE (device_id, device_sequence);

CREATE TABLE order_sync_receipts (
  request_id UUID PRIMARY KEY,
  cashier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_hash VARCHAR(64) CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  outcome VARCHAR(16) NOT NULL DEFAULT 'accepted'
    CHECK (outcome IN ('accepted', 'needs_review', 'rejected')),
  order_id BIGINT UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  device_id UUID REFERENCES pos_devices(id) ON DELETE RESTRICT,
  device_sequence BIGINT CHECK (device_sequence IS NULL OR device_sequence > 0),
  catalog_version BIGINT REFERENCES catalog_snapshots(version) ON DELETE RESTRICT,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (outcome = 'accepted' AND order_id IS NOT NULL)
    OR outcome IN ('needs_review', 'rejected')
  ),
  UNIQUE (device_id, device_sequence)
);
CREATE INDEX order_sync_receipts_cashier_idx
  ON order_sync_receipts(cashier_id, created_at DESC);

-- Existing orders have no original request payload to hash. A NULL hash marks
-- those legacy idempotency records; retries retain the previous same-cashier behavior.
INSERT INTO order_sync_receipts(request_id, cashier_id, payload_hash, outcome, order_id, created_at)
SELECT request_id, cashier_id, NULL, 'accepted', id, created_at
FROM orders
ON CONFLICT (request_id) DO NOTHING;

-- Capture the pre-existing catalog without changing any business rows.
INSERT INTO catalog_snapshots(version, snapshot)
SELECT 0, jsonb_build_object(
  'settings', (SELECT to_jsonb(s) FROM settings s WHERE s.id = 1),
  'categories', COALESCE(
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM categories c),
    '[]'::jsonb
  ),
  'products', COALESCE(
    (SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('category', c.name) ORDER BY p.id)
     FROM products p JOIN categories c ON c.id = p.category_id),
    '[]'::jsonb
  )
);
