"""
API Schemas — Pydantic models for HTTP request/response validation.

These schemas define the external API contract. They are the ONLY models
that cross the HTTP boundary. Internal layers use domain entities and DTOs.

Contract is versioned at the URL level (/api/v1/), not at the schema level.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# ── Transcribe Endpoint ─────────────────────────────────────────────────

class TranscribeRequest(BaseModel):
    """POST /api/v1/voice/transcribe — Request body."""

    audio_url: str = Field(
        ...,
        description="URL to download the audio file from.",
        examples=["https://example.com/audio/recording.ogg"],
    )
    patient_id: str = Field(
        ...,
        description="Unique patient identifier.",
        examples=["patient_abc123"],
    )
    session_id: str = Field(
        ...,
        description="Unique session/conversation identifier.",
        examples=["session_xyz789"],
    )


class TimestampSchema(BaseModel):
    """A single timestamped segment in the transcription."""

    start: float = Field(..., description="Segment start time in seconds.")
    end: float = Field(..., description="Segment end time in seconds.")
    text: str = Field(..., description="Transcribed text for this segment.")


class TranscribeResponse(BaseModel):
    """POST /api/v1/voice/transcribe — Response body (200 OK)."""

    transcript: str = Field(
        ...,
        description="Full transcribed text.",
    )
    detected_language: str = Field(
        ...,
        description="ISO 639-1 language code detected in the audio.",
        examples=["en", "hi", "ta"],
    )
    translated_text: str | None = Field(
        default=None,
        description=(
            "English translation of the transcript. "
            "Null if source language is already the target language "
            "or if translation is disabled/failed."
        ),
    )
    timestamps: list[TimestampSchema] = Field(
        default_factory=list,
        description="Timestamped segments of the transcription.",
    )
    confidence: float = Field(
        ...,
        description="Overall transcription confidence score (0.0 to 1.0).",
        ge=0.0,
        le=1.0,
    )


# ── Respond Endpoint ────────────────────────────────────────────────────

class RespondRequest(BaseModel):
    """POST /api/v1/voice/respond — Request body."""

    text: str = Field(
        ...,
        description="Text to convert to speech.",
        examples=["Take your medicine at 9 AM."],
    )
    language: str = Field(
        ...,
        description="ISO 639-1 language code for pronunciation.",
        examples=["en", "hi"],
    )
    voice: str = Field(
        default="doctor",
        description="Voice role identifier (mapped to provider voice).",
        examples=["doctor", "patient", "system"],
    )


class RespondResponse(BaseModel):
    """POST /api/v1/voice/respond — Response body (200 OK)."""

    voice_url: str = Field(
        ...,
        description="URL to download the generated voice file.",
        examples=["http://localhost:8000/storage/generated/abc123.ogg"],
    )
    format: str = Field(
        default="ogg",
        description="Audio format of the generated file.",
    )


# ── Health Endpoints ────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    """GET /health — Response body."""

    status: str = Field(
        default="healthy",
        description="Service health status.",
    )


class DependencyStatus(BaseModel):
    """Status of a single dependency in the health check."""

    name: str = Field(..., description="Dependency name.")
    status: str = Field(
        ...,
        description="Dependency status: 'healthy' or 'unhealthy'.",
    )
    latency_ms: float | None = Field(
        default=None,
        description="Response latency in milliseconds.",
    )
    error: str | None = Field(
        default=None,
        description="Error message if unhealthy.",
    )


class DependenciesHealthResponse(BaseModel):
    """GET /health/dependencies — Response body."""

    status: str = Field(
        ...,
        description="Overall status: 'healthy' if all deps are healthy.",
    )
    dependencies: list[DependencyStatus] = Field(
        default_factory=list,
        description="Individual dependency statuses.",
    )


# ── Error Response ──────────────────────────────────────────────────────

class ErrorResponse(BaseModel):
    """Standard error response body for all error HTTP codes."""

    error: str = Field(..., description="Error type.")
    message: str = Field(..., description="Human-readable error description.")
    details: dict | None = Field(
        default=None,
        description="Additional structured error data.",
    )
