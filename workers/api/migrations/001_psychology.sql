-- Psychology consultation module (stages 1-6). Idempotent; safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_psychologist boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS psych_consultations (
  id varchar PRIMARY KEY,
  join_code varchar NOT NULL UNIQUE,
  room varchar NOT NULL,
  psychologist_id varchar NOT NULL REFERENCES users(id),
  patient_id varchar REFERENCES users(id),
  status varchar NOT NULL DEFAULT 'scheduled',          -- scheduled | active | ended
  recording_enabled boolean NOT NULL DEFAULT false,      -- off by default; only via explicit recording consent
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS psych_intake (
  consultation_id varchar PRIMARY KEY REFERENCES psych_consultations(id) ON DELETE CASCADE,
  full_name varchar, preferred_name varchar, date_of_birth date, contact varchar,
  preferred_language varchar, occupation varchar, extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS psych_consents (
  consultation_id varchar NOT NULL REFERENCES psych_consultations(id) ON DELETE CASCADE,
  kind varchar NOT NULL,   -- online_consultation | assessment | data_processing | observer_questionnaire | recording
  granted boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consultation_id, kind)
);

CREATE TABLE IF NOT EXISTS psych_assignments (
  id varchar PRIMARY KEY,
  consultation_id varchar NOT NULL REFERENCES psych_consultations(id) ON DELETE CASCADE,
  instrument varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'assigned',            -- assigned | active | paused | completed | ended
  draft_answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_by varchar NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS psych_assignments_open_uq
  ON psych_assignments (consultation_id, instrument) WHERE status IN ('assigned','active','paused');

-- One immutable submission per assignment. Changes only happen through psych_response_corrections.
CREATE TABLE IF NOT EXISTS psych_responses (
  id varchar PRIMARY KEY,
  assignment_id varchar NOT NULL UNIQUE REFERENCES psych_assignments(id) ON DELETE CASCADE,
  instrument varchar NOT NULL,
  instrument_version varchar NOT NULL,
  answers jsonb NOT NULL,
  total_score integer,
  severity varchar,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  corrected boolean NOT NULL DEFAULT false,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS psych_response_corrections (
  id varchar PRIMARY KEY,
  response_id varchar NOT NULL REFERENCES psych_responses(id) ON DELETE CASCADE,
  corrected_by varchar NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  previous_answers jsonb NOT NULL,
  previous_total integer,
  new_answers jsonb NOT NULL,
  new_total integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS psych_alerts (
  id varchar PRIMARY KEY,
  consultation_id varchar NOT NULL REFERENCES psych_consultations(id) ON DELETE CASCADE,
  assignment_id varchar REFERENCES psych_assignments(id) ON DELETE SET NULL,
  kind varchar NOT NULL,     -- phq9_item9
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by varchar REFERENCES users(id),
  acknowledged_at timestamptz
);

-- Append-only: ids and actions only, never answer text or free-text clinical content.
CREATE TABLE IF NOT EXISTS psych_audit_log (
  id varchar PRIMARY KEY,
  actor_id varchar,
  consultation_id varchar,
  action varchar NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psych_audit_consult_idx ON psych_audit_log (consultation_id, created_at);
