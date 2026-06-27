"""
Unit Tests — Audio Preprocessor (ffmpeg) and OGG Encoder.

Tests FFmpegPreprocessor and OggOpusEncoder with mocked subprocess calls.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from core.config import VoiceServiceConfig
from core.exceptions import AudioProcessingError, AudioValidationError
from stt.preprocess import FFmpegPreprocessor
from tts.encoder import OggOpusEncoder


class TestFFmpegPreprocessor:
    """Tests for FFmpegPreprocessor."""

    def test_normalize_success(self, test_config: VoiceServiceConfig, tmp_path: Path):
        """Verify successful audio normalization."""
        preprocessor = FFmpegPreprocessor(test_config)

        # Create a fake input file
        input_path = tmp_path / "input.ogg"
        input_path.write_bytes(b"\x00" * 1024)

        output_path = str(tmp_path / "output.wav")

        # Mock ffprobe for duration check
        probe_result = MagicMock()
        probe_result.returncode = 0
        probe_result.stdout = json.dumps({"format": {"duration": "5.5"}})

        # Mock ffmpeg for conversion
        convert_result = MagicMock()
        convert_result.returncode = 0
        convert_result.stderr = ""

        with patch("stt.preprocess.subprocess.run") as mock_run:

            def side_effect(*args, **kwargs):
                cmd = args[0]
                if "ffprobe" in cmd[0]:
                    return probe_result
                else:
                    # Create output file to simulate ffmpeg
                    Path(output_path).write_bytes(b"\x00" * 176400)
                    return convert_result

            mock_run.side_effect = side_effect

            metadata = preprocessor.normalize(str(input_path), output_path)

        assert metadata.sample_rate == 16000
        assert metadata.channels == 1
        assert metadata.mime_type == "audio/wav"

    def test_normalize_exceeds_duration(
        self, test_config: VoiceServiceConfig, tmp_path: Path
    ):
        """Verify AudioValidationError when audio exceeds max duration."""
        preprocessor = FFmpegPreprocessor(test_config)

        input_path = tmp_path / "long_audio.ogg"
        input_path.write_bytes(b"\x00" * 1024)

        probe_result = MagicMock()
        probe_result.returncode = 0
        probe_result.stdout = json.dumps({"format": {"duration": "120.0"}})

        with patch("stt.preprocess.subprocess.run", return_value=probe_result):
            with pytest.raises(AudioValidationError, match="exceeds maximum"):
                preprocessor.normalize(str(input_path), str(tmp_path / "out.wav"))

    def test_normalize_exceeds_file_size(
        self, test_config: VoiceServiceConfig, tmp_path: Path
    ):
        """Verify AudioValidationError when file is too large."""
        config = test_config.model_copy(update={"max_audio_file_size_mb": 0})
        preprocessor = FFmpegPreprocessor(config)

        input_path = tmp_path / "big.ogg"
        input_path.write_bytes(b"\x00" * 1024)

        with pytest.raises(AudioValidationError, match="exceeds maximum"):
            preprocessor.normalize(str(input_path), str(tmp_path / "out.wav"))

    def test_normalize_input_not_found(self, test_config: VoiceServiceConfig):
        """Verify AudioProcessingError when input file doesn't exist."""
        preprocessor = FFmpegPreprocessor(test_config)

        with pytest.raises(AudioProcessingError, match="not found"):
            preprocessor.normalize("/nonexistent/file.ogg", "/tmp/out.wav")

    def test_normalize_ffmpeg_timeout(
        self, test_config: VoiceServiceConfig, tmp_path: Path
    ):
        """Verify AudioProcessingError on ffmpeg timeout."""
        import subprocess

        preprocessor = FFmpegPreprocessor(test_config)

        input_path = tmp_path / "timeout.ogg"
        input_path.write_bytes(b"\x00" * 1024)

        # First call (ffprobe) succeeds, second call (ffmpeg) times out
        probe_result = MagicMock()
        probe_result.returncode = 0
        probe_result.stdout = json.dumps({"format": {"duration": "5.0"}})

        def side_effect(*args, **kwargs):
            cmd = args[0]
            if "ffprobe" in cmd[0]:
                return probe_result
            raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=30)

        with patch("stt.preprocess.subprocess.run", side_effect=side_effect):
            with pytest.raises(AudioProcessingError, match="timed out"):
                preprocessor.normalize(
                    str(input_path), str(tmp_path / "out.wav")
                )

    def test_get_duration(self, test_config: VoiceServiceConfig):
        """Verify duration extraction from ffprobe output."""
        preprocessor = FFmpegPreprocessor(test_config)

        probe_result = MagicMock()
        probe_result.returncode = 0
        probe_result.stdout = json.dumps({"format": {"duration": "12.345"}})

        with patch("stt.preprocess.subprocess.run", return_value=probe_result):
            duration = preprocessor.get_duration("/some/file.wav")

        assert duration == 12.345


class TestOggOpusEncoder:
    """Tests for OggOpusEncoder."""

    def test_encode_success(self, test_config: VoiceServiceConfig, tmp_path: Path):
        """Verify successful WAV to OGG encoding."""
        encoder = OggOpusEncoder(test_config)

        wav_path = tmp_path / "input.wav"
        wav_path.write_bytes(b"\x00" * 48000)

        output_path = str(tmp_path / "output.ogg")

        encode_result = MagicMock()
        encode_result.returncode = 0
        encode_result.stderr = ""

        with patch("tts.encoder.subprocess.run") as mock_run:

            def side_effect(*args, **kwargs):
                Path(output_path).write_bytes(b"\x00" * 4096)
                return encode_result

            mock_run.side_effect = side_effect

            result = encoder.encode_to_ogg_opus(str(wav_path), output_path)

        assert result.endswith(".ogg")
        assert Path(result).exists()

    def test_encode_input_not_found(self, test_config: VoiceServiceConfig):
        """Verify AudioProcessingError when WAV source doesn't exist."""
        encoder = OggOpusEncoder(test_config)

        with pytest.raises(AudioProcessingError, match="not found"):
            encoder.encode_to_ogg_opus("/nonexistent.wav", "/tmp/out.ogg")

    def test_encode_ffmpeg_failure(
        self, test_config: VoiceServiceConfig, tmp_path: Path
    ):
        """Verify AudioProcessingError on ffmpeg encoding failure."""
        encoder = OggOpusEncoder(test_config)

        wav_path = tmp_path / "input.wav"
        wav_path.write_bytes(b"\x00" * 48000)

        encode_result = MagicMock()
        encode_result.returncode = 1
        encode_result.stderr = "Encoder error: invalid codec"

        with patch("tts.encoder.subprocess.run", return_value=encode_result):
            with pytest.raises(AudioProcessingError, match="encoding failed"):
                encoder.encode_to_ogg_opus(
                    str(wav_path), str(tmp_path / "output.ogg")
                )
