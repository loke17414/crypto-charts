"""Pro GPT weekly limit support: billing_interval + gpt_bonus_calls.

Revision ID: 005_pro_gpt_limits_billing
Revises: 004_prelaunch_commercial
Create Date: 2026-07-22

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005_pro_gpt_limits_billing"
down_revision: Union[str, Sequence[str], None] = "004_prelaunch_commercial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column("billing_interval", sa.String(length=16), nullable=False, server_default="month"),
    )
    op.add_column(
        "usage_quotas",
        sa.Column("gpt_bonus_calls", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("usage_quotas", "gpt_bonus_calls")
    op.drop_column("subscriptions", "billing_interval")
