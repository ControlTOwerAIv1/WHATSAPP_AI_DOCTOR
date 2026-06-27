"""
Unit Tests — Transcribe and Respond Use Cases.

Tests the application layer orchestration with all infrastructure mocked.
Verifies pipeline flow, error handling, and graceful degradation.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from application.dto import RespondInput, TranscribeInput
from application.respond_usecase import RespondUseCase
from application.transcribe_usecase import TranscribeUseCase
from core.config import VoiceServiceConfig
from core.exceptions import (
    AudioDownloadError,
    TranslationError,
)
from domain.entities import TranslationResult


class TestTranscribeUseCase:
    """Tests for TranscribeUseCase orchestration."""

    def test_full_pipeline_english(
        self,
        test_config: VoiceServiceConfig,
        mock_recognizer: MagicMock,
        mock_translator: MagicMock,
        mock_preprocessor: MagicMock,
        tmp_path: Path,
    ):
        """Verify full pipeline for English audio (no translation needed)."""
        config = test_config.model_copy(
            update={"audio_storage_path": str(tmp_path / "audio")}
        )

        usecase = TranscribeUseCase(
            recognizer=mock_recognizer,
            translator=mock_translator,
            preprocessor=mock_preprocessor,
            config=config,
        )

        # Mock the download
        with patch.object(usecase, "_download_audio") as mock_download:
            mock_download.return_value = str(tmp_path / "raw.ogg")

            input_dto = TranscribeInput(
                audio_url="https://example.com/audio.ogg",
                patient_id="patient_1",
                session_id="session_1",
            )

            result = usecase.execute(input_dto)

        assert result.transcript != ""
        assert result.detected_language == "en"
        assert result.translated_text is None  # English → English, no translation
        assert result.confidence > 0.0

    def test_full_pipeline_hindi_with_translation(
        self,
        test_config: VoiceServiceConfig,
        mock_translator: MagicMock,
        mock_preprocessor: MagicMock,
        sample_hindi_transcription,
        tmp_path: Path,
    ):
        """Verify full pipeline for Hindi audio with English translation."""
        config = test_config.model_copy(
            update={"audio_storage_path": str(tmp_path / "audio")}
        )

        # Mock recognizer returning Hindi
        mock_recognizer = MagicMock()
        mock_recognizer.transcribe.return_value = sample_hindi_transcription

        usecase = TranscribeUseCase(
            recognizer=mock_recognizer,
            translator=mock_translator,
            preprocessor=mock_preprocessor,
            config=config,
        )

        with patch.object(usecase, "_download_audio") as mock_download:
            mock_download.return_value = str(tmp_path / "raw.ogg")

            input_dto = TranscribeInput(
                audio_url="https://example.com/hindi.ogg",
                patient_id="patient_2",
                session_id="session_2",
            )

            result = usecase.execute(input_dto)

        assert result.detected_language == "hi"
        assert result.translated_text is not None
        mock_translator.translate.assert_called_once()

    def test_translation_failure_graceful_degradation(
        self,
        test_config: VoiceServiceConfig,
        mock_preprocessor: MagicMock,
        sample_hindi_transcription,
        tmp_path: Path,
    ):
        """Verify pipeline continues when translation fails."""
        config = test_config.model_copy(
            update={"audio_storage_path": str(tmp_path / "audio")}
        )

        mock_recognizer = MagicMock()
        mock_recognizer.transcribe.return_value = sample_hindi_transcription

        mock_translator = MagicMock()
        mock_translator.translate.side_effect = TranslationError("Service down")

        usecase = TranscribeUseCase(
            recognizer=mock_recognizer,
            translator=mock_translator,
            preprocessor=mock_preprocessor,
            config=config,
        )

        with patch.object(usecase, "_download_audio") as mock_download:
            mock_download.return_value = str(tmp_path / "raw.ogg")

            input_dto = TranscribeInput(
                audio_url="https://example.com/audio.ogg",
                patient_id="patient_3",
                session_id="session_3",
            )

            # Should NOT raise — graceful degradation
            result = usecase.execute(input_dto)

        assert result.transcript != ""
        assert result.translated_text is None  # Failed gracefully

    def test_translation_disabled(
        self,
        test_config: VoiceServiceConfig,
        mock_recognizer: MagicMock,
        mock_translator: MagicMock,
        mock_preprocessor: MagicMock,
        sample_hindi_transcription,
        tmp_path: Path,
    ):
        """Verify translation is skipped when disabled."""
        config = test_config.model_copy(
            update={
                "audio_storage_path": str(tmp_path / "audio"),
                "translation_enabled": False,
            }
        )

        # Hindi recognizer
        mock_recognizer.transcribe.return_value = sample_hindi_transcription

        usecase = TranscribeUseCase(
            recognizer=mock_recognizer,
            translator=mock_translator,
            preprocessor=mock_preprocessor,
            config=config,
        )

        with patch.object(usecase, "_download_audio") as mock_download:
            mock_download.return_value = str(tmp_path / "raw.ogg")

            input_dto = TranscribeInput(
                audio_url="https://example.com/audio.ogg",
                patient_id="patient_4",
                session_id="session_4",
            )

            result = usecase.execute(input_dto)

        assert result.translated_text is None
        mock_translator.translate.assert_not_called()


class TestRespondUseCase:
    """Tests for RespondUseCase orchestration."""

    def test_full_tts_pipeline(
        self,
        test_config: VoiceServiceConfig,
        mock_synthesizer: MagicMock,
        mock_encoder: MagicMock,
        tmp_path: Path,
    ):
        """Verify full TTS pipeline produces a voice URL."""
        config = test_config.model_copy(
            update={"generated_storage_path": str(tmp_path / "generated")}
        )

        # Make sure synthesizer returns a file that exists
        synth_path = tmp_path / "synth.wav"
        synth_path.write_bytes(b"\x00" * 48000)
        mock_synthesizer.synthesize.return_value = MagicMock(
            file_path=str(synth_path), format="wav", duration_seconds=1.0
        )

        usecase = RespondUseCase(
            synthesizer=mock_synthesizer,
            encoder=mock_encoder,
            config=config,
        )

        input_dto = RespondInput(
            text="Take your medicine at 9 AM.",
            language="en",
            voice="doctor",
        )

        result = usecase.execute(input_dto)

        assert result.format == "ogg"
        assert "http://localhost:8000" in result.voice_url
        mock_synthesizer.synthesize.assert_called_once()
        mock_encoder.encode_to_ogg_opus.assert_called_once()
