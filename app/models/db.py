"""
Database — SQLModel engine and session management.

Provides:
  - get_engine() → singleton SQLAlchemy engine
  - get_session() → FastAPI dependency yielding a Session per request

Used by the Meta Cloud API webhook pipeline (dispatcher.py).
Not used in the Twilio demo path.
"""

from __future__ import annotations

from typing import Generator

from sqlmodel import Session, SQLModel, create_engine

from core.config import get_settings
from core.logging import get_logger

logger = get_logger(__name__)

_engine = None


def get_engine():
    """Get or create the singleton SQLAlchemy engine."""
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_engine(
            settings.database_url,
            echo=settings.debug,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=20,
        )
    return _engine


def get_session() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session per request."""
    engine = get_engine()
    with Session(engine) as session:
        yield session
