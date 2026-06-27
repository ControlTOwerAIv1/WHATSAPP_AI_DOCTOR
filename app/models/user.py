"""
User Model — WhatsApp users (patients).

Phone number is the primary key since WhatsApp identity = phone number.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    """A WhatsApp user (patient) identified by phone number."""

    __tablename__ = "users"

    phone: str = Field(primary_key=True, description="WhatsApp phone number (E.164 format)")
    name: Optional[str] = Field(default=None, description="Patient name, if known")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="When the user first interacted with the bot",
    )
