"""ORM models. Import every model module here so Alembic sees the full metadata."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


__all__ = ["Base"]
