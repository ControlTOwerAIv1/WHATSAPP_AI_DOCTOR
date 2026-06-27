"""
Voice Processing Microservice — FastAPI Application Factory.

This is the single entry point for the entire service.

Responsibilities:
  - Create and configure the FastAPI application
  - Mount all routers under /api/v1/
  - Wire dependency injection (provider → protocol → use case → router)
  - Register exception handlers (domain exception → HTTP status code)
  - Mount static file serving for generated voice files
  - Configure CORS, startup/shutdown lifecycle events
  - Initialize structured logging

Usage:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from api.health import router as health_router
from api.synthesize import get_respond_usecase, router as synthesize_router
from api.transcript import get_transcribe_usecase, router as transcript_router
from application.respond_usecase import RespondUseCase
from application.transcribe_usecase import TranscribeUseCase
from core.config import VoiceServiceConfig, get_settings
from core.exceptions import VoiceServiceError
from core.logging import get_logger, setup_logging
from stt.preprocess import FFmpegPreprocessor
from stt.whisper_engine import WhisperEngine
from translation.libretranslate import LibreTranslateAdapter
from tts.encoder import OggOpusEncoder
from tts.openai_tts import OpenAITTSProvider

logger = get_logger(__name__)


# ── Dependency Container ──────────────────────────────────────────────
# Singleton instances created at startup, injected into routers via
# FastAPI's dependency_overrides mechanism.

_transcribe_usecase: TranscribeUseCase | None = None
_respond_usecase: RespondUseCase | None = None


def _create_transcribe_usecase(config: VoiceServiceConfig) -> TranscribeUseCase:
    """Wire all dependencies for the transcription pipeline."""
    recognizer = WhisperEngine(config)
    translator = LibreTranslateAdapter(config)
    preprocessor = FFmpegPreprocessor(config)

    return TranscribeUseCase(
        recognizer=recognizer,
        translator=translator,
        preprocessor=preprocessor,
        config=config,
    )


def _create_respond_usecase(config: VoiceServiceConfig) -> RespondUseCase:
    """Wire all dependencies for the TTS pipeline.

    Selects TTS provider based on VOICE_TTS_PROVIDER env var:
      - "edge" (default): Free Edge TTS — no API key needed
      - "openai": OpenAI TTS — requires VOICE_OPENAI_API_KEY
    """
    if config.tts_provider == "openai":
        synthesizer = OpenAITTSProvider(config)
        logger.info("tts_provider_selected", provider="openai")
    else:
        from tts.edge_tts_provider import EdgeTTSProvider
        synthesizer = EdgeTTSProvider(config)
        logger.info("tts_provider_selected", provider="edge")

    encoder = OggOpusEncoder(config)

    return RespondUseCase(
        synthesizer=synthesizer,
        encoder=encoder,
        config=config,
    )


# ── Lifespan ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management.

    Startup:
      - Initialize structured logging
      - Validate external dependencies (ffmpeg)
      - Create storage directories
      - Wire dependency injection

    Shutdown:
      - Log shutdown
      - (Future: cleanup temp files, close connections)
    """
    global _transcribe_usecase, _respond_usecase

    config = get_settings()

    # Initialize logging
    json_output = config.environment != "development"
    setup_logging(log_level=config.log_level, json_output=json_output)

    logger.info(
        "service_starting",
        environment=config.environment,
        whisper_model=config.whisper_model_size,
        translation_enabled=config.translation_enabled,
        tts_model=config.tts_model,
    )

    # Validate ffmpeg availability
    try:
        result = subprocess.run(
            [config.ffmpeg_path, "-version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            logger.error("ffmpeg_not_available", ffmpeg_path=config.ffmpeg_path)
    except FileNotFoundError:
        logger.error(
            "ffmpeg_not_found",
            ffmpeg_path=config.ffmpeg_path,
            hint="Install ffmpeg or set VOICE_FFMPEG_PATH",
        )

    # Create storage directories
    Path(config.audio_storage_path).mkdir(parents=True, exist_ok=True)
    Path(config.generated_storage_path).mkdir(parents=True, exist_ok=True)

    # Wire dependency injection
    _transcribe_usecase = _create_transcribe_usecase(config)
    _respond_usecase = _create_respond_usecase(config)

    # Override the DI stubs in routers
    app.dependency_overrides[get_transcribe_usecase] = lambda: _transcribe_usecase
    app.dependency_overrides[get_respond_usecase] = lambda: _respond_usecase

    logger.info("service_ready", port=8000)

    yield

    # Shutdown
    logger.info("service_shutting_down")


# ── Application Factory ──────────────────────────────────────────────

app = FastAPI(
    title="Voice Processing Microservice",
    description=(
        "Dockerized voice infrastructure service providing speech-to-text "
        "(STT) transcription and text-to-speech (TTS) synthesis via HTTP API. "
        "Designed as an isolated subsystem with hexagonal architecture."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)


# ── CORS Middleware ───────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten via VOICE_CORS_ORIGINS in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Exception Handlers ───────────────────────────────────────────────

@app.exception_handler(VoiceServiceError)
async def voice_service_error_handler(
    request: Request, exc: VoiceServiceError
) -> JSONResponse:
    """Map domain exceptions to structured HTTP error responses."""
    logger.error(
        "request_error",
        error_type=type(exc).__name__,
        message=exc.message,
        details=exc.details,
        status_code=exc.status_code,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": type(exc).__name__,
            "message": exc.message,
            "details": exc.details,
        },
    )


@app.exception_handler(Exception)
async def generic_error_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    """Catch-all for unexpected exceptions."""
    logger.exception(
        "unhandled_exception",
        error_type=type(exc).__name__,
        message=str(exc),
    )
    return JSONResponse(
        status_code=500,
        content={
            "error": "InternalServerError",
            "message": "An unexpected error occurred.",
            "details": None,
        },
    )


# ── Router Registration ──────────────────────────────────────────────

app.include_router(transcript_router)
app.include_router(synthesize_router)
app.include_router(health_router)


# ── Static File Serving ──────────────────────────────────────────────
# Serve generated voice files at /storage/generated/<filename>.ogg

_generated_dir = Path(get_settings().generated_storage_path)
_generated_dir.mkdir(parents=True, exist_ok=True)

app.mount(
    "/storage/generated",
    StaticFiles(directory=str(_generated_dir)),
    name="generated_audio",
)
