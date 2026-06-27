"""
Voice Service Client — HTTP client calling the existing voice-service microservice.

The voice-service runs as a separate container on port 8000 and provides:
  - POST /api/v1/voice/transcribe  (STT)
  - POST /api/v1/voice/respond     (TTS)

This client wraps those calls for use by the core backend.
"""

from __future__ import annotations

from typing import Optional

import httpx

from core.config import get_settings
from core.logging import get_logger

logger = get_logger(__name__)


class VoiceServiceClient:
    """HTTP client for the voice processing microservice."""

    def __init__(self) -> None:
        settings = get_settings()
        self._base_url = settings.voice_service_url.rstrip("/")

    async def transcribe(
        self,
        audio_url: str,
        patient_id: str,
        session_id: str,
    ) -> Optional[dict]:
        """Call the voice-service STT endpoint.

        Args:
            audio_url: URL of the audio file to transcribe.
            patient_id: Patient identifier.
            session_id: Session identifier.

        Returns:
            Dict with {transcript, detected_language, translated_text,
            timestamps, confidence} on success, None on failure.
        """
        payload = {
            "audio_url": audio_url,
            "patient_id": patient_id,
            "session_id": session_id,
        }

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(
                    f"{self._base_url}/api/v1/voice/transcribe",
                    json=payload,
                )
                response.raise_for_status()

            result = response.json()
            logger.info(
                "voice_stt_complete",
                patient_id=patient_id,
                language=result.get("detected_language"),
                confidence=result.get("confidence"),
            )
            return result

        except Exception as exc:
            logger.error(
                "voice_stt_failed",
                patient_id=patient_id,
                error=str(exc),
            )
            return None

    async def synthesize(
        self,
        text: str,
        language: str = "en",
        voice: str = "doctor",
    ) -> Optional[str]:
        """Call the voice-service TTS endpoint.

        Args:
            text: Text to convert to speech.
            language: ISO 639-1 language code.
            voice: Voice role identifier.

        Returns:
            URL of the generated .ogg audio file, or None on failure.
        """
        payload = {
            "text": text,
            "language": language,
            "voice": voice,
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    f"{self._base_url}/api/v1/voice/respond",
                    json=payload,
                )
                response.raise_for_status()

            result = response.json()
            voice_url = result.get("voice_url")
            logger.info("voice_tts_complete", voice_url=voice_url)
            return voice_url

        except Exception as exc:
            logger.error("voice_tts_failed", error=str(exc))
            return None
