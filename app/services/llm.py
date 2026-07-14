"""
LLM Client — Thin wrapper around the Anthropic Claude API.

Provides singleton-style LLM accessors that return objects whose interface
matches the old ChatOllama contract (``response = llm.invoke(prompt);
response.content``).  Every agent file that previously imported from
``llm.ollama_client`` can switch to this module with a one-line import change.

Usage:
    from services.llm import get_llm, get_fast_llm
    llm = get_llm()
    response = llm.invoke("Hello")
    print(response.content)
"""

from __future__ import annotations

import anthropic

from core.config import get_settings
from core.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Lightweight response object so callers can do ``response.content``
# ---------------------------------------------------------------------------

class _LLMResponse:
    """Minimal stand-in for LangChain's AIMessage."""

    __slots__ = ("content",)

    def __init__(self, content: str) -> None:
        self.content = content

    def __repr__(self) -> str:
        return f"_LLMResponse(content={self.content[:80]!r}...)"


# ---------------------------------------------------------------------------
# Claude wrapper — keeps the .invoke() contract
# ---------------------------------------------------------------------------

class _ClaudeLLM:
    """Wraps the Anthropic SDK so callers see ``.invoke(prompt) → response``."""

    def __init__(self, *, temperature: float = 0.3, max_tokens: int = 500) -> None:
        settings = get_settings()
        self._client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        self._model = "claude-sonnet-4-5"
        self._temperature = temperature
        self._max_tokens = max_tokens
        logger.info(
            "claude_llm_initialized",
            model=self._model,
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        )

    def invoke(self, prompt: str) -> _LLMResponse:
        """Send *prompt* to Claude and return a response with ``.content``."""
        try:
            message = self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                temperature=self._temperature,
                messages=[{"role": "user", "content": prompt}],
            )
            text = message.content[0].text
            return _LLMResponse(text)
        except Exception as exc:
            logger.error("claude_invoke_failed", error=str(exc))
            return _LLMResponse(
                "I'm sorry, I'm having trouble processing your request right now. "
                "Please try again in a moment. "
            )


# ---------------------------------------------------------------------------
# Singletons — created on first call, reused thereafter
# ---------------------------------------------------------------------------

_llm_instance: _ClaudeLLM | None = None
_fast_llm_instance: _ClaudeLLM | None = None


def get_llm() -> _ClaudeLLM:
    """General-purpose LLM (temperature 0.3) for conversational replies."""
    global _llm_instance
    if _llm_instance is None:
        _llm_instance = _ClaudeLLM(temperature=0.3, max_tokens=500)
    return _llm_instance


def get_fast_llm() -> _ClaudeLLM:
    """Deterministic LLM (temperature 0) for classification tasks."""
    global _fast_llm_instance
    if _fast_llm_instance is None:
        _fast_llm_instance = _ClaudeLLM(temperature=0, max_tokens=100)
    return _fast_llm_instance
