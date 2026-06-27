"""
Structured Logging — JSON-formatted logs with request context propagation.

Every log line includes contextual fields:
    request_id, patient_id, session_id, duration_ms, stage, error

Uses structlog for structured logging with stdlib integration.
Context is propagated via contextvars so that all log calls within
a request automatically include the request's identifiers.

Usage:
    from core.logging import get_logger, bind_context

    logger = get_logger(__name__)

    # At request start:
    bind_context(request_id="abc", patient_id="p1", session_id="s1")

    # Anywhere in the call chain:
    logger.info("transcription_started", stage="stt", audio_duration=12.5)
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

import structlog

# ── Context Variables ───────────────────────────────────────────────────
# These propagate across async boundaries within a single request.
_request_context: ContextVar[dict[str, Any]] = ContextVar(
    "request_context", default={}
)


def bind_context(**kwargs: Any) -> None:
    """Bind key-value pairs to the current request context.

    These will be included in every subsequent log call within
    the same async context (request lifecycle).
    """
    current = _request_context.get().copy()
    current.update(kwargs)
    _request_context.set(current)


def clear_context() -> None:
    """Clear all bound context (call at request end)."""
    _request_context.set({})


def _inject_context(
    logger: Any, method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    """Structlog processor that injects request context into every log event."""
    ctx = _request_context.get()
    # Context fields go first, then event-specific fields override
    merged = {**ctx, **event_dict}
    return merged


def setup_logging(log_level: str = "INFO", json_output: bool = True) -> None:
    """Configure structlog with JSON output and context injection.

    Call once at application startup.

    Args:
        log_level: Minimum log level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        json_output: If True, output JSON lines. If False, output
                     human-readable colored output (for local dev).
    """
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        _inject_context,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    if json_output:
        renderer: structlog.types.Processor = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=True)

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))

    # Silence noisy third-party loggers
    for noisy in ("httpx", "httpcore", "urllib3", "faster_whisper"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Get a structlog logger bound to the given module name.

    Args:
        name: Typically __name__ of the calling module.

    Returns:
        A structured logger instance.
    """
    return structlog.get_logger(name)
