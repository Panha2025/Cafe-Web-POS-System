ALTER TABLE pos_devices
  ADD COLUMN enrolled_at TIMESTAMPTZ;

CREATE TABLE pos_device_enrollment_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES pos_devices(id) ON DELETE RESTRICT,
  code_hash VARCHAR(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX pos_device_enrollment_codes_expiry_idx
  ON pos_device_enrollment_codes(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE pos_device_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES pos_devices(id) ON DELETE RESTRICT,
  algorithm VARCHAR(32) NOT NULL CHECK (algorithm = 'ECDSA-P256-SHA256'),
  public_key_spki TEXT NOT NULL,
  public_key_sha256 VARCHAR(64) NOT NULL CHECK (public_key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  rotated_from UUID REFERENCES pos_device_credentials(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX pos_device_credentials_one_active_idx
  ON pos_device_credentials(device_id) WHERE revoked_at IS NULL;
CREATE INDEX pos_device_credentials_device_idx
  ON pos_device_credentials(device_id, created_at DESC);

CREATE TABLE pos_device_challenges (
  challenge_hash VARCHAR(64) PRIMARY KEY CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  device_id UUID NOT NULL REFERENCES pos_devices(id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL REFERENCES pos_device_credentials(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX pos_device_challenges_expiry_idx
  ON pos_device_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE catalog_snapshot_signatures (
  version BIGINT NOT NULL REFERENCES catalog_snapshots(version) ON DELETE RESTRICT,
  key_id VARCHAR(100) NOT NULL,
  public_key_sha256 VARCHAR(64) NOT NULL CHECK (public_key_sha256 ~ '^[0-9a-f]{64}$'),
  payload_text TEXT NOT NULL,
  payload_sha256 VARCHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version, key_id)
);

CREATE TABLE pos_offline_leases (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES pos_devices(id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL REFERENCES pos_device_credentials(id) ON DELETE RESTRICT,
  catalog_version BIGINT NOT NULL REFERENCES catalog_snapshots(version) ON DELETE RESTRICT,
  key_id VARCHAR(100) NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '["catalog:read"]'::jsonb
    CHECK (capabilities = '["catalog:read"]'::jsonb),
  payload_text TEXT NOT NULL,
  payload_sha256 VARCHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);
CREATE INDEX pos_offline_leases_device_idx
  ON pos_offline_leases(device_id, created_at DESC);
