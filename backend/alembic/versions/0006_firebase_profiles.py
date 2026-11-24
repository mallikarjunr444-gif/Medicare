"""firebase profile columns, health_records, reports

Mirrors workers/api/migrations/002_firebase_profiles.sql (applied to Neon by the API's migration workflow).
Additive and idempotent: safe whether or not that SQL has already been applied.

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for col, typ in [
        ("firebase_uid", "varchar"), ("photo_url", "text"), ("phone", "varchar"),
        ("date_of_birth", "date"), ("gender", "varchar"), ("last_login_at", "timestamptz"),
    ]:
        op.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {typ}")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_uq ON users (firebase_uid) WHERE firebase_uid IS NOT NULL")
    op.execute("""
        DO $$ BEGIN
          ALTER TABLE users ADD CONSTRAINT users_gender_chk
            CHECK (gender IS NULL OR gender IN ('female','male','non_binary','other','prefer_not_to_say'));
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS health_records (
          id varchar PRIMARY KEY,
          user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          record_type varchar NOT NULL DEFAULT 'note',
          title varchar NOT NULL,
          data jsonb NOT NULL DEFAULT '{}'::jsonb,
          recorded_at timestamptz NOT NULL DEFAULT now(),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS health_records_user_idx ON health_records (user_id, recorded_at DESC)")
    op.execute("""
        CREATE TABLE IF NOT EXISTS reports (
          id varchar PRIMARY KEY,
          user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id varchar REFERENCES sessions(id) ON DELETE SET NULL,
          report_type varchar NOT NULL DEFAULT 'lab',
          title varchar NOT NULL,
          content text,
          data jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS reports_user_idx ON reports (user_id, created_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS sessions_user_started_idx ON sessions (user_id, started_at DESC)")


def downgrade() -> None:
    # Deliberately non-destructive: user-owned health data is never dropped by a downgrade.
    pass
