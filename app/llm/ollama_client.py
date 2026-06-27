"""
Ollama Client — Thin wrapper around langchain-ollama's ChatOllama.

Provides a singleton LLM instance configured from environment variables.
All agent nodes use this to get their LLM — swap models in one place.

Usage:
    from llm.ollama_client import get_llm
    llm = get_llm()
    response = llm.invoke("Hello")
"""

from __future__ import annotations

from langchain_ollama import ChatOllama

from core.config import get_settings
from core.logging import get_logger

logger = get_logger(__name__)

_llm_instance: ChatOllama | None = None


def get_llm() -> ChatOllama:
    """Get or create the singleton ChatOllama instance.

    Configured by APP_OLLAMA_BASE_URL and APP_OLLAMA_MODEL env vars.
    """
    global _llm_instance
    if _llm_instance is None:
        settings = get_settings()
        _llm_instance = ChatOllama(
            model=settings.ollama_model,
            base_url=settings.ollama_base_url,
            timeout=settings.ollama_timeout,
            temperature=0.3,  # Lower temp for more consistent medical responses
        )
        logger.info(
            "ollama_client_initialized",
            model=settings.ollama_model,
            base_url=settings.ollama_base_url,
        )
    return _llm_instance


def get_fast_llm() -> ChatOllama:
    """Get a faster, smaller model for classification tasks.

    Uses the same model but with temperature=0 for deterministic outputs.
    In production, this could point to a smaller model like phi3:mini.
    """
    settings = get_settings()
    return ChatOllama(
        model=settings.ollama_model,
        base_url=settings.ollama_base_url,
        timeout=settings.ollama_timeout,
        temperature=0,
    )
