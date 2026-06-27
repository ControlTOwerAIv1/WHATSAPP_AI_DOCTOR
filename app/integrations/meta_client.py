"""
Meta WhatsApp Cloud API Client.

Handles all outbound communication with WhatsApp:
  - send_text_message(phone, text)
  - send_audio_message(phone, audio_url)
  - download_media(media_id) → bytes

All calls wrapped in try/except — failures never crash the caller.
"""

from __future__ import annotations

from typing import Optional

import httpx

from core.config import get_settings
from core.logging import get_logger

logger = get_logger(__name__)


class MetaWhatsAppClient:
    """Client for the Meta WhatsApp Cloud API (send + media download)."""

    def __init__(self) -> None:
        settings = get_settings()
        self._base_url = settings.whatsapp_api_base
        self._phone_number_id = settings.whatsapp_phone_number_id
        self._access_token = settings.whatsapp_access_token
        self._headers = {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
        }

    def _messages_url(self) -> str:
        return f"{self._base_url}/{self._phone_number_id}/messages"

    async def send_text_message(self, to_phone: str, text: str) -> Optional[str]:
        """Send a text message to a WhatsApp user.

        Args:
            to_phone: Recipient phone number (E.164, no +).
            text: Message text body.

        Returns:
            Meta message ID on success, None on failure.
        """
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_phone,
            "type": "text",
            "text": {"preview_url": False, "body": text},
        }

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    self._messages_url(),
                    headers=self._headers,
                    json=payload,
                )
                response.raise_for_status()

            data = response.json()
            message_id = data.get("messages", [{}])[0].get("id")

            logger.info(
                "whatsapp_text_sent",
                to_phone=to_phone,
                message_id=message_id,
                text_length=len(text),
            )
            return message_id

        except Exception as exc:
            logger.error(
                "whatsapp_send_failed",
                to_phone=to_phone,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            return None

    async def send_audio_message(
        self, to_phone: str, audio_url: str
    ) -> Optional[str]:
        """Send an audio message (voice note) to a WhatsApp user.

        Args:
            to_phone: Recipient phone number.
            audio_url: Public URL of the .ogg audio file.

        Returns:
            Meta message ID on success, None on failure.
        """
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_phone,
            "type": "audio",
            "audio": {"link": audio_url},
        }

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    self._messages_url(),
                    headers=self._headers,
                    json=payload,
                )
                response.raise_for_status()

            data = response.json()
            message_id = data.get("messages", [{}])[0].get("id")

            logger.info(
                "whatsapp_audio_sent",
                to_phone=to_phone,
                message_id=message_id,
                audio_url=audio_url,
            )
            return message_id

        except Exception as exc:
            logger.error(
                "whatsapp_audio_send_failed",
                to_phone=to_phone,
                error=str(exc),
            )
            return None

    async def download_media(self, media_id: str) -> Optional[bytes]:
        """Download a media file from WhatsApp.

        Two-step process:
        1. GET the media URL from Meta's API using the media_id
        2. GET the actual binary content from that URL

        Args:
            media_id: Meta's media identifier from the webhook payload.

        Returns:
            Raw bytes of the media file, or None on failure.
        """
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                # Step 1: Get the media URL
                url_response = await client.get(
                    f"{self._base_url}/{media_id}",
                    headers={"Authorization": f"Bearer {self._access_token}"},
                )
                url_response.raise_for_status()
                media_url = url_response.json().get("url")

                if not media_url:
                    logger.error("media_url_missing", media_id=media_id)
                    return None

                # Step 2: Download the actual file
                file_response = await client.get(
                    media_url,
                    headers={"Authorization": f"Bearer {self._access_token}"},
                )
                file_response.raise_for_status()

                logger.info(
                    "media_downloaded",
                    media_id=media_id,
                    size_bytes=len(file_response.content),
                )
                return file_response.content

        except Exception as exc:
            logger.error(
                "media_download_failed",
                media_id=media_id,
                error=str(exc),
            )
            return None
