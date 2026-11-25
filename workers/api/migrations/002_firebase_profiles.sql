-- Firebase Google auth, user profiles, health records and reports.
-- Idempotent and additive: nothing is dropped, renamed or overwritten, so it is
-- safe to re-run against the live Neon database (the deploy workflow applies it).
--
-- Mapping to the product vocabulary (existing tables are reused, not duplicated):
--   profiles       -> users (+ columns added below)
--   consultations  -> sessions (+ conversations, consultation_reports); all carry user_id
--   chat_history   -> messages (owned through sessions.user_id)
--   health_records -> NEW
--   reports        -> NEW (patient lab / imaging reports and their analysis)

-- ── users: Firebase identity + profile fields ────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid   varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url      text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone          varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth  date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender         varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_uq ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_gender_chk
    CHECK (gender IS NULL OR gender IN ('female','male','non_binary','other','prefer_not_to_say'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── health_records ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_records (
  id          varchar PRIMARY KEY,
  user_id     varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type varchar NOT NULL DEFAULT 'note',   -- condition | allergy | medication | vital | immunization | lab | note | other
  title       varchar NOT NULL,
  data        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_records_user_idx ON health_records (user_id, recorded_at DESC);

-- ── reports ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id          varchar PRIMARY KEY,
  user_id     varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  varchar REFERENCES sessions(id) ON DELETE SET NULL,
  report_type varchar NOT NULL DEFAULT 'lab',    -- lab | imaging | summary | other
  title       varchar NOT NULL,
  content     text,
  data        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_user_idx ON reports (user_id, created_at DESC);

-- ── lookups that every user-scoped query relies on ───────────────────────────
CREATE INDEX IF NOT EXISTS sessions_user_started_idx ON sessions (user_id, started_at DESC);
