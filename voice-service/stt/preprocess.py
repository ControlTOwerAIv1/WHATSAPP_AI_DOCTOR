"""
Audio Preprocessor — ffmpeg-based normalization for STT consumption.

Implements the AudioPreprocessor protocol from domain.contracts.

Converts any audio format to the standard STT input format:
  - Format: WAV
  - Channels: Mono (1)
  - Sample rate: 16000 Hz
  - Bit depth: 16-bit PCM (s16le)

All operations use ffmpeg/ffprobe as subprocesses with timeout protection.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from core.config import VoiceServiceConfig
from core.exceptions import AudioProcessingError, AudioValidationError
from core.logging import get_logger
from domain.entities import AudioMetadata

logger = get_logger(__name__)

# Target format constants
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
TARGET_FORMAT = "wav"
TARGET_CODEC = "pcm_s16le"


class FFmpegPreprocessor:
    """Audio preprocessor using ffmpeg for format normalization.

    Satisfies the AudioPreprocessor protocol via structural subtyping.
    """

    def __init__(self, config: VoiceServiceConfig) -> None:
        self._ffmpeg = config.ffmpeg_path
        self._ffprobe = config.ffprobe_path
        self._timeout = config.ffmpeg_timeout_seconds
        self._max_duration = config.max_audio_duration_seconds
        self._max_file_size_bytes = config.max_audio_file_size_mb * 1024 * 1024

    def normalize(self, input_path: str, output_path: str) -> AudioMetadata:
        """Normalize audio to WAV/mono/16kHz/16-bit PCM.

        Args:
            input_path: Path to the source audio file (any supported format).
            output_path: Path where the normalized WAV will be written.

        Returns:
            AudioMetadata describing the normalized output file.

        Raises:
            AudioValidationError: If audio exceeds duration or size limits.
            AudioProcessingError: If ffmpeg conversion fails.
        """
        input_path_obj = Path(input_path)
        if not input_path_obj.exists():
            raise AudioProcessingError(
                f"Input file not found: {input_path}",
                details={"input_path": input_path},
            )

        # Pre-flight validation on the source file
        file_size = input_path_obj.stat().st_size
        if file_size > self._max_file_size_bytes:
            raise AudioValidationError(
                f"Audio file size ({file_size} bytes) exceeds maximum "
                f"({self._max_file_size_bytes} bytes).",
                details={
                    "file_size_bytes": file_size,
                    "max_bytes": self._max_file_size_bytes,
                },
            )

        # Check duration before conversion (saves CPU)
        duration = self.get_duration(input_path)
        if duration > self._max_duration:
            raise AudioValidationError(
                f"Audio duration ({duration:.1f}s) exceeds maximum "
                f"({self._max_duration}s).",
                details={
                    "duration_seconds": duration,
                    "max_duration_seconds": self._max_duration,
                },
            )

        # Ensure output directory exists
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        # Run ffmpeg conversion
        cmd = [
            self._ffmpeg,
            "-y",                       # overwrite output
            "-i", input_path,           # input file
            "-ac", str(TARGET_CHANNELS),  # mono
            "-ar", str(TARGET_SAMPLE_RATE),  # 16kHz
            "-acodec", TARGET_CODEC,    # 16-bit PCM
            "-f", TARGET_FORMAT,        # WAV container
            "-loglevel", "error",       # suppress noise
            output_path,
        ]

        logger.info(
            "ffmpeg_normalization_started",
            stage="preprocess",
            input_path=input_path,
            output_path=output_path,
        )

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AudioProcessingError(
                f"ffmpeg timed out after {self._timeout}s.",
                details={"command": " ".join(cmd)},
            ) from exc

        if result.returncode != 0:
            raise AudioProcessingError(
                f"ffmpeg normalization failed: {result.stderr.strip()}",
                details={
                    "return_code": result.returncode,
                    "stderr": result.stderr.strip(),
                    "command": " ".join(cmd),
                },
            )

        # Validate output exists and is non-empty
        output_file = Path(output_path)
        if not output_file.exists() or output_file.stat().st_size == 0:
            raise AudioProcessingError(
                "ffmpeg produced an empty or missing output file.",
                details={"output_path": output_path},
            )

        # Get metadata of the normalized file
        normalized_duration = self.get_duration(output_path)
        output_size = output_file.stat().st_size

        metadata = AudioMetadata(
            file_path=output_path,
            duration_seconds=normalized_duration,
            sample_rate=TARGET_SAMPLE_RATE,
            channels=TARGET_CHANNELS,
            mime_type="audio/wav",
            file_size_bytes=output_size,
        )

        logger.info(
            "ffmpeg_normalization_complete",
            stage="preprocess",
            duration_seconds=normalized_duration,
            output_size_bytes=output_size,
        )

        return metadata

    def get_duration(self, file_path: str) -> float:
        """Get the duration of an audio file using ffprobe.

        Args:
            file_path: Path to the audio file.

        Returns:
            Duration in seconds.

        Raises:
            AudioProcessingError: If ffprobe fails.
        """
        cmd = [
            self._ffprobe,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            file_path,
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AudioProcessingError(
                f"ffprobe timed out after {self._timeout}s.",
                details={"file_path": file_path},
            ) from exc
        except FileNotFoundError as exc:
            raise AudioProcessingError(
                f"ffprobe not found at '{self._ffprobe}'. "
                "Ensure ffmpeg is installed.",
                details={"ffprobe_path": self._ffprobe},
            ) from exc

        if result.returncode != 0:
            raise AudioProcessingError(
                f"ffprobe failed: {result.stderr.strip()}",
                details={
                    "file_path": file_path,
                    "stderr": result.stderr.strip(),
                },
            )

        try:
            probe_data = json.loads(result.stdout)
            duration = float(probe_data["format"]["duration"])
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            raise AudioProcessingError(
                "Failed to parse ffprobe output.",
                details={
                    "file_path": file_path,
                    "stdout": result.stdout[:500],
                },
            ) from exc

        return duration

    def validate_mime_type(
        self, file_path: str, allowed_types: list[str]
    ) -> str:
        """Detect and validate MIME type of an audio file using ffprobe.

        Uses ffprobe's format detection instead of python-magic to avoid
        the libmagic dependency (problematic in Docker).

        Args:
            file_path: Path to the audio file.
            allowed_types: List of allowed MIME type strings.

        Returns:
            Detected MIME type string.

        Raises:
            AudioValidationError: If MIME type is not in allowed list.
            AudioProcessingError: If detection fails.
        """
        cmd = [
            self._ffprobe,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            file_path,
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
            raise AudioProcessingError(
                "ffprobe unavailable for MIME detection.",
                details={"file_path": file_path},
            ) from exc

        if result.returncode != 0:
            raise AudioValidationError(
                "File does not appear to be a valid audio file.",
                details={
                    "file_path": file_path,
                    "stderr": result.stderr.strip(),
                },
            )

        try:
            probe_data = json.loads(result.stdout)
            format_name = probe_data["format"].get("format_name", "")
        except (json.JSONDecodeError, KeyError):
            raise AudioValidationError(
                "Unable to determine audio format.",
                details={"file_path": file_path},
            )

        # Map ffprobe format names to MIME types
        format_to_mime: dict[str, str] = {
            "ogg": "audio/ogg",
            "mp3": "audio/mpeg",
            "wav": "audio/wav",
            "flac": "audio/flac",
            "mp4": "audio/mp4",
            "m4a": "audio/mp4",
            "webm": "audio/webm",
            "matroska,webm": "audio/webm",
        }

        # ffprobe may return comma-separated format names
        detected_mime = None
        for fmt in format_name.split(","):
            fmt = fmt.strip()
            if fmt in format_to_mime:
                detected_mime = format_to_mime[fmt]
                break

        if detected_mime is None:
            # Fall back to extension-based detection
            ext = Path(file_path).suffix.lower().lstrip(".")
            ext_to_mime: dict[str, str] = {
                "ogg": "audio/ogg",
                "opus": "audio/ogg",
                "mp3": "audio/mpeg",
                "wav": "audio/wav",
                "flac": "audio/flac",
                "m4a": "audio/mp4",
                "webm": "audio/webm",
            }
            detected_mime = ext_to_mime.get(ext, f"audio/{ext}")

        if detected_mime not in allowed_types:
            raise AudioValidationError(
                f"Unsupported audio format: {detected_mime}",
                details={
                    "detected_mime": detected_mime,
                    "format_name": format_name,
                    "allowed_types": allowed_types,
                },
            )

        return detected_mime
