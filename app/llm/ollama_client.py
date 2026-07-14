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
    """Get a fast LLM for intent classification using Anthropic Claude.

    Returns an object with an ``invoke`` method compatible with the existing
    supervisor code. The underlying model is ``claude-sonnet-4-6`` and runs with
    deterministic settings.
    """
    from anthropic import Anthropic
    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

    class ClaudeWrapper:
        def __init__(self, client):
            self.client = client
        def invoke(self, prompt: str):
            # Use the Claude chat API. No system prompt needed for simple classification.
            response = self.client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                temperature=0,
                messages=[{"role": "user", "content": prompt}],
            )
            # The response content is a list of blocks; take the first text block.
            text = response.content[0].text if hasattr(response, "content") else str(response)
            class Resp:
                def __init__(self, content):
                    self.content = content
            return Resp(text)

    return ClaudeWrapper(client)

