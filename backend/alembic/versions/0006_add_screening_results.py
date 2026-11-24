"""add screening_results

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "screening_results",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("session_id", sa.String(), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scale", sa.String(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.Column("max_score", sa.Integer(), nullable=False),
        sa.Column("band", sa.String(), nullable=False),
        sa.Column("band_label", sa.String(), nullable=False),
        sa.Column("item9_positive", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.Column("language", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_screening_results_session_id", "screening_results", ["session_id"])
    op.create_index("ix_screening_results_user_id", "screening_results", ["user_id"])
    op.create_index("ux_screening_session_scale", "screening_results", ["session_id", "scale"], unique=True)


def downgrade() -> None:
    op.drop_index("ux_screening_session_scale", table_name="screening_results")
    op.drop_index("ix_screening_results_user_id", table_name="screening_results")
    op.drop_index("ix_screening_results_session_id", table_name="screening_results")
    op.drop_table("screening_results")
