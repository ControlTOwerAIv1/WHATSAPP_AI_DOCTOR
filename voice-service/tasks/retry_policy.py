"""
Retry Policy — Exponential backoff configuration for Celery tasks.

Retry schedule: 1s → 3s → 10s (configurable).

This module defines retry behavior for all Celery tasks in the service.
Import the policy and apply it to task decorators.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from core.exceptions import (
    AudioDownloadError,
    AudioProcessingError,
    SynthesisError,
    TranscriptionError,
    TranslationError,
)


@dataclass(frozen=True)
class RetryPolicy:
    """Retry configuration for Celery tasks.

    Attributes:
        max_retries: Maximum number of retry attempts.
        retry_backoff: List of delay seconds between retries.
        retry_on: Tuple of exception types that trigger retries.
        retry_jitter: If True, add random jitter to backoff delays.
    """

    max_retries: int = 3
    retry_backoff: tuple[int, ...] = (1, 3, 10)
    retry_on: tuple[type[Exception], ...] = (
        AudioDownloadError,
        TranscriptionError,
        TranslationError,
        SynthesisError,
        AudioProcessingError,
    )
    retry_jitter: bool = True

    def get_countdown(self, retry_number: int) -> int:
        """Get the backoff delay for a given retry attempt.

        Args:
            retry_number: Current retry attempt (0-indexed).

        Returns:
            Delay in seconds before the next retry.
        """
        if retry_number < len(self.retry_backoff):
            return self.retry_backoff[retry_number]
        # Fall back to the last value for retries beyond the backoff list
        return self.retry_backoff[-1]

    def should_retry(self, exc: Exception) -> bool:
        """Check if the given exception should trigger a retry.

        Args:
            exc: The exception that was raised.

        Returns:
            True if the exception type is in the retry_on list.
        """
        return isinstance(exc, self.retry_on)


# Default policy instance
DEFAULT_RETRY_POLICY = RetryPolicy()

# Strict policy for critical operations (fewer retries, shorter backoff)
STRICT_RETRY_POLICY = RetryPolicy(
    max_retries=2,
    retry_backoff=(1, 5),
    retry_on=(AudioDownloadError, TranscriptionError),
    retry_jitter=False,
)
