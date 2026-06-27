"""
Audio Encoder — WAV to OGG/Opus encoding via ffmpeg.

Implements the AudioEncoder protocol from domain.contracts.

Output format:
  - Container: OGG
  - Codec: Opus
  - Bitrate: 48kbps (optimized for voice, matches WhatsApp voice notes)
  - Channels: Mono
  - Sample rate: 48kHz (Opus native, downsampled from input)
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from core.config import VoiceServiceConfig
from core.exceptions import AudioProcessingError
from core.logging import get_logger

logger = get_logger(__name__)

# Opus encoding constants
OPUS_BITRATE = "48k"
OPUS_SAMPLE_RATE = "48000"
OPUS_CHANNELS = "1"
OPUS_APPLICATION = "voip"  # Optimized for speech


class OggOpusEncoder:
    """Audio encoder converting WAV to OGG/Opus.

    Satisfies the AudioEncoder protocol via structural subtyping.
    """

    def __init__(self, config: VoiceServiceConfig) -> None:
        self._ffmpeg = config.ffmpeg_path
        self._timeout = config.ffmpeg_timeout_seconds

    def encode_to_ogg_opus(self, wav_path: str, output_path: str) -> str:
        """Encode a WAV file to OGG container with Opus codec.

        Args:
            wav_path: Path to the source WAV file.
            output_path: Path for the output .ogg file.

        Returns:
            Absolute path to the encoded .ogg file.

        Raises:
            AudioProcessingError: If encoding fails.
        """
        if not Path(wav_path).exists():
            raise AudioProcessingError(
                f"WAV source file not found: {wav_path}",
                details={"wav_path": wav_path},
            )

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        cmd = [
            self._ffmpeg,
            "-y",                          # overwrite output
            "-i", wav_path,                # input WAV
            "-c:a", "libopus",            # Opus codec
            "-b:a", OPUS_BITRATE,         # 48kbps for voice
            "-ar", OPUS_SAMPLE_RATE,       # 48kHz (Opus native)
            "-ac", OPUS_CHANNELS,          # mono
            "-application", OPUS_APPLICATION,  # voip mode
            "-vbr", "on",                  # variable bitrate
            "-compression_level", "10",    # max compression
            "-f", "ogg",                   # OGG container
            "-loglevel", "error",
            output_path,
        ]

        logger.info(
            "ogg_encoding_started",
            stage="encode",
            input_path=wav_path,
            output_path=output_path,
            bitrate=OPUS_BITRATE,
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
                f"OGG encoding timed out after {self._timeout}s.",
                details={"command": " ".join(cmd)},
            ) from exc

        if result.returncode != 0:
            raise AudioProcessingError(
                f"OGG encoding failed: {result.stderr.strip()}",
                details={
                    "return_code": result.returncode,
                    "stderr": result.stderr.strip(),
                },
            )

        output_file = Path(output_path)
        if not output_file.exists() or output_file.stat().st_size == 0:
            raise AudioProcessingError(
                "OGG encoder produced an empty or missing output file.",
                details={"output_path": output_path},
            )

        output_size = output_file.stat().st_size

        logger.info(
            "ogg_encoding_complete",
            stage="encode",
            output_path=output_path,
            output_size_bytes=output_size,
        )

        return str(output_file.resolve())
