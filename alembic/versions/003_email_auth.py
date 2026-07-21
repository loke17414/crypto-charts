"""Add email verification / password-reset tokens and consent fields.

Revision ID: 003_email_auth
Revises: 002_subscriptions_usage
Create Date: 2026-07-21

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003_email_auth"
down_revision: Union[str, Sequence[str], None] = "002_subscriptions_usage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True))

    # Existing accounts predate email verification — treat as verified so SMTP enablement
    # does not lock them out.
    op.execute(
        sa.text(
            "UPDATE users SET email_verified_at = COALESCE(created_at, CURRENT_TIMESTAMP) "
            "WHERE email_verified_at IS NULL"
        )
    )

    op.create_table(
        "email_tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_email_tokens_token_hash", "email_tokens", ["token_hash"], unique=True)
    op.create_index("ix_email_tokens_user_purpose", "email_tokens", ["user_id", "purpose"])


def downgrade() -> None:
    op.drop_index("ix_email_tokens_user_purpose", table_name="email_tokens")
    op.drop_index("ix_email_tokens_token_hash", table_name="email_tokens")
    op.drop_table("email_tokens")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("terms_accepted_at")
        batch.drop_column("email_verified_at")
