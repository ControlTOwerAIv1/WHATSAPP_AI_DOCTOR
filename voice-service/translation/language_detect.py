"""
Language Detection — Utility wrapping faster-whisper's built-in detection.

faster-whisper already detects language during transcription (via info.language).
This module provides a standalone detection function for cases where language
detection is needed BEFORE transcription (e.g., to choose a model variant).

For the standard pipeline, the WhisperEngine's transcribe() output already
includes detected_language — no separate call is needed.
"""

from __future__ import annotations

from core.logging import get_logger

logger = get_logger(__name__)


def is_translation_needed(
    detected_language: str,
    target_language: str,
) -> bool:
    """Determine if translation is required.

    Args:
        detected_language: ISO 639-1 code from STT output (e.g., "hi").
        target_language: Desired output language (e.g., "en").

    Returns:
        True if translation is needed (languages differ).
    """
    source = detected_language.lower().strip()
    target = target_language.lower().strip()

    if source == target:
        logger.debug(
            "translation_skipped",
            stage="translation",
            reason="source_equals_target",
            detected_language=source,
        )
        return False

    if source == "unknown":
        logger.warning(
            "translation_skipped",
            stage="translation",
            reason="unknown_source_language",
        )
        return False

    return True
