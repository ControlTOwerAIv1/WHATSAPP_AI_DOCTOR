"""
Configuration — Environment-based settings using pydantic-settings.

All configuration loaded from environment variables with the APP_ prefix.
Supports .env files for local development.

Usage:
    from core.config import get_settings
    settings = get_settings()
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    """Central configuration for the WhatsApp AI Doctor core backend.

    All fields map to environment variables with the APP_ prefix.
    Example: APP_OLLAMA_BASE_URL=http://ollama:11434
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="APP_",
        case_sensitive=False,
        extra="ignore",
    )

    # ── WhatsApp / Meta Cloud API (kept for future production use) ────
    whatsapp_verify_token: str = "whatsapp-ai-doctor-verify"
    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_api_version: str = "v21.0"

    # ── Anthropic Claude LLM ───────────────────────────────────────────
    anthropic_api_key: str = ""

    # ── Google Sheets (availability + bookings) ────────────────────────
    google_credentials_file: str = ""
    google_sheet_id: str = ""

    # ── Twilio WhatsApp Sandbox ────────────────────────────────────────
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""

    # ── Legacy — kept so the app starts even when these aren't set ─────
    ollama_base_url: str = "http://ollama:11434"
    ollama_model: str = "llama3.1:8b"
    ollama_timeout: int = 120
    database_url: str = "sqlite:///./whatsapp_doctor.db"
    redis_url: str = "redis://redis:6379/1"
    qdrant_host: str = "qdrant"
    qdrant_port: int = 6333
    qdrant_collection: str = "patient_history"
    voice_service_url: str = "http://voice-service:8000"
    celery_broker_url: str = "redis://redis:6379/1"
    celery_result_backend: str = "redis://redis:6379/1"

    # ── General ────────────────────────────────────────────────────────
    log_level: str = "info"
    debug: bool = False
    environment: str = "development"


    @property
    def whatsapp_api_base(self) -> str:
        """Build the Meta Graph API base URL."""
        return f"https://graph.facebook.com/{self.whatsapp_api_version}"


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    """Singleton settings instance, cached for the process lifetime."""
    return AppSettings()
