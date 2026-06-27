"""
Unit Tests — DTOs and API Schemas.

Tests Pydantic validation for all request/response models.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from application.dto import RespondInput, RespondOutput, TranscribeInput, TranscribeOutput
from core.schemas import (
    DependenciesHealthResponse,
    DependencyStatus,
    ErrorResponse,
    HealthResponse,
    RespondRequest,
    RespondResponse,
    TimestampSchema,
    TranscribeRequest,
    TranscribeResponse,
)


class TestTranscribeRequest:
    """Tests for TranscribeRequest schema."""

    def test_valid_request(self):
        req = TranscribeRequest(
            audio_url="https://example.com/audio.ogg",
            patient_id="p1",
            session_id="s1",
        )
        assert req.audio_url == "https://example.com/audio.ogg"

    def test_missing_required_field(self):
        with pytest.raises(ValidationError):
            TranscribeRequest(audio_url="https://example.com/audio.ogg")  # type: ignore


class TestTranscribeResponse:
    """Tests for TranscribeResponse schema."""

    def test_valid_response(self):
        resp = TranscribeResponse(
            transcript="Hello world",
            detected_language="en",
            translated_text=None,
            timestamps=[],
            confidence=0.95,
        )
        assert resp.confidence == 0.95

    def test_with_timestamps(self):
        resp = TranscribeResponse(
            transcript="Hello",
            detected_language="en",
            confidence=0.9,
            timestamps=[
                TimestampSchema(start=0.0, end=1.0, text="Hello"),
            ],
        )
        assert len(resp.timestamps) == 1

    def test_confidence_bounds(self):
        with pytest.raises(ValidationError):
            TranscribeResponse(
                transcript="test",
                detected_language="en",
                confidence=1.5,  # exceeds 1.0
            )


class TestRespondRequest:
    """Tests for RespondRequest schema."""

    def test_valid_request(self):
        req = RespondRequest(
            text="Hello",
            language="en",
            voice="doctor",
        )
        assert req.voice == "doctor"

    def test_default_voice(self):
        req = RespondRequest(text="Hello", language="en")
        assert req.voice == "doctor"


class TestRespondResponse:
    """Tests for RespondResponse schema."""

    def test_valid_response(self):
        resp = RespondResponse(
            voice_url="http://localhost:8000/storage/generated/abc.ogg",
            format="ogg",
        )
        assert resp.format == "ogg"


class TestHealthSchemas:
    """Tests for health check schemas."""

    def test_health_response(self):
        resp = HealthResponse()
        assert resp.status == "healthy"

    def test_dependency_status(self):
        dep = DependencyStatus(
            name="redis",
            status="healthy",
            latency_ms=2.5,
        )
        assert dep.error is None

    def test_dependencies_response(self):
        resp = DependenciesHealthResponse(
            status="degraded",
            dependencies=[
                DependencyStatus(
                    name="redis",
                    status="healthy",
                    latency_ms=1.0,
                ),
                DependencyStatus(
                    name="libretranslate",
                    status="unhealthy",
                    latency_ms=5001.0,
                    error="Connection timeout",
                ),
            ],
        )
        assert resp.status == "degraded"
        assert len(resp.dependencies) == 2


class TestDTOs:
    """Tests for internal DTOs."""

    def test_transcribe_input(self):
        dto = TranscribeInput(
            audio_url="https://example.com/a.ogg",
            patient_id="p1",
            session_id="s1",
        )
        assert dto.patient_id == "p1"

    def test_transcribe_output(self):
        dto = TranscribeOutput(
            transcript="Hello",
            detected_language="en",
            confidence=0.9,
        )
        assert dto.translated_text is None

    def test_respond_input_default_voice(self):
        dto = RespondInput(text="Hello", language="en")
        assert dto.voice == "doctor"

    def test_respond_output(self):
        dto = RespondOutput(
            voice_url="http://localhost:8000/storage/generated/x.ogg"
        )
        assert dto.format == "ogg"


class TestErrorResponse:
    """Tests for error response schema."""

    def test_error_response(self):
        resp = ErrorResponse(
            error="AudioValidationError",
            message="File too large",
            details={"max_bytes": 25000000},
        )
        assert resp.error == "AudioValidationError"
