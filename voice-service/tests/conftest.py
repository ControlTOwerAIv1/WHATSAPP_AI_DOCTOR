"""
Shared Test Fixtures — Mock factories and configuration for all tests.

Provides:
  - Mock implementations of all domain protocol contracts
  - Test configuration with safe defaults
  - Sample data factories
  - FastAPI TestClient setup
"""

from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Ensure the project root is on sys.path for imports
PROJECT_ROOT = str(Path(__file__).parent.parent)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.config import VoiceServiceConfig
from domain.entities import (
    AudioMetadata,
    SynthesisResult,
    TimestampSegment,
    TranscriptionResult,
    TranslationResult,
)


# ── Test Configuration ──────────────────────────────────────────────

@pytest.fixture
def test_config(tmp_path: Path) -> VoiceServiceConfig:
    """Configuration with safe defaults for testing."""
    return VoiceServiceConfig(
        whisper_model_size="tiny",
        whisper_device="cpu",
        whisper_compute_type="int8",
        openai_api_key="sk-test-key-for-testing-only",
        libretranslate_url="http://localhost:5000",
        audio_storage_path=str(tmp_path / "audio"),
        generated_storage_path=str(tmp_path / "generated"),
        base_url="http://localhost:8000",
        celery_broker_url="redis://localhost:6379/0",
        celery_result_backend="redis://localhost:6379/0",
        translation_enabled=True,
        translation_target_language="en",
        max_audio_duration_seconds=60,
        max_audio_file_size_mb=25,
        log_level="DEBUG",
        debug=True,
        environment="test",
    )


# ── Sample Data Factories ──────────────────────────────────────────

@pytest.fixture
def sample_transcription() -> TranscriptionResult:
    """A realistic transcription result."""
    return TranscriptionResult(
        transcript="Hello, I have been experiencing headaches for the past three days.",
        detected_language="en",
        confidence=0.92,
        timestamps=[
            TimestampSegment(start=0.0, end=2.5, text="Hello,"),
            TimestampSegment(
                start=2.5,
                end=6.0,
                text="I have been experiencing headaches for the past three days.",
            ),
        ],
    )


@pytest.fixture
def sample_hindi_transcription() -> TranscriptionResult:
    """A Hindi transcription result for testing translation."""
    return TranscriptionResult(
        transcript="मुझे तीन दिन से सिरदर्द हो रहा है।",
        detected_language="hi",
        confidence=0.88,
        timestamps=[
            TimestampSegment(
                start=0.0,
                end=4.0,
                text="मुझे तीन दिन से सिरदर्द हो रहा है।",
            ),
        ],
    )


@pytest.fixture
def sample_translation() -> TranslationResult:
    """A translation result."""
    return TranslationResult(
        source_language="hi",
        target_language="en",
        original_text="मुझे तीन दिन से सिरदर्द हो रहा है।",
        translated_text="I have been having headaches for three days.",
    )


@pytest.fixture
def sample_audio_metadata(tmp_path: Path) -> AudioMetadata:
    """Metadata for a normalized audio file."""
    return AudioMetadata(
        file_path=str(tmp_path / "test_normalized.wav"),
        duration_seconds=5.5,
        sample_rate=16000,
        channels=1,
        mime_type="audio/wav",
        file_size_bytes=176400,
    )


@pytest.fixture
def sample_synthesis() -> SynthesisResult:
    """A TTS synthesis result."""
    return SynthesisResult(
        file_path="/tmp/test_output.wav",
        format="wav",
        duration_seconds=3.2,
    )


# ── Mock Factories ──────────────────────────────────────────────────

@pytest.fixture
def mock_recognizer(sample_transcription: TranscriptionResult) -> MagicMock:
    """Mock SpeechRecognizer that returns a fixed transcription."""
    recognizer = MagicMock()
    recognizer.transcribe.return_value = sample_transcription
    return recognizer


@pytest.fixture
def mock_translator(sample_translation: TranslationResult) -> MagicMock:
    """Mock TextTranslator that returns a fixed translation."""
    translator = MagicMock()
    translator.translate.return_value = sample_translation
    translator.detect_language.return_value = "hi"
    return translator


@pytest.fixture
def mock_preprocessor(sample_audio_metadata: AudioMetadata) -> MagicMock:
    """Mock AudioPreprocessor that returns fixed metadata."""
    preprocessor = MagicMock()
    preprocessor.normalize.return_value = sample_audio_metadata
    preprocessor.get_duration.return_value = 5.5
    preprocessor.validate_mime_type.return_value = "audio/ogg"
    return preprocessor


@pytest.fixture
def mock_synthesizer(sample_synthesis: SynthesisResult) -> MagicMock:
    """Mock SpeechSynthesizer that returns a fixed synthesis result."""
    synthesizer = MagicMock()
    synthesizer.synthesize.return_value = sample_synthesis
    return synthesizer


@pytest.fixture
def mock_encoder(tmp_path: Path) -> MagicMock:
    """Mock AudioEncoder that creates a fake .ogg file."""
    encoder = MagicMock()
    ogg_path = str(tmp_path / "test_output.ogg")
    # Create a fake file so size checks pass
    Path(ogg_path).parent.mkdir(parents=True, exist_ok=True)
    Path(ogg_path).write_bytes(b"\x00" * 1024)
    encoder.encode_to_ogg_opus.return_value = ogg_path
    return encoder


# ── Temporary Audio Files ──────────────────────────────────────────

@pytest.fixture
def sample_wav_file(tmp_path: Path) -> str:
    """Create a minimal valid WAV file for testing."""
    wav_path = tmp_path / "test.wav"
    # Minimal WAV header (44 bytes) + 1 second of silence at 16kHz mono
    import struct

    sample_rate = 16000
    num_channels = 1
    bits_per_sample = 16
    num_samples = sample_rate  # 1 second
    data_size = num_samples * num_channels * (bits_per_sample // 8)
    file_size = 36 + data_size

    with open(wav_path, "wb") as f:
        # RIFF header
        f.write(b"RIFF")
        f.write(struct.pack("<I", file_size))
        f.write(b"WAVE")
        # fmt chunk
        f.write(b"fmt ")
        f.write(struct.pack("<I", 16))  # chunk size
        f.write(struct.pack("<H", 1))  # PCM format
        f.write(struct.pack("<H", num_channels))
        f.write(struct.pack("<I", sample_rate))
        f.write(struct.pack("<I", sample_rate * num_channels * bits_per_sample // 8))
        f.write(struct.pack("<H", num_channels * bits_per_sample // 8))
        f.write(struct.pack("<H", bits_per_sample))
        # data chunk
        f.write(b"data")
        f.write(struct.pack("<I", data_size))
        # Silence
        f.write(b"\x00" * data_size)

    return str(wav_path)
