"""
Transcribe Use Case — Orchestrates the full audio-to-transcript pipeline.

Pipeline:
    1. Download audio from URL (async, timeout-protected)
    2. Validate: MIME type, duration ≤60s, file size ≤25MB
    3. Normalize via ffmpeg → WAV/mono/16kHz
    4. STT via SpeechRecognizer.transcribe()
    5. Language detection (from STT output)
    6. Conditional translation if detected_language ≠ target_language
    7. Return TranscribeOutput

All dependencies are injected — the use case owns no infrastructure.
"""

from __future__ import annotations

import hashlib
import os
import time
import uuid
from pathlib import Path

import httpx

from application.dto import TranscribeInput, TranscribeOutput
from core.config import VoiceServiceConfig
from core.exceptions import (
    AudioDownloadError,
    AudioValidationError,
    TranslationError,
)
from core.logging import bind_context, get_logger
from domain.contracts import AudioPreprocessor, SpeechRecognizer, TextTranslator
from translation.language_detect import is_translation_needed

logger = get_logger(__name__)


class TranscribeUseCase:
    """Orchestrate the complete audio transcription pipeline.

    Dependencies are injected via constructor — all interactions with
    infrastructure go through domain protocol contracts.
    """

    def __init__(
        self,
        recognizer: SpeechRecognizer,
        translator: TextTranslator,
        preprocessor: AudioPreprocessor,
        config: VoiceServiceConfig,
    ) -> None:
        self._recognizer = recognizer
        self._translator = translator
        self._preprocessor = preprocessor
        self._config = config
        self._audio_dir = Path(config.audio_storage_path)
        self._audio_dir.mkdir(parents=True, exist_ok=True)

    def execute(self, input_dto: TranscribeInput) -> TranscribeOutput:
        """Execute the full transcription pipeline.

        Args:
            input_dto: Contains audio_url, patient_id, session_id.

        Returns:
            TranscribeOutput with transcript, language, translation, timestamps.

        Raises:
            AudioDownloadError: If download fails or times out.
            AudioValidationError: If audio fails validation.
            TranscriptionError: If STT engine fails.
        """
        request_id = uuid.uuid4().hex[:12]
        bind_context(
            request_id=request_id,
            patient_id=input_dto.patient_id,
            session_id=input_dto.session_id,
        )

        start_time = time.monotonic()
        logger.info("transcribe_pipeline_started", stage="pipeline")

        # ── Step 1: Download audio ──────────────────────────────────
        raw_path = self._download_audio(input_dto.audio_url, request_id)

        # ── Step 2: Validate MIME type ──────────────────────────────
        allowed_types = self._config.get_allowed_mime_types()
        self._preprocessor.validate_mime_type(raw_path, allowed_types)

        # ── Step 3: Normalize to WAV/mono/16kHz ─────────────────────
        normalized_path = str(self._audio_dir / f"{request_id}_normalized.wav")
        metadata = self._preprocessor.normalize(raw_path, normalized_path)

        logger.info(
            "audio_normalized",
            stage="preprocess",
            duration_seconds=metadata.duration_seconds,
            file_size_bytes=metadata.file_size_bytes,
        )

        # ── Step 4: Speech-to-Text ──────────────────────────────────
        transcription = self._recognizer.transcribe(normalized_path)

        # ── Step 5-6: Conditional Translation ───────────────────────
        translated_text: str | None = None
        target_lang = self._config.translation_target_language

        if (
            self._config.translation_enabled
            and is_translation_needed(transcription.detected_language, target_lang)
        ):
            try:
                translation = self._translator.translate(
                    text=transcription.transcript,
                    source_lang=transcription.detected_language,
                    target_lang=target_lang,
                )
                translated_text = translation.translated_text
            except TranslationError as exc:
                # Graceful degradation: log and continue without translation
                logger.warning(
                    "translation_failed_graceful",
                    stage="translation",
                    error=str(exc),
                )
                translated_text = None

        # ── Step 7: Build output ────────────────────────────────────
        timestamps = [
            {
                "start": ts.start,
                "end": ts.end,
                "text": ts.text,
            }
            for ts in transcription.timestamps
        ]

        output = TranscribeOutput(
            transcript=transcription.transcript,
            detected_language=transcription.detected_language,
            translated_text=translated_text,
            timestamps=timestamps,
            confidence=transcription.confidence,
        )

        # ── Cleanup temporary files ─────────────────────────────────
        self._cleanup(raw_path, normalized_path)

        elapsed_ms = round((time.monotonic() - start_time) * 1000, 1)
        logger.info(
            "transcribe_pipeline_complete",
            stage="pipeline",
            duration_ms=elapsed_ms,
            detected_language=transcription.detected_language,
            confidence=transcription.confidence,
            translated=translated_text is not None,
        )

        return output

    def _download_audio(self, audio_url: str, request_id: str) -> str:
        """Download audio from URL with timeout and size protection.

        Args:
            audio_url: URL to download from.
            request_id: Unique request identifier for filename.

        Returns:
            Path to the downloaded file.

        Raises:
            AudioDownloadError: If download fails.
        """
        timeout = self._config.audio_download_timeout_seconds
        max_bytes = self._config.max_audio_file_size_mb * 1024 * 1024

        logger.info(
            "audio_download_started",
            stage="download",
            audio_url=audio_url,
            timeout=timeout,
        )

        try:
            with httpx.Client(
                timeout=httpx.Timeout(timeout, connect=10.0),
                follow_redirects=True,
            ) as client:
                with client.stream("GET", audio_url) as response:
                    response.raise_for_status()

                    # Check Content-Length header for early rejection
                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > max_bytes:
                        raise AudioValidationError(
                            f"Audio file too large: {content_length} bytes "
                            f"(max {max_bytes} bytes).",
                            details={
                                "content_length": int(content_length),
                                "max_bytes": max_bytes,
                            },
                        )

                    # Determine file extension from Content-Type or URL
                    content_type = response.headers.get("content-type", "")
                    ext = self._guess_extension(content_type, audio_url)

                    output_path = str(self._audio_dir / f"{request_id}_raw{ext}")
                    downloaded_bytes = 0
                    hasher = hashlib.sha256()

                    with open(output_path, "wb") as f:
                        for chunk in response.iter_bytes(chunk_size=8192):
                            downloaded_bytes += len(chunk)
                            if downloaded_bytes > max_bytes:
                                # Clean up partial download
                                f.close()
                                Path(output_path).unlink(missing_ok=True)
                                raise AudioValidationError(
                                    f"Audio download exceeded max size "
                                    f"({max_bytes} bytes) during streaming.",
                                    details={
                                        "downloaded_bytes": downloaded_bytes,
                                        "max_bytes": max_bytes,
                                    },
                                )
                            hasher.update(chunk)
                            f.write(chunk)

            logger.info(
                "audio_download_complete",
                stage="download",
                file_path=output_path,
                size_bytes=downloaded_bytes,
                checksum_sha256=hasher.hexdigest(),
            )

            return output_path

        except httpx.TimeoutException as exc:
            raise AudioDownloadError(
                f"Audio download timed out after {timeout}s.",
                details={"audio_url": audio_url, "timeout": timeout},
            ) from exc

        except httpx.HTTPStatusError as exc:
            raise AudioDownloadError(
                f"Audio download failed: HTTP {exc.response.status_code}.",
                details={
                    "audio_url": audio_url,
                    "status_code": exc.response.status_code,
                },
            ) from exc

        except httpx.HTTPError as exc:
            raise AudioDownloadError(
                f"Audio download connection error: {exc}",
                details={"audio_url": audio_url},
            ) from exc

    @staticmethod
    def _guess_extension(content_type: str, url: str) -> str:
        """Guess file extension from Content-Type header or URL."""
        mime_to_ext: dict[str, str] = {
            "audio/ogg": ".ogg",
            "audio/mpeg": ".mp3",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/flac": ".flac",
            "audio/mp4": ".m4a",
            "audio/webm": ".webm",
            "video/ogg": ".ogg",
            "application/ogg": ".ogg",
        }

        for mime, ext in mime_to_ext.items():
            if mime in content_type:
                return ext

        # Fallback: extract from URL path
        url_path = url.split("?")[0]
        if "." in url_path.split("/")[-1]:
            return "." + url_path.split(".")[-1].lower()

        return ".audio"

    @staticmethod
    def _cleanup(*paths: str) -> None:
        """Remove temporary files, ignoring errors."""
        for path in paths:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass
