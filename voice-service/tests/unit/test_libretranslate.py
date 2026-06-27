"""
Unit Tests — LibreTranslate Adapter.

Tests the LibreTranslateAdapter in isolation using mocked HTTP calls.
Verifies:
  - Successful translation
  - Timeout handling
  - Circuit breaker behavior
  - Graceful degradation
  - Language detection
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

from core.config import VoiceServiceConfig
from core.exceptions import TranslationError
from domain.entities import TranslationResult
from translation.libretranslate import LibreTranslateAdapter


class TestLibreTranslateAdapter:
    """Tests for LibreTranslateAdapter."""

    def test_translate_success(self, test_config: VoiceServiceConfig):
        """Verify successful translation."""
        adapter = LibreTranslateAdapter(test_config)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "translatedText": "I have headaches."
        }
        mock_response.raise_for_status = MagicMock()

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.post.return_value = mock_response
            mock_client_cls.return_value = mock_client

            result = adapter.translate("सिरदर्द है", "hi", "en")

        assert isinstance(result, TranslationResult)
        assert result.translated_text == "I have headaches."
        assert result.source_language == "hi"
        assert result.target_language == "en"

    def test_translate_timeout(self, test_config: VoiceServiceConfig):
        """Verify TranslationError on timeout."""
        adapter = LibreTranslateAdapter(test_config)

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.post.side_effect = httpx.TimeoutException("timeout")
            mock_client_cls.return_value = mock_client

            with pytest.raises(TranslationError, match="timed out"):
                adapter.translate("test", "hi", "en")

    def test_circuit_breaker_opens_after_threshold(
        self, test_config: VoiceServiceConfig
    ):
        """Verify circuit opens after consecutive failures."""
        test_config_mod = test_config.model_copy(
            update={"translation_circuit_breaker_threshold": 2}
        )
        adapter = LibreTranslateAdapter(test_config_mod)

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.post.side_effect = httpx.TimeoutException("timeout")
            mock_client_cls.return_value = mock_client

            # First failure
            with pytest.raises(TranslationError):
                adapter.translate("test", "hi", "en")

            # Second failure — circuit opens
            with pytest.raises(TranslationError):
                adapter.translate("test", "hi", "en")

        # Third call — circuit is open, skips HTTP entirely
        with pytest.raises(TranslationError, match="circuit breaker"):
            adapter.translate("test", "hi", "en")

    def test_circuit_breaker_resets_after_cooldown(
        self, test_config: VoiceServiceConfig
    ):
        """Verify circuit resets after cooldown period."""
        test_config_mod = test_config.model_copy(
            update={
                "translation_circuit_breaker_threshold": 1,
                "translation_circuit_breaker_reset_seconds": 0,  # immediate reset
            }
        )
        adapter = LibreTranslateAdapter(test_config_mod)

        # Open the circuit
        adapter._failure_count = 1
        adapter._circuit_opened_at = time.monotonic() - 1  # 1 second ago

        # Circuit should have reset
        assert not adapter._is_circuit_open()

    def test_success_resets_failure_count(self, test_config: VoiceServiceConfig):
        """Verify successful call resets the failure counter."""
        adapter = LibreTranslateAdapter(test_config)
        adapter._failure_count = 2  # Near threshold

        mock_response = MagicMock()
        mock_response.json.return_value = {"translatedText": "test"}
        mock_response.raise_for_status = MagicMock()

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.post.return_value = mock_response
            mock_client_cls.return_value = mock_client

            adapter.translate("test", "hi", "en")

        assert adapter._failure_count == 0

    def test_detect_language(self, test_config: VoiceServiceConfig):
        """Verify language detection."""
        adapter = LibreTranslateAdapter(test_config)

        mock_response = MagicMock()
        mock_response.json.return_value = [
            {"language": "hi", "confidence": 0.95}
        ]
        mock_response.raise_for_status = MagicMock()

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.post.return_value = mock_response
            mock_client_cls.return_value = mock_client

            result = adapter.detect_language("सिरदर्द")

        assert result == "hi"

    def test_health_check_healthy(self, test_config: VoiceServiceConfig):
        """Verify health check returns True when service is up."""
        adapter = LibreTranslateAdapter(test_config)

        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.get.return_value = mock_response
            mock_client_cls.return_value = mock_client

            assert adapter.health_check() is True

    def test_health_check_unhealthy(self, test_config: VoiceServiceConfig):
        """Verify health check returns False when service is down."""
        adapter = LibreTranslateAdapter(test_config)

        with patch("translation.libretranslate.httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=False)
            mock_client.get.side_effect = httpx.ConnectError("refused")
            mock_client_cls.return_value = mock_client

            assert adapter.health_check() is False
