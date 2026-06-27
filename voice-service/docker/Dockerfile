# ===================================================================
# Multi-stage Dockerfile for Voice Processing Microservice
# ===================================================================
# Stage 1 (builder): Install Python dependencies into /install
# Stage 2 (runtime): Minimal image with ffmpeg + runtime deps
# ===================================================================

# ── Stage 1: Builder ─────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies to /install prefix
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: Runtime ─────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# Install runtime system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Create non-root user
RUN useradd --create-home --shell /bin/bash voiceservice

# Set working directory
WORKDIR /app

# Create storage directories
RUN mkdir -p storage/audio storage/generated && \
    chown -R voiceservice:voiceservice /app

# Copy application code
COPY --chown=voiceservice:voiceservice . .

# Make entrypoint executable
RUN chmod +x docker/entrypoint.sh

# Switch to non-root user
USER voiceservice

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Default command
ENTRYPOINT ["./docker/entrypoint.sh"]
