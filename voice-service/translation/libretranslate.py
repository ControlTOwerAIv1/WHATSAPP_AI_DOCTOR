"""
LibreTranslate Adapter — HTTP client for self-hosted LibreTranslate.

Implements the TextTranslator protocol from domain.contracts.

Features:
  - Synchronous HTTP calls to LibreTranslate REST API
  - Configurable timeout per request
  - Circuit breaker: after N consecutive failures, skip translation
    for a cooldown period (prevents cascading timeouts)
  - Graceful degradation: translation failure never blocks transcript delivery

Circuit Breaker States:
  CLOSED   → normal operation, all calls go through
  OPEN     → skip all calls, return original text, auto-reset after cooldown
"""

from __future__ import annotations

import time

import httpx

from core.config import VoiceServiceConfig
from core.exceptions import TranslationError
from core.logging import get_logger
from domain.entities import TranslationResult

logger = get_logger(__name__)


class LibreTranslateAdapter:
    """Translation adapter for self-hosted LibreTranslate.

    Satisfies the TextTranslator protocol via structural subtyping.
    """

    def __init__(self, config: VoiceServiceConfig) -> None:
        self._base_url = config.libretranslate_url.rstrip("/")
        self._timeout = config.translation_timeout_seconds
        self._target_language = config.translation_target_language

        # Circuit breaker state
        self._failure_count = 0
        self._failure_threshold = config.translation_circuit_breaker_threshold
        self._reset_seconds = config.translation_circuit_breaker_reset_seconds
        self._circuit_opened_at: float | None = None

    def _is_circuit_open(self) -> bool:
        """Check if the circuit breaker is in OPEN state."""
        if self._circuit_opened_at is None:
            return False

        elapsed = time.monotonic() - self._circuit_opened_at
        if elapsed >= self._reset_seconds:
            # Auto-reset: try again
            logger.info(
                "circuit_breaker_reset",
                stage="translation",
                elapsed_seconds=round(elapsed, 1),
            )
            self._circuit_opened_at = None
            self._failure_count = 0
            return False

        return True

    def _record_failure(self) -> None:
        """Record a failure and potentially open the circuit."""
        self._failure_count += 1
        if self._failure_count >= self._failure_threshold:
            self._circuit_opened_at = time.monotonic()
            logger.warning(
                "circuit_breaker_opened",
                stage="translation",
                failure_count=self._failure_count,
                reset_after_seconds=self._reset_seconds,
            )

    def _record_success(self) -> None:
        """Record a success and reset the failure counter."""
        self._failure_count = 0
        self._circuit_opened_at = None

    def translate(
        self, text: str, source_lang: str, target_lang: str
    ) -> TranslationResult:
        """Translate text via LibreTranslate API.

        Args:
            text: Text to translate.
            source_lang: ISO 639-1 source language code.
            target_lang: ISO 639-1 target language code.

        Returns:
            TranslationResult with translated text.

        Raises:
            TranslationError: If translation fails and circuit breaker is closed.
        """
        if self._is_circuit_open():
            logger.warning(
                "translation_skipped_circuit_open",
                stage="translation",
                source_lang=source_lang,
                target_lang=target_lang,
            )
            raise TranslationError(
                "Translation service circuit breaker is open.",
                details={"circuit_state": "open"},
            )

        url = f"{self._base_url}/translate"
        payload = {
            "q": text,
            "source": source_lang,
            "target": target_lang,
            "format": "text",
        }

        logger.info(
            "translation_request",
            stage="translation",
            source_lang=source_lang,
            target_lang=target_lang,
            text_length=len(text),
        )

        try:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.post(url, json=payload)
                response.raise_for_status()

            data = response.json()
            translated_text = data.get("translatedText", "")

            if not translated_text:
                raise TranslationError(
                    "LibreTranslate returned empty translation.",
                    details={"response": data},
                )

            self._record_success()

            result = TranslationResult(
                source_language=source_lang,
                target_language=target_lang,
                original_text=text,
                translated_text=translated_text,
            )

            logger.info(
                "translation_complete",
                stage="translation",
                source_lang=source_lang,
                target_lang=target_lang,
                translated_length=len(translated_text),
            )

            return result

        except httpx.TimeoutException as exc:
            self._record_failure()
            raise TranslationError(
                f"LibreTranslate request timed out after {self._timeout}s.",
                details={"url": url, "timeout": self._timeout},
            ) from exc

        except httpx.HTTPStatusError as exc:
            self._record_failure()
            raise TranslationError(
                f"LibreTranslate returned HTTP {exc.response.status_code}.",
                details={
                    "status_code": exc.response.status_code,
                    "body": exc.response.text[:500],
                },
            ) from exc

        except httpx.HTTPError as exc:
            self._record_failure()
            raise TranslationError(
                f"LibreTranslate connection error: {exc}",
                details={"url": url},
            ) from exc

    def detect_language(self, text: str) -> str:
        """Detect language via LibreTranslate's /detect endpoint.

        Note: In the standard pipeline, language detection comes free from
        faster-whisper. This method is for standalone detection use cases.

        Args:
            text: Text to analyze.

        Returns:
            ISO 639-1 language code.

        Raises:
            TranslationError: If detection fails.
        """
        if self._is_circuit_open():
            raise TranslationError(
                "Translation service circuit breaker is open.",
                details={"circuit_state": "open"},
            )

        url = f"{self._base_url}/detect"
        payload = {"q": text}

        try:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.post(url, json=payload)
                response.raise_for_status()

            data = response.json()
            if not data or not isinstance(data, list):
                raise TranslationError(
                    "LibreTranslate /detect returned unexpected format.",
                    details={"response": data},
                )

            # Returns list of {language, confidence}, take the top one
            detected_lang = data[0].get("language", "unknown")
            self._record_success()

            logger.info(
                "language_detected",
                stage="translation",
                detected_language=detected_lang,
                confidence=data[0].get("confidence"),
            )

            return detected_lang

        except (httpx.HTTPError, httpx.TimeoutException) as exc:
            self._record_failure()
            raise TranslationError(
                f"Language detection failed: {exc}",
                details={"url": url},
            ) from exc

    def health_check(self) -> bool:
        """Check if LibreTranslate is reachable.

        Returns:
            True if the service responds to /languages.
        """
        url = f"{self._base_url}/languages"
        try:
            with httpx.Client(timeout=5) as client:
                response = client.get(url)
                return response.status_code == 200
        except httpx.HTTPError:
            return False
