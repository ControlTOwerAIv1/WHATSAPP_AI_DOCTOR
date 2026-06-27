"""
Application DTOs — Data Transfer Objects for cross-layer communication.

These Pydantic models carry data between the API layer and the Application
layer (use cases). They are NOT the same as API schemas (core.schemas) —
DTOs are internal, schemas are external HTTP contracts.

Mapping:
    API Schema (HTTP) → DTO (internal) → Domain Entity (pure)
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class TranscribeInput(BaseModel):
    """Input DTO for the TranscribeUseCase."""

    audio_url: str
    patient_id: str
    session_id: str


class TranscribeOutput(BaseModel):
    """Output DTO from the TranscribeUseCase."""

    transcript: str
    detected_language: str
    translated_text: str | None = None
    timestamps: list[dict] = Field(default_factory=list)
    confidence: float = 0.0


class RespondInput(BaseModel):
    """Input DTO for the RespondUseCase."""

    text: str
    language: str
    voice: str = "doctor"


class RespondOutput(BaseModel):
    """Output DTO from the RespondUseCase."""

    voice_url: str
    format: str = "ogg"
