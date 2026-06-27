"""
Health Router — GET /health and GET /health/dependencies

Provides liveness and dependency health checks.

GET /health
    Simple liveness probe. Returns 200 if the process is alive.
    No external calls. Suitable for Kubernetes liveness probes.

GET /health/dependencies
    Deep health check. Verifies connectivity to:
    - Redis (Celery broker)
    - LibreTranslate (translation service)
    - Storage directories (read/write access)
    - ffmpeg binary (subprocess availability)
    - TTS provider (API reachability)

    Each dependency reports: name, status, latency_ms, error.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
import redis

from fastapi import APIRouter

from core.config import get_settings
from core.logging import get_logger
from core.schemas import (
    DependenciesHealthResponse,
    DependencyStatus,
    HealthResponse,
)

logger = get_logger(__name__)

router = APIRouter(tags=["Health"])


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=200,
    summary="Liveness check",
    description="Returns 200 if the service process is alive.",
)
def health() -> HealthResponse:
    """Simple liveness probe — no external dependencies checked."""
    return HealthResponse(status="healthy")


@router.get(
    "/health/dependencies",
    response_model=DependenciesHealthResponse,
    status_code=200,
    summary="Dependency health check",
    description=(
        "Verifies connectivity to all external dependencies: "
        "Redis, LibreTranslate, storage, ffmpeg, TTS."
    ),
)
def health_dependencies() -> DependenciesHealthResponse:
    """Deep health check verifying all external dependencies."""
    settings = get_settings()
    results: list[DependencyStatus] = []

    # ── Redis ───────────────────────────────────────────────────────
    results.append(_check_redis(settings.celery_broker_url))

    # ── LibreTranslate ──────────────────────────────────────────────
    results.append(_check_libretranslate(settings.libretranslate_url))

    # ── Storage (audio) ─────────────────────────────────────────────
    results.append(_check_storage(settings.audio_storage_path, "storage_audio"))

    # ── Storage (generated) ─────────────────────────────────────────
    results.append(
        _check_storage(settings.generated_storage_path, "storage_generated")
    )

    # ── ffmpeg ──────────────────────────────────────────────────────
    results.append(_check_ffmpeg(settings.ffmpeg_path))

    # ── TTS (OpenAI API) ────────────────────────────────────────────
    results.append(_check_tts_api(settings.openai_api_key))

    # Overall status
    all_healthy = all(dep.status == "healthy" for dep in results)
    overall_status = "healthy" if all_healthy else "degraded"

    return DependenciesHealthResponse(
        status=overall_status,
        dependencies=results,
    )


def _check_redis(broker_url: str) -> DependencyStatus:
    """Check Redis connectivity."""
    start = time.monotonic()
    try:
        r = redis.from_url(broker_url, socket_timeout=3)
        r.ping()
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="redis",
            status="healthy",
            latency_ms=latency,
        )
    except Exception as exc:
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="redis",
            status="unhealthy",
            latency_ms=latency,
            error=str(exc),
        )


def _check_libretranslate(base_url: str) -> DependencyStatus:
    """Check LibreTranslate API reachability."""
    start = time.monotonic()
    url = f"{base_url.rstrip('/')}/languages"
    try:
        with httpx.Client(timeout=5) as client:
            response = client.get(url)
            response.raise_for_status()
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="libretranslate",
            status="healthy",
            latency_ms=latency,
        )
    except Exception as exc:
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="libretranslate",
            status="unhealthy",
            latency_ms=latency,
            error=str(exc),
        )


def _check_storage(path: str, name: str) -> DependencyStatus:
    """Check storage directory exists and is writable."""
    start = time.monotonic()
    try:
        storage_path = Path(path)
        storage_path.mkdir(parents=True, exist_ok=True)

        # Test write capability
        test_file = storage_path / ".health_check"
        test_file.write_text("ok")
        test_file.unlink()

        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name=name,
            status="healthy",
            latency_ms=latency,
        )
    except Exception as exc:
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name=name,
            status="unhealthy",
            latency_ms=latency,
            error=str(exc),
        )


def _check_ffmpeg(ffmpeg_path: str) -> DependencyStatus:
    """Check ffmpeg binary availability."""
    start = time.monotonic()
    try:
        result = subprocess.run(
            [ffmpeg_path, "-version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        latency = round((time.monotonic() - start) * 1000, 1)
        if result.returncode == 0:
            # Extract version from first line
            version_line = result.stdout.split("\n")[0] if result.stdout else ""
            return DependencyStatus(
                name="ffmpeg",
                status="healthy",
                latency_ms=latency,
            )
        else:
            return DependencyStatus(
                name="ffmpeg",
                status="unhealthy",
                latency_ms=latency,
                error=f"ffmpeg returned exit code {result.returncode}",
            )
    except FileNotFoundError:
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="ffmpeg",
            status="unhealthy",
            latency_ms=latency,
            error=f"ffmpeg not found at '{ffmpeg_path}'",
        )
    except Exception as exc:
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="ffmpeg",
            status="unhealthy",
            latency_ms=latency,
            error=str(exc),
        )


def _check_tts_api(api_key: str) -> DependencyStatus:
    """Check OpenAI TTS API reachability (lightweight models list call)."""
    start = time.monotonic()
    if not api_key:
        return DependencyStatus(
            name="tts_openai",
            status="unhealthy",
            latency_ms=0,
            error="VOICE_OPENAI_API_KEY not configured",
        )

    try:
        with httpx.Client(timeout=5) as client:
            response = client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            response.raise_for_status()

        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="tts_openai",
            status="healthy",
            latency_ms=latency,
        )
    except Exception as exc:
        latency = round((time.monotonic() - start) * 1000, 1)
        return DependencyStatus(
            name="tts_openai",
            status="unhealthy",
            latency_ms=latency,
            error=str(exc),
        )
