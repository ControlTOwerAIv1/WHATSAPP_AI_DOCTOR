"""
Appointment Model — Booked patient appointments.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


class Appointment(SQLModel, table=True):
    """A booked appointment for a patient."""

    __tablename__ = "appointments"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_phone: str = Field(foreign_key="users.phone", index=True)
    slot_start: datetime
    slot_end: datetime
    status: str = Field(default="confirmed", description="confirmed, cancelled, completed")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
