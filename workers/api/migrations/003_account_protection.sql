-- Account protection: durable login throttle, session revocation, email verification,
-- password reset tokens, TOTP MFA, recovery codes, audit log.
-- Idempotent and additive: nothing is dropped, renamed or overwritten.
-- Apply to a Neon dev branch first (workers/api/README), then production via the manual db-migrate workflow.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version     integer     NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled       boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_enc    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step     bigint;

-- Durable brute-force counters. `key` is a SHA-256 hex digest (no raw emails/IPs stored).
CREATE TABLE IF NOT EXISTS login_attempts (
  key      text PRIMARY KEY,
  fails    integer     NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL
);

-- Revoked access tokens (logout). Rows expire with the token.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_exp_idx ON revoked_tokens (expires_at);

-- Single-use, expiring credentials. Only the SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         bigserial PRIMARY KEY,
  user_id    varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text    NOT NULL CHECK (kind IN ('verify_email','reset_password','ws_ticket')),
  token_hash text    NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_kind_idx ON auth_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id        bigserial PRIMARY KEY,
  user_id   varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text    NOT NULL,
  used_at   timestamptz,
  UNIQUE (user_id, code_hash)
);

-- Security audit trail. No FK on purpose: records survive account deletion. Never stores secrets or message content.
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    varchar,
  action     text NOT NULL,
  ip         text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, created_at DESC);
