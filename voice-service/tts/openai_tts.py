"""
OpenAI TTS Provider — Adapter implementing SpeechSynthesizer via OpenAI API.

Uses the OpenAI tts-1 model for real-time text-to-speech.
The caller (RespondUseCase) has ZERO knowledge this is OpenAI —
it only sees SpeechSynthesizer.synthesize().

Voice mapping:
    "doctor"  → "onyx"   (deep, authoritative)
    "patient" → "nova"   (warm, friendly)
    "system"  → "alloy"  (neutral)

Future providers (ElevenLabs, Azure TTS) will implement the same
SpeechSynthesizer protocol and be swapped via config.
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

from openai import OpenAI, OpenAIError

from core.config import VoiceServiceConfig
from core.exceptions import SynthesisError
from core.logging import get_logger
from domain.entities import SynthesisResult

logger = get_logger(__name__)


class OpenAITTSProvider:
    """Text-to-speech provider using OpenAI's tts-1 API.

    Satisfies the SpeechSynthesizer protocol via structural subtyping.
    """

    def __init__(self, config: VoiceServiceConfig) -> None:
        if not config.openai_api_key:
            raise SynthesisError(
                "OpenAI API key is required for TTS. "
                "Set VOICE_OPENAI_API_KEY in your environment.",
            )

        self._client = OpenAI(api_key=config.openai_api_key)
        self._model = config.tts_model
        self._voice_mapping = config.get_voice_mapping()
        self._default_voice = config.tts_default_voice
        self._generated_dir = Path(config.generated_storage_path)

    def _resolve_voice(self, voice_role: str) -> str:
        """Map a voice role (e.g., 'doctor') to an OpenAI voice ID.

        Args:
            voice_role: Role identifier from the API request.

        Returns:
            OpenAI voice ID (e.g., 'onyx').
        """
        resolved = self._voice_mapping.get(voice_role, self._default_voice)
        logger.debug(
            "voice_resolved",
            stage="tts",
            voice_role=voice_role,
            openai_voice=resolved,
        )
        return resolved

    def synthesize(
        self, text: str, voice: str, language: str
    ) -> SynthesisResult:
        """Convert text to speech via OpenAI TTS API.

        Generates a WAV file (later encoded to OGG/Opus by the encoder).

        Args:
            text: The text to synthesize.
            voice: Voice role identifier (e.g., "doctor").
            language: ISO 639-1 language code (used as context, not
                      directly passed to OpenAI which auto-detects).

        Returns:
            SynthesisResult with path to generated WAV file.

        Raises:
            SynthesisError: If the API call fails.
        """
        openai_voice = self._resolve_voice(voice)
        file_id = uuid.uuid4().hex[:16]

        # Generate into a temp file first, then move to generated dir
        self._generated_dir.mkdir(parents=True, exist_ok=True)
        # OpenAI returns various formats; request WAV for clean encoding later
        output_path = self._generated_dir / f"{file_id}_raw.wav"

        logger.info(
            "tts_synthesis_started",
            stage="tts",
            text_length=len(text),
            voice_role=voice,
            openai_voice=openai_voice,
            model=self._model,
            language=language,
        )

        try:
            response = self._client.audio.speech.create(
                model=self._model,
                voice=openai_voice,
                input=text,
                response_format="wav",
            )

            # Stream response content to file
            response.stream_to_file(str(output_path))

        except OpenAIError as exc:
            raise SynthesisError(
                f"OpenAI TTS API error: {exc}",
                details={
                    "model": self._model,
                    "voice": openai_voice,
                    "text_length": len(text),
                },
            ) from exc
        except Exception as exc:
            raise SynthesisError(
                f"Unexpected TTS error: {exc}",
                details={"text_length": len(text)},
            ) from exc

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise SynthesisError(
                "TTS produced an empty output file.",
                details={"output_path": str(output_path)},
            )

        # Approximate duration from file size
        # WAV at 24kHz, 16-bit, mono ≈ 48000 bytes/sec
        file_size = output_path.stat().st_size
        approx_duration = file_size / 48000.0

        result = SynthesisResult(
            file_path=str(output_path),
            format="wav",
            duration_seconds=round(approx_duration, 2),
        )

        logger.info(
            "tts_synthesis_complete",
            stage="tts",
            output_path=str(output_path),
            file_size_bytes=file_size,
            approx_duration=result.duration_seconds,
        )

        return result
