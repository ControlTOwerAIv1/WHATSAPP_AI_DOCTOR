"""
Message Model — Individual WhatsApp messages (inbound and outbound).

Every message is persisted before processing (inbound) and after
generation (outbound). The wa_message_id field enables idempotency —
Meta occasionally delivers the same webhook payload twice.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


class Message(SQLModel, table=True):
    """A single WhatsApp message in either direction."""

    __tablename__ = "messages"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    session_id: uuid.UUID = Field(foreign_key="sessions.id", index=True)
    wa_message_id: Optional[str] = Field(
        default=None,
        unique=True,
        index=True,
        description="Meta's message ID for idempotency dedup",
    )
    direction: str = Field(description="'in' for inbound, 'out' for outbound")
    msg_type: str = Field(description="text, audio, image")
    content: Optional[str] = Field(default=None, description="Text content or media URL")
    transcript: Optional[str] = Field(
        default=None,
        description="STT transcript (for audio messages)",
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
