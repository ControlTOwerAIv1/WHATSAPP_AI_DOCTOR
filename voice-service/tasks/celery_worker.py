"""
Celery Worker — Task definitions for async voice processing.

Provides two registered tasks:
  - transcribe_audio_task: Full STT pipeline (download → normalize → transcribe → translate)
  - synthesize_voice_task: Full TTS pipeline (synthesize → encode → store)

These tasks mirror the use case pipelines but run asynchronously via Celery.
External systems can choose between:
  - Synchronous: Call the HTTP API directly (blocks until complete)
  - Asynchronous: Submit a Celery task and poll for result

Both paths use the same use case classes for consistency.
"""

from __future__ import annotations

from celery import Celery

from core.config import get_settings
from tasks.retry_policy import DEFAULT_RETRY_POLICY

settings = get_settings()

# ── Celery App Initialization ──────────────────────────────────────────

celery_app = Celery(
    "voice_service",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    # Serialization
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",

    # Timezone
    timezone="UTC",
    enable_utc=True,

    # Task execution limits
    task_time_limit=settings.celery_task_time_limit,
    task_soft_time_limit=settings.celery_task_soft_time_limit,

    # Result expiry (24 hours)
    result_expires=86400,

    # Worker settings
    worker_prefetch_multiplier=1,  # One task at a time per worker process
    worker_max_tasks_per_child=50,  # Restart worker after 50 tasks (memory safety)

    # Logging
    worker_hijack_root_logger=False,  # Let structlog handle logging
)


# ── Task Definitions ───────────────────────────────────────────────────

@celery_app.task(
    bind=True,
    name="voice.transcribe",
    max_retries=DEFAULT_RETRY_POLICY.max_retries,
    acks_late=True,  # Acknowledge after completion (survives worker crash)
)
def transcribe_audio_task(
    self,
    audio_url: str,
    patient_id: str,
    session_id: str,
) -> dict:
    """Async transcription pipeline.

    Args:
        audio_url: URL to download the audio from.
        patient_id: Patient identifier for logging context.
        session_id: Session identifier for logging context.

    Returns:
        Dict matching TranscribeResponse schema.

    Raises:
        Exception: Re-raised after max retries exhausted.
    """
    from application.dto import TranscribeInput
    from application.transcribe_usecase import TranscribeUseCase
    from core.logging import bind_context
    from stt.preprocess import FFmpegPreprocessor
    from stt.whisper_engine import WhisperEngine
    from translation.libretranslate import LibreTranslateAdapter

    bind_context(
        request_id=self.request.id,
        patient_id=patient_id,
        session_id=session_id,
        task_name="transcribe_audio",
    )

    try:
        config = get_settings()
        recognizer = WhisperEngine(config)
        translator = LibreTranslateAdapter(config)
        preprocessor = FFmpegPreprocessor(config)

        usecase = TranscribeUseCase(
            recognizer=recognizer,
            translator=translator,
            preprocessor=preprocessor,
            config=config,
        )

        result = usecase.execute(
            TranscribeInput(
                audio_url=audio_url,
                patient_id=patient_id,
                session_id=session_id,
            )
        )

        return result.model_dump()

    except Exception as exc:
        if DEFAULT_RETRY_POLICY.should_retry(exc):
            retry_number = self.request.retries
            countdown = DEFAULT_RETRY_POLICY.get_countdown(retry_number)
            raise self.retry(exc=exc, countdown=countdown)
        raise


@celery_app.task(
    bind=True,
    name="voice.synthesize",
    max_retries=DEFAULT_RETRY_POLICY.max_retries,
    acks_late=True,
)
def synthesize_voice_task(
    self,
    text: str,
    language: str,
    voice: str = "doctor",
) -> dict:
    """Async TTS pipeline.

    Args:
        text: Text to convert to speech.
        language: ISO 639-1 language code.
        voice: Voice role identifier.

    Returns:
        Dict matching RespondResponse schema.

    Raises:
        Exception: Re-raised after max retries exhausted.
    """
    from application.dto import RespondInput
    from application.respond_usecase import RespondUseCase
    from tts.encoder import OggOpusEncoder
    from tts.openai_tts import OpenAITTSProvider

    try:
        config = get_settings()
        synthesizer = OpenAITTSProvider(config)
        encoder = OggOpusEncoder(config)

        usecase = RespondUseCase(
            synthesizer=synthesizer,
            encoder=encoder,
            config=config,
        )

        result = usecase.execute(
            RespondInput(
                text=text,
                language=language,
                voice=voice,
            )
        )

        return result.model_dump()

    except Exception as exc:
        if DEFAULT_RETRY_POLICY.should_retry(exc):
            retry_number = self.request.retries
            countdown = DEFAULT_RETRY_POLICY.get_countdown(retry_number)
            raise self.retry(exc=exc, countdown=countdown)
        raise
