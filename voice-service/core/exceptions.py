"""
Exceptions — Domain exception hierarchy for the voice processing pipeline.

Each exception maps to a specific HTTP status code. The API layer's exception
handlers translate these into appropriate HTTP responses.

Hierarchy:
    VoiceServiceError (base)
    ├── AudioDownloadError      → HTTP 408 (Request Timeout)
    ├── AudioValidationError    → HTTP 422 (Unprocessable Entity)
    ├── AudioProcessingError    → HTTP 500 (Internal Server Error)
    ├── TranscriptionError      → HTTP 500
    ├── TranslationError        → HTTP 500 (soft — returns transcript without translation)
    ├── SynthesisError          → HTTP 500
    └── StorageError            → HTTP 500
"""

from __future__ import annotations


class VoiceServiceError(Exception):
    """Base exception for all voice service errors.

    Attributes:
        message: Human-readable error description.
        details: Optional structured data for debugging.
        status_code: Suggested HTTP status code for API responses.
    """

    status_code: int = 500

    def __init__(
        self,
        message: str,
        details: dict | None = None,
        status_code: int | None = None,
    ) -> None:
        self.message = message
        self.details = details or {}
        if status_code is not None:
            self.status_code = status_code
        super().__init__(self.message)


class AudioDownloadError(VoiceServiceError):
    """Failed to download audio from the provided URL.

    Causes: timeout, unreachable host, invalid URL, HTTP error.
    Maps to: HTTP 408.
    """

    status_code: int = 408


class AudioValidationError(VoiceServiceError):
    """Audio file failed validation checks.

    Causes: unsupported MIME type, exceeds max duration, exceeds max file size,
    corrupted file, zero-length audio.
    Maps to: HTTP 422.
    """

    status_code: int = 422


class AudioProcessingError(VoiceServiceError):
    """Audio processing (normalization/encoding) failed.

    Causes: ffmpeg failure, corrupt audio stream, unsupported codec.
    Maps to: HTTP 500.
    """

    status_code: int = 500


class TranscriptionError(VoiceServiceError):
    """Speech recognition engine failed.

    Causes: model load failure, inference error, out of memory.
    Maps to: HTTP 500.
    """

    status_code: int = 500


class TranslationError(VoiceServiceError):
    """Translation service failed.

    This is a SOFT error — the pipeline should return the transcript
    without translation rather than failing entirely.
    Maps to: HTTP 500 (only if translation is the sole requested operation).
    """

    status_code: int = 500


class SynthesisError(VoiceServiceError):
    """Text-to-speech engine failed.

    Causes: API error, rate limit, invalid voice, network failure.
    Maps to: HTTP 500.
    """

    status_code: int = 500


class StorageError(VoiceServiceError):
    """File storage operation failed.

    Causes: disk full, permission denied, path not found.
    Maps to: HTTP 500.
    """

    status_code: int = 500
