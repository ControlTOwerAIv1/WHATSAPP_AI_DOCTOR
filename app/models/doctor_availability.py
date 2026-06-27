"""
Doctor Availability Model — Available consultation slots.

For now this is a hardcoded availability table seeded with fake slots.
Phase 3+ will integrate with Google Calendar or a real scheduling system.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlmodel import Field, SQLModel


class DoctorAvailability(SQLModel, table=True):
    """An available time slot for doctor consultations."""

    __tablename__ = "doctor_availability"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    slot_start: datetime = Field(index=True)
    slot_end: datetime
    is_booked: bool = Field(default=False, index=True)
