"""Add subscriptions and usage_quotas tables (Toss Payments).

Revision ID: 002_subscriptions_usage
Revises: 001_create_users
Create Date: 2026-07-20

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002_subscriptions_usage"
down_revision: Union[str, Sequence[str], None] = "001_create_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("plan", sa.String(length=32), nullable=False, server_default="free"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="inactive"),
        sa.Column("toss_customer_key", sa.String(length=255), nullable=True),
        sa.Column("toss_billing_key_encrypted", sa.Text(), nullable=True),
        sa.Column("cancel_at_period_end", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_subscriptions_user"),
    )
    op.create_index("ix_subscriptions_toss_customer_key", "subscriptions", ["toss_customer_key"])

    op.create_table(
        "usage_quotas",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("week_start", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("bot_seconds_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("gpt_calls_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bot_session_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_usage_quotas_user"),
    )


def downgrade() -> None:
    op.drop_table("usage_quotas")
    op.drop_index("ix_subscriptions_toss_customer_key", table_name="subscriptions")
    op.drop_table("subscriptions")
