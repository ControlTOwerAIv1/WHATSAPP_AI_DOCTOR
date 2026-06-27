"""
Session Model — Conversation sessions grouping related messages.

A new session is created when a patient starts a new conversation
(or after an inactivity timeout). Messages belong to sessions.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


class ConversationSession(SQLModel, table=True):
    """A conversation session between a patient and the AI bot."""

    __tablename__ = "sessions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_phone: str = Field(foreign_key="users.phone", index=True)
    started_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
    last_active_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
