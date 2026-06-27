"""
Unit Tests — Whisper Engine (STT adapter).

Tests the WhisperEngine adapter in isolation using mocked
faster-whisper model. Verifies:
  - Transcription output mapping
  - Confidence score calculation
  - Timestamp segment construction
  - Error handling for model failures
  - Lazy model loading behavior
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from core.config import VoiceServiceConfig
from core.exceptions import TranscriptionError
from domain.entities import TranscriptionResult
from stt.whisper_engine import WhisperEngine


class TestWhisperEngine:
    """Tests for WhisperEngine adapter."""

    def test_transcribe_returns_result(self, test_config: VoiceServiceConfig):
        """Verify transcribe() returns a TranscriptionResult with expected fields."""
        engine = WhisperEngine(test_config)

        # Mock the WhisperModel
        mock_segment = MagicMock()
        mock_segment.start = 0.0
        mock_segment.end = 3.5
        mock_segment.text = " Hello, how are you?"
        mock_segment.avg_logprob = -0.3

        mock_info = MagicMock()
        mock_info.language = "en"
        mock_info.language_probability = 0.95

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], mock_info)

        engine._model = mock_model

        result = engine.transcribe("/tmp/test.wav")

        assert isinstance(result, TranscriptionResult)
        assert result.transcript == "Hello, how are you?"
        assert result.detected_language == "en"
        assert len(result.timestamps) == 1
        assert result.timestamps[0].start == 0.0
        assert result.timestamps[0].end == 3.5
        assert 0.0 <= result.confidence <= 1.0

    def test_transcribe_multiple_segments(self, test_config: VoiceServiceConfig):
        """Verify multi-segment transcription concatenates correctly."""
        engine = WhisperEngine(test_config)

        seg1 = MagicMock()
        seg1.start = 0.0
        seg1.end = 2.0
        seg1.text = " Hello."
        seg1.avg_logprob = -0.2

        seg2 = MagicMock()
        seg2.start = 2.0
        seg2.end = 5.0
        seg2.text = " I need help."
        seg2.avg_logprob = -0.4

        mock_info = MagicMock()
        mock_info.language = "en"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([seg1, seg2], mock_info)

        engine._model = mock_model

        result = engine.transcribe("/tmp/test.wav")

        assert "Hello." in result.transcript
        assert "I need help." in result.transcript
        assert len(result.timestamps) == 2

    def test_transcribe_handles_model_error(self, test_config: VoiceServiceConfig):
        """Verify TranscriptionError is raised on model failure."""
        engine = WhisperEngine(test_config)

        mock_model = MagicMock()
        mock_model.transcribe.side_effect = RuntimeError("CUDA OOM")
        engine._model = mock_model

        with pytest.raises(TranscriptionError, match="Whisper transcription failed"):
            engine.transcribe("/tmp/test.wav")

    def test_lazy_model_loading(self, test_config: VoiceServiceConfig):
        """Verify model is not loaded until first transcribe() call."""
        engine = WhisperEngine(test_config)
        assert engine._model is None

    def test_model_load_failure(self, test_config: VoiceServiceConfig):
        """Verify TranscriptionError on model load failure."""
        engine = WhisperEngine(test_config)

        with patch(
            "stt.whisper_engine.WhisperModel",
            side_effect=Exception("Model not found"),
        ):
            with pytest.raises(TranscriptionError, match="Failed to load Whisper"):
                engine.transcribe("/tmp/test.wav")

    def test_empty_transcription(self, test_config: VoiceServiceConfig):
        """Verify handling of empty/silent audio."""
        engine = WhisperEngine(test_config)

        mock_info = MagicMock()
        mock_info.language = "en"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], mock_info)
        engine._model = mock_model

        result = engine.transcribe("/tmp/test.wav")

        assert result.transcript == ""
        assert result.confidence == 0.0
        assert len(result.timestamps) == 0
