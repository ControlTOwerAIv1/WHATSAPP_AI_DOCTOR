"""
Database — SQLModel engine and session management.

Provides:
  - get_engine() → singleton SQLAlchemy engine
  - get_session() → FastAPI dependency yielding a Session per request
  - init_db() → create all tables + seed doctor availability slots

Usage:
    # At startup:
    init_db()

    # In route handlers:
    @router.get("/")
    def index(session: Session = Depends(get_session)):
        ...
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
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


def init_db() -> None:
    """Create all tables and seed initial data.

    Called once at application startup. Safe to call multiple times —
    create_all is idempotent (skips existing tables).
    """
    # Import all models so SQLModel registers them
    from models.user import User  # noqa: F401
    from models.session import ConversationSession  # noqa: F401
    from models.message import Message  # noqa: F401
    from models.appointment import Appointment  # noqa: F401
    from models.prescription import Prescription  # noqa: F401
    from models.doctor_availability import DoctorAvailability  # noqa: F401

    engine = get_engine()
    SQLModel.metadata.create_all(engine)
    logger.info("database_tables_created")

    # Seed doctor availability slots if none exist
    _seed_availability(engine)


def _seed_availability(engine) -> None:
    """Seed fake doctor availability slots for development.

    Creates 10 slots over the next 7 days if the table is empty.
    """
    from models.doctor_availability import DoctorAvailability

    with Session(engine) as session:
        existing = session.query(DoctorAvailability).first()
        if existing is not None:
            logger.info("seed_skipped", reason="slots_already_exist")
            return

        now = datetime.now(timezone.utc)
        # Start from tomorrow at 9:00 AM UTC
        base = now.replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=1)

        slots = []
        for day_offset in range(7):
            day = base + timedelta(days=day_offset)
            # Skip weekends (Saturday=5, Sunday=6)
            if day.weekday() in (5, 6):
                continue
            # Create morning and afternoon slots
            for hour in (9, 10, 11, 14, 15):
                slot_start = day.replace(hour=hour, minute=0)
                slot_end = slot_start + timedelta(minutes=30)
                slots.append(
                    DoctorAvailability(
                        id=uuid.uuid4(),
                        slot_start=slot_start,
                        slot_end=slot_end,
                        is_booked=False,
                    )
                )
                if len(slots) >= 10:
                    break
            if len(slots) >= 10:
                break

        for slot in slots:
            session.add(slot)
        session.commit()

        logger.info("seed_availability_complete", slots_created=len(slots))
