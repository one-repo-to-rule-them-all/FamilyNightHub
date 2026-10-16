## Mako comment -- stripped from the generated migration, visible only when editing this
## template. NAMING RULE (OrderUp issue #84): a revision id must be at most 32 characters.
## Alembic's alembic_version.version_num column is varchar(32); a longer id runs the
## whole migration body and then fails on the version stamp, rolling everything back
## with "StringDataRightTruncation: value too long for type character varying(32)" --
## which reads like a broken data migration, not a too-long name. Pass a short slug to
## `alembic revision -m` (e.g. `ordering_modes_types`, not
## `ordering_modes_fulfillment_types`). Not yet CI-enforced.
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: Union[str, None] = ${repr(down_revision)}
branch_labels: Union[str, Sequence[str], None] = ${repr(branch_labels)}
depends_on: Union[str, Sequence[str], None] = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
