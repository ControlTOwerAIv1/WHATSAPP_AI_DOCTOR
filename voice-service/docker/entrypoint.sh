#!/bin/bash
# ===================================================================
# Entrypoint — Voice Processing Microservice
# ===================================================================
# Handles startup logic:
#   1. Wait for Redis to be available
#   2. Create storage directories
#   3. Start uvicorn (API) or celery (worker) based on command
# ===================================================================

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║       Voice Processing Microservice - Starting          ║"
echo "╚══════════════════════════════════════════════════════════╝"

# ── Wait for Redis ────────────────────────────────────────────────
echo "[startup] Waiting for Redis..."
REDIS_HOST="${VOICE_CELERY_BROKER_URL:-redis://redis:6379/0}"
# Extract host from redis URL
REDIS_ADDR=$(echo "$REDIS_HOST" | sed -E 's|redis://([^:/]+).*|\1|')
REDIS_PORT=$(echo "$REDIS_HOST" | sed -E 's|redis://[^:]+:([0-9]+).*|\1|')
REDIS_PORT="${REDIS_PORT:-6379}"

MAX_WAIT=30
WAITED=0
until python -c "
import redis
r = redis.from_url('${VOICE_CELERY_BROKER_URL:-redis://redis:6379/0}', socket_timeout=2)
r.ping()
print('[startup] Redis is ready')
" 2>/dev/null; do
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "[startup] WARNING: Redis not available after ${MAX_WAIT}s, starting anyway"
        break
    fi
    echo "[startup] Waiting for Redis... (${WAITED}s)"
    sleep 1
done

# ── Create storage directories ────────────────────────────────────
mkdir -p "${VOICE_AUDIO_STORAGE_PATH:-./storage/audio}"
mkdir -p "${VOICE_GENERATED_STORAGE_PATH:-./storage/generated}"
echo "[startup] Storage directories ready"

# ── Verify ffmpeg ─────────────────────────────────────────────────
if command -v ffmpeg &> /dev/null; then
    FFMPEG_VERSION=$(ffmpeg -version | head -1)
    echo "[startup] ${FFMPEG_VERSION}"
else
    echo "[startup] WARNING: ffmpeg not found in PATH"
fi

# ── Start the service ─────────────────────────────────────────────
# If CMD is overridden (e.g., for celery worker), use that.
# Otherwise, start uvicorn.
if [ "$#" -gt 0 ]; then
    echo "[startup] Running custom command: $@"
    exec "$@"
else
    echo "[startup] Starting uvicorn on port 8000"
    exec uvicorn main:app \
        --host 0.0.0.0 \
        --port 8000 \
        --workers 1 \
        --log-level "${VOICE_LOG_LEVEL:-info}"
fi
