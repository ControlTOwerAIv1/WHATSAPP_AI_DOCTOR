"""
Configuration — Environment-based settings using pydantic-settings.

All configuration is loaded from environment variables with the VOICE_ prefix.
Supports .env files for local development.

Usage:
    from core.config import get_settings
    settings = get_settings()
    print(settings.whisper_model_size)
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class VoiceServiceConfig(BaseSettings):
    """Central configuration for the voice processing microservice.

    All fields map to environment variables with the VOICE_ prefix.
    Example: VOICE_WHISPER_MODEL_SIZE=base
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="VOICE_",
        case_sensitive=False,
        extra="ignore",
    )

    # ── STT (Speech-to-Text) ────────────────────────────────────────────
    whisper_model_size: str = "base"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_beam_size: int = 5
    whisper_language: str | None = None  # None = auto-detect

    # ── Translation ─────────────────────────────────────────────────────
    libretranslate_url: str = "http://libretranslate:5000"
    translation_target_language: str = "en"
    translation_enabled: bool = True
    translation_timeout_seconds: int = 10
    translation_circuit_breaker_threshold: int = 3
    translation_circuit_breaker_reset_seconds: int = 60

    # ── TTS (Text-to-Speech) ────────────────────────────────────────────
    tts_provider: str = "edge"  # "edge" (free) or "openai" (paid)
    openai_api_key: str = ""
    tts_model: str = "tts-1"
    tts_default_voice: str = "onyx"
    tts_voice_mapping: str = "doctor:onyx,patient:nova,system:alloy"
    edge_tts_voice_mapping: str = "doctor:en-US-GuyNeural,patient:en-US-JennyNeural,system:en-US-AriaNeural"

    # ── Storage ─────────────────────────────────────────────────────────
    audio_storage_path: str = "./storage/audio"
    generated_storage_path: str = "./storage/generated"
    base_url: str = "http://localhost:8000"

    # ── Audio Validation ────────────────────────────────────────────────
    max_audio_duration_seconds: int = 60
    max_audio_file_size_mb: int = 25
    audio_download_timeout_seconds: int = 30
    allowed_mime_types: str = (
        "audio/ogg,audio/mpeg,audio/wav,audio/x-wav,"
        "audio/mp4,audio/webm,audio/flac,audio/x-flac,"
        "video/ogg,application/ogg"
    )

    # ── Celery ──────────────────────────────────────────────────────────
    celery_broker_url: str = "redis://redis:6379/0"
    celery_result_backend: str = "redis://redis:6379/0"
    celery_task_time_limit: int = 120
    celery_task_soft_time_limit: int = 90

    # ── ffmpeg ──────────────────────────────────────────────────────────
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    ffmpeg_timeout_seconds: int = 30

    # ── General ─────────────────────────────────────────────────────────
    log_level: str = "INFO"
    debug: bool = False
    environment: str = "development"

    def get_allowed_mime_types(self) -> list[str]:
        """Parse comma-separated MIME type string into a list."""
        return [m.strip() for m in self.allowed_mime_types.split(",") if m.strip()]

    def get_voice_mapping(self) -> dict[str, str]:
        """Parse voice mapping string into a dict.

        Format: 'doctor:onyx,patient:nova,system:alloy'
        Returns: {'doctor': 'onyx', 'patient': 'nova', 'system': 'alloy'}
        """
        mapping = {}
        for pair in self.tts_voice_mapping.split(","):
            pair = pair.strip()
            if ":" in pair:
                role, voice_id = pair.split(":", 1)
                mapping[role.strip()] = voice_id.strip()
        return mapping


@lru_cache(maxsize=1)
def get_settings() -> VoiceServiceConfig:
    """Singleton settings instance, cached for the process lifetime."""
    return VoiceServiceConfig()
