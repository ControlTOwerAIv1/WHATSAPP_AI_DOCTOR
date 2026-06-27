"""
Domain Entities — Pure value objects for the voice processing pipeline.

These are immutable dataclasses with zero external dependencies.
They represent the core data structures that flow through the system.
No Pydantic, no ORM, no framework imports.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AudioMetadata:
    """Metadata extracted from an audio file after validation and normalization."""

    file_path: str
    duration_seconds: float
    sample_rate: int
    channels: int
    mime_type: str
    file_size_bytes: int


@dataclass(frozen=True)
class TimestampSegment:
    """A single timestamped segment from speech recognition output."""

    start: float
    end: float
    text: str


@dataclass(frozen=True)
class TranscriptionResult:
    """Output from a speech recognition engine."""

    transcript: str
    detected_language: str
    confidence: float
    timestamps: list[TimestampSegment] = field(default_factory=list)


@dataclass(frozen=True)
class TranslationResult:
    """Output from a text translation provider."""

    source_language: str
    target_language: str
    original_text: str
    translated_text: str


@dataclass(frozen=True)
class SynthesisResult:
    """Output from a text-to-speech engine."""

    file_path: str
    format: str  # e.g. "ogg"
    duration_seconds: float


@dataclass(frozen=True)
class VoiceResponse:
    """Final response returned to the API caller after TTS + encoding."""

    voice_url: str
    format: str  # "ogg"
