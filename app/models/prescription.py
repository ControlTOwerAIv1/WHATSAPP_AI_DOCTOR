"""
Prescription Model — Extracted medication prescriptions.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


class Prescription(SQLModel, table=True):
    """A medication prescription extracted from conversation or image."""

    __tablename__ = "prescriptions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_phone: str = Field(foreign_key="users.phone", index=True)
    drug_name: str
    dosage: Optional[str] = None
    frequency: Optional[str] = None
    parsed_from: Optional[str] = Field(
        default=None,
        description="Source: 'transcript', 'image', or 'text'",
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
