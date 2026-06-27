"""
Unit Tests — OpenAI TTS Provider.

Tests the OpenAITTSProvider adapter in isolation with mocked OpenAI client.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from core.config import VoiceServiceConfig
from core.exceptions import SynthesisError
from domain.entities import SynthesisResult
from tts.openai_tts import OpenAITTSProvider


class TestOpenAITTSProvider:
    """Tests for OpenAITTSProvider adapter."""

    def test_synthesize_success(self, test_config: VoiceServiceConfig, tmp_path: Path):
        """Verify successful TTS synthesis."""
        test_config_mod = test_config.model_copy(
            update={"generated_storage_path": str(tmp_path / "generated")}
        )

        with patch("tts.openai_tts.OpenAI") as mock_openai_cls:
            mock_client = MagicMock()
            mock_response = MagicMock()

            # Simulate stream_to_file creating a file
            def fake_stream(path):
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                Path(path).write_bytes(b"\x00" * 48000)  # ~1 second of audio

            mock_response.stream_to_file = fake_stream
            mock_client.audio.speech.create.return_value = mock_response
            mock_openai_cls.return_value = mock_client

            provider = OpenAITTSProvider(test_config_mod)
            result = provider.synthesize(
                text="Take your medicine.",
                voice="doctor",
                language="en",
            )

        assert isinstance(result, SynthesisResult)
        assert result.format == "wav"
        assert Path(result.file_path).exists()

    def test_voice_mapping(self, test_config: VoiceServiceConfig, tmp_path: Path):
        """Verify voice role mapping to OpenAI voices."""
        test_config_mod = test_config.model_copy(
            update={"generated_storage_path": str(tmp_path / "generated")}
        )

        with patch("tts.openai_tts.OpenAI") as mock_openai_cls:
            mock_client = MagicMock()
            mock_response = MagicMock()

            def fake_stream(path):
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                Path(path).write_bytes(b"\x00" * 48000)

            mock_response.stream_to_file = fake_stream
            mock_client.audio.speech.create.return_value = mock_response
            mock_openai_cls.return_value = mock_client

            provider = OpenAITTSProvider(test_config_mod)
            provider.synthesize("test", voice="doctor", language="en")

            # Verify the correct OpenAI voice was used
            call_kwargs = mock_client.audio.speech.create.call_args
            assert call_kwargs.kwargs["voice"] == "onyx"

    def test_missing_api_key_raises_error(self, test_config: VoiceServiceConfig):
        """Verify SynthesisError when API key is empty."""
        test_config_mod = test_config.model_copy(update={"openai_api_key": ""})

        with pytest.raises(SynthesisError, match="API key is required"):
            OpenAITTSProvider(test_config_mod)

    def test_api_error_raises_synthesis_error(
        self, test_config: VoiceServiceConfig, tmp_path: Path
    ):
        """Verify SynthesisError on OpenAI API failure."""
        test_config_mod = test_config.model_copy(
            update={"generated_storage_path": str(tmp_path / "generated")}
        )

        with patch("tts.openai_tts.OpenAI") as mock_openai_cls:
            mock_client = MagicMock()
            from openai import OpenAIError

            mock_client.audio.speech.create.side_effect = OpenAIError("Rate limited")
            mock_openai_cls.return_value = mock_client

            provider = OpenAITTSProvider(test_config_mod)

            with pytest.raises(SynthesisError, match="OpenAI TTS API error"):
                provider.synthesize("test", voice="doctor", language="en")

    def test_default_voice_fallback(self, test_config: VoiceServiceConfig, tmp_path: Path):
        """Verify unknown voice role falls back to default."""
        test_config_mod = test_config.model_copy(
            update={"generated_storage_path": str(tmp_path / "generated")}
        )

        with patch("tts.openai_tts.OpenAI") as mock_openai_cls:
            mock_client = MagicMock()
            mock_response = MagicMock()

            def fake_stream(path):
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                Path(path).write_bytes(b"\x00" * 48000)

            mock_response.stream_to_file = fake_stream
            mock_client.audio.speech.create.return_value = mock_response
            mock_openai_cls.return_value = mock_client

            provider = OpenAITTSProvider(test_config_mod)
            provider.synthesize("test", voice="unknown_role", language="en")

            call_kwargs = mock_client.audio.speech.create.call_args
            assert call_kwargs.kwargs["voice"] == "onyx"  # default voice
