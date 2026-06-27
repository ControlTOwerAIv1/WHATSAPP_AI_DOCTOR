"""
Edge TTS Provider — Free TTS adapter using Microsoft Edge's online TTS.

Implements the SpeechSynthesizer protocol from domain.contracts.
No API key required — uses the edge-tts Python package which accesses
Microsoft Edge's free text-to-speech service.

Voice mapping:
    "doctor"  → "en-US-GuyNeural"   (deep, professional)
    "patient" → "en-US-JennyNeural" (warm, friendly)
    "system"  → "en-US-AriaNeural"  (neutral)

The existing OpenAITTSProvider remains in the codebase — this adapter
replaces it as the default via the VOICE_TTS_PROVIDER env var.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from core.config import VoiceServiceConfig
from core.exceptions import SynthesisError
from core.logging import get_logger
from domain.entities import SynthesisResult

logger = get_logger(__name__)


class EdgeTTSProvider:
    """Text-to-speech provider using Microsoft Edge TTS (free).

    Satisfies the SpeechSynthesizer protocol via structural subtyping.
    """

    def __init__(self, config: VoiceServiceConfig) -> None:
        self._voice_mapping = self._parse_voice_mapping(
            config.edge_tts_voice_mapping
        )
        self._default_voice = "en-US-GuyNeural"
        self._generated_dir = Path(config.generated_storage_path)
        self._generated_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _parse_voice_mapping(mapping_str: str) -> dict[str, str]:
        """Parse voice mapping string into a dict."""
        result = {}
        for pair in mapping_str.split(","):
            pair = pair.strip()
            if ":" in pair:
                role, voice = pair.split(":", 1)
                result[role.strip()] = voice.strip()
        return result

    def _resolve_voice(self, voice_role: str) -> str:
        """Map a voice role to an Edge TTS voice name."""
        resolved = self._voice_mapping.get(voice_role, self._default_voice)
        logger.debug(
            "edge_voice_resolved",
            stage="tts",
            voice_role=voice_role,
            edge_voice=resolved,
        )
        return resolved

    def synthesize(
        self, text: str, voice: str, language: str
    ) -> SynthesisResult:
        """Convert text to speech via Edge TTS.

        Generates a WAV file (later encoded to OGG/Opus by the encoder).

        Args:
            text: The text to synthesize.
            voice: Voice role identifier (e.g., "doctor").
            language: ISO 639-1 language code (informational).

        Returns:
            SynthesisResult with path to generated audio file.

        Raises:
            SynthesisError: If synthesis fails.
        """
        edge_voice = self._resolve_voice(voice)
        file_id = uuid.uuid4().hex[:16]

        # edge-tts outputs MP3 by default — we'll save as MP3 then
        # the downstream OggOpusEncoder can handle it (ffmpeg reads MP3)
        output_path = self._generated_dir / f"{file_id}_raw.mp3"

        logger.info(
            "edge_tts_synthesis_started",
            stage="tts",
            text_length=len(text),
            voice_role=voice,
            edge_voice=edge_voice,
            language=language,
        )

        try:
            # edge-tts is async, so we need to run it in an event loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(
                    self._synthesize_async(text, edge_voice, str(output_path))
                )
            finally:
                loop.close()

        except Exception as exc:
            raise SynthesisError(
                f"Edge TTS synthesis failed: {exc}",
                details={
                    "voice": edge_voice,
                    "text_length": len(text),
                },
            ) from exc

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise SynthesisError(
                "Edge TTS produced an empty output file.",
                details={"output_path": str(output_path)},
            )

        # Approximate duration from MP3 file size
        # MP3 at ~48kbps ≈ 6000 bytes/sec
        file_size = output_path.stat().st_size
        approx_duration = file_size / 6000.0

        result = SynthesisResult(
            file_path=str(output_path),
            format="mp3",
            duration_seconds=round(approx_duration, 2),
        )

        logger.info(
            "edge_tts_synthesis_complete",
            stage="tts",
            output_path=str(output_path),
            file_size_bytes=file_size,
            approx_duration=result.duration_seconds,
        )

        return result

    @staticmethod
    async def _synthesize_async(
        text: str, voice: str, output_path: str
    ) -> None:
        """Run edge-tts synthesis asynchronously."""
        import edge_tts

        communicate = edge_tts.Communicate(text=text, voice=voice)
        await communicate.save(output_path)
