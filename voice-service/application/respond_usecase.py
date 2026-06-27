"""
Respond Use Case — Orchestrates the text-to-speech pipeline.

Pipeline:
    1. Synthesize text → WAV via SpeechSynthesizer
    2. Encode WAV → OGG/Opus via AudioEncoder
    3. Clean up intermediate WAV file
    4. Return download URL for the .ogg file

All dependencies are injected — the use case owns no infrastructure.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path

from application.dto import RespondInput, RespondOutput
from core.config import VoiceServiceConfig
from core.logging import get_logger
from domain.contracts import AudioEncoder, SpeechSynthesizer

logger = get_logger(__name__)


class RespondUseCase:
    """Orchestrate the complete text-to-speech pipeline.

    Dependencies are injected via constructor — all interactions with
    infrastructure go through domain protocol contracts.
    """

    def __init__(
        self,
        synthesizer: SpeechSynthesizer,
        encoder: AudioEncoder,
        config: VoiceServiceConfig,
    ) -> None:
        self._synthesizer = synthesizer
        self._encoder = encoder
        self._config = config
        self._generated_dir = Path(config.generated_storage_path)
        self._generated_dir.mkdir(parents=True, exist_ok=True)
        self._base_url = config.base_url.rstrip("/")

    def execute(self, input_dto: RespondInput) -> RespondOutput:
        """Execute the full text-to-speech pipeline.

        Args:
            input_dto: Contains text, language, voice role.

        Returns:
            RespondOutput with voice_url and format.

        Raises:
            SynthesisError: If TTS fails.
            AudioProcessingError: If encoding fails.
        """
        start_time = time.monotonic()
        file_id = uuid.uuid4().hex[:16]

        logger.info(
            "respond_pipeline_started",
            stage="pipeline",
            text_length=len(input_dto.text),
            language=input_dto.language,
            voice=input_dto.voice,
        )

        # ── Step 1: Text-to-Speech → WAV ───────────────────────────
        synthesis = self._synthesizer.synthesize(
            text=input_dto.text,
            voice=input_dto.voice,
            language=input_dto.language,
        )

        # ── Step 2: Encode WAV → OGG/Opus ──────────────────────────
        ogg_path = str(self._generated_dir / f"{file_id}.ogg")
        encoded_path = self._encoder.encode_to_ogg_opus(
            wav_path=synthesis.file_path,
            output_path=ogg_path,
        )

        # ── Step 3: Clean up intermediate WAV ───────────────────────
        try:
            Path(synthesis.file_path).unlink(missing_ok=True)
        except OSError:
            pass

        # ── Step 4: Build download URL ──────────────────────────────
        filename = Path(encoded_path).name
        voice_url = f"{self._base_url}/storage/generated/{filename}"

        output = RespondOutput(
            voice_url=voice_url,
            format="ogg",
        )

        elapsed_ms = round((time.monotonic() - start_time) * 1000, 1)
        logger.info(
            "respond_pipeline_complete",
            stage="pipeline",
            duration_ms=elapsed_ms,
            voice_url=voice_url,
            ogg_size_bytes=Path(encoded_path).stat().st_size,
        )

        return output
