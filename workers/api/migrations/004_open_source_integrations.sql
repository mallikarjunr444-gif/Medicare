-- Roles, consent records, doctor-authorised access grants, email-OTP attempt counting.
-- Additive and idempotent. Widens one CHECK constraint (auth_tokens.kind); no data is changed or removed.
-- Apply to a Neon dev branch first, production only with approval.

ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'patient';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('patient','doctor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check
  CHECK (kind IN ('verify_email','reset_password','ws_ticket','email_otp'));

-- Append-only consent decisions. The latest row per (user, purpose) is the current state; withdrawing adds a row.
CREATE TABLE IF NOT EXISTS consents (
  id         bigserial PRIMARY KEY,
  user_id    varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text    NOT NULL CHECK (purpose IN ('terms','privacy','ai_processing','doctor_sharing','analytics')),
  granted    boolean NOT NULL,
  version    text    NOT NULL DEFAULT '1',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consents_user_purpose_idx ON consents (user_id, purpose, id DESC);

-- A patient authorises one doctor to read named record types until an expiry. Revocation is immediate.
CREATE TABLE IF NOT EXISTS access_grants (
  id         bigserial PRIMARY KEY,
  patient_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id  varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes     text[]  NOT NULL CHECK (scopes <@ ARRAY['health_records','reports']::text[] AND cardinality(scopes) > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (patient_id <> doctor_id)
);
CREATE INDEX IF NOT EXISTS access_grants_doctor_idx  ON access_grants (doctor_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS access_grants_patient_idx ON access_grants (patient_id);
