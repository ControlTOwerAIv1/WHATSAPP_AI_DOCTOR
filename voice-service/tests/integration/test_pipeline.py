"""
Integration Tests — Full Transcription Pipeline.

These tests require Docker services to be running:
  docker compose -f docker/docker-compose.yml up -d

Skip these tests when running in CI without Docker.
"""

from __future__ import annotations

import os

import pytest

# Skip all tests in this module if INTEGRATION env var is not set
pytestmark = pytest.mark.skipif(
    os.environ.get("INTEGRATION_TESTS", "0") != "1",
    reason="Integration tests require INTEGRATION_TESTS=1 and Docker services running",
)


class TestTranscribePipeline:
    """Integration tests for the full transcribe pipeline."""

    def test_transcribe_endpoint_with_mock_audio(self):
        """
        Full pipeline test: audio URL → transcript.

        To run:
            1. docker compose -f docker/docker-compose.yml up -d
            2. INTEGRATION_TESTS=1 pytest tests/integration/ -v
        """
        # This test would use httpx to call the running service
        # and verify the full pipeline works end-to-end.
        #
        # For now, this serves as a placeholder that documents
        # the integration test contract.
        #
        # Real implementation:
        # 1. Host a sample .ogg file on an accessible URL
        # 2. POST to /api/v1/voice/transcribe
        # 3. Verify the response contains a valid transcript
        pass


class TestRespondPipeline:
    """Integration tests for the full TTS pipeline."""

    def test_respond_endpoint_generates_audio(self):
        """
        Full pipeline test: text → OGG voice file.

        To run:
            1. docker compose -f docker/docker-compose.yml up -d
            2. Set VOICE_OPENAI_API_KEY in .env
            3. INTEGRATION_TESTS=1 pytest tests/integration/ -v
        """
        pass
