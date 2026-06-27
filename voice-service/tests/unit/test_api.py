"""
Unit Tests — API Endpoints (FastAPI routers).

Tests the API layer using FastAPI's TestClient with mocked use cases.
Verifies HTTP contracts, status codes, and response shapes.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from application.dto import RespondOutput, TranscribeOutput
from api.transcript import get_transcribe_usecase
from api.synthesize import get_respond_usecase
from main import app


@pytest.fixture
def mock_transcribe_output() -> TranscribeOutput:
    return TranscribeOutput(
        transcript="Hello, I have headaches.",
        detected_language="en",
        translated_text=None,
        timestamps=[
            {"start": 0.0, "end": 3.0, "text": "Hello, I have headaches."},
        ],
        confidence=0.92,
    )


@pytest.fixture
def mock_respond_output() -> RespondOutput:
    return RespondOutput(
        voice_url="http://localhost:8000/storage/generated/test123.ogg",
        format="ogg",
    )


@pytest.fixture
def client(
    mock_transcribe_output: TranscribeOutput,
    mock_respond_output: RespondOutput,
) -> TestClient:
    """Create a test client with mocked use cases."""
    mock_transcribe_uc = MagicMock()
    mock_transcribe_uc.execute.return_value = mock_transcribe_output

    mock_respond_uc = MagicMock()
    mock_respond_uc.execute.return_value = mock_respond_output

    app.dependency_overrides[get_transcribe_usecase] = lambda: mock_transcribe_uc
    app.dependency_overrides[get_respond_usecase] = lambda: mock_respond_uc

    yield TestClient(app)

    app.dependency_overrides.clear()


class TestTranscribeEndpoint:
    """Tests for POST /api/v1/voice/transcribe."""

    def test_transcribe_200(self, client: TestClient):
        """Verify 200 response with valid request."""
        response = client.post(
            "/api/v1/voice/transcribe",
            json={
                "audio_url": "https://example.com/audio.ogg",
                "patient_id": "p1",
                "session_id": "s1",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "transcript" in data
        assert "detected_language" in data
        assert "confidence" in data
        assert "timestamps" in data
        assert isinstance(data["timestamps"], list)

    def test_transcribe_422_missing_fields(self, client: TestClient):
        """Verify 422 when required fields are missing."""
        response = client.post(
            "/api/v1/voice/transcribe",
            json={"audio_url": "https://example.com/audio.ogg"},
        )
        assert response.status_code == 422

    def test_transcribe_422_empty_body(self, client: TestClient):
        """Verify 422 with empty body."""
        response = client.post("/api/v1/voice/transcribe", json={})
        assert response.status_code == 422


class TestRespondEndpoint:
    """Tests for POST /api/v1/voice/respond."""

    def test_respond_200(self, client: TestClient):
        """Verify 200 response with valid request."""
        response = client.post(
            "/api/v1/voice/respond",
            json={
                "text": "Take your medicine at 9 AM.",
                "language": "en",
                "voice": "doctor",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "voice_url" in data
        assert data["format"] == "ogg"

    def test_respond_default_voice(self, client: TestClient):
        """Verify default voice is used when not specified."""
        response = client.post(
            "/api/v1/voice/respond",
            json={
                "text": "Hello",
                "language": "en",
            },
        )
        assert response.status_code == 200

    def test_respond_422_missing_text(self, client: TestClient):
        """Verify 422 when text is missing."""
        response = client.post(
            "/api/v1/voice/respond",
            json={"language": "en"},
        )
        assert response.status_code == 422


class TestHealthEndpoints:
    """Tests for health check endpoints."""

    def test_health_200(self, client: TestClient):
        """Verify /health returns 200."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "healthy"

    def test_health_dependencies_200(self, client: TestClient):
        """Verify /health/dependencies returns 200."""
        response = client.get("/health/dependencies")
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "dependencies" in data
        assert isinstance(data["dependencies"], list)
