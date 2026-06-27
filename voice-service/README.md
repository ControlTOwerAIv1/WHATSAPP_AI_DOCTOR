# Voice Processing Microservice

A Dockerized voice infrastructure service providing **Speech-to-Text (STT)** transcription and **Text-to-Speech (TTS)** synthesis via HTTP API.

Built with **hexagonal architecture** (ports + adapters) for maximum provider replaceability, testability, and isolation from upstream systems.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        External Layer (API)                         │
│  POST /api/v1/voice/transcribe  │  POST /api/v1/voice/respond      │
│  GET /health                     │  GET /health/dependencies         │
├─────────────────────────────────────────────────────────────────────┤
│                     Application Layer (Use Cases)                    │
│  TranscribeUseCase: download→validate→normalize→STT→translate       │
│  RespondUseCase: synthesize→encode→store→URL                        │
├─────────────────────────────────────────────────────────────────────┤
│                     Domain Layer (Contracts)                         │
│  SpeechRecognizer │ TextTranslator │ SpeechSynthesizer              │
│  AudioStorage     │ AudioPreprocessor │ AudioEncoder                │
├─────────────────────────────────────────────────────────────────────┤
│                  Infrastructure Layer (Adapters)                     │
│  WhisperEngine │ LibreTranslate │ OpenAITTS │ OggOpusEncoder        │
│  FFmpegPreprocessor │ LocalFileStorage                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Dependency rule**: outer layers depend on inner layers, never the reverse. Infrastructure implements domain contracts via Python `Protocol` (structural subtyping — no inheritance required).

---

## Quick Start

### Prerequisites

- **Docker** and **Docker Compose** v2+
- **OpenAI API key** (for TTS)

### One-Command Setup

```bash
git clone <repo-url>
cd voice-service

# Configure
cp .env.example .env
# Edit .env → set VOICE_OPENAI_API_KEY=sk-...

# Start everything
docker compose -f docker/docker-compose.yml up
```

Wait for all 4 containers to become healthy (LibreTranslate takes 2-3 minutes on first run to download language models).

### Verify

```bash
# Health check
curl http://localhost:8000/health
# → {"status": "healthy"}

# Dependency check
curl http://localhost:8000/health/dependencies
# → {"status": "healthy", "dependencies": [...]}
```

---

## API Reference

### POST `/api/v1/voice/transcribe`

Transcribe audio from a URL to text with optional translation.

**Request:**
```json
{
  "audio_url": "https://example.com/audio.ogg",
  "patient_id": "patient_123",
  "session_id": "session_456"
}
```

**Response (200):**
```json
{
  "transcript": "Hello, I have been experiencing headaches.",
  "detected_language": "en",
  "translated_text": null,
  "timestamps": [
    {"start": 0.0, "end": 3.5, "text": "Hello, I have been experiencing headaches."}
  ],
  "confidence": 0.92
}
```

**Error Codes:** `400`, `408` (download timeout), `422` (validation), `500`

---

### POST `/api/v1/voice/respond`

Convert text to a voice audio file (.ogg).

**Request:**
```json
{
  "text": "Take your medicine at 9 AM.",
  "language": "en",
  "voice": "doctor"
}
```

**Response (200):**
```json
{
  "voice_url": "http://localhost:8000/storage/generated/abc123.ogg",
  "format": "ogg"
}
```

**Error Codes:** `422`, `500`

---

### GET `/health`

Simple liveness probe. Returns `{"status": "healthy"}`.

### GET `/health/dependencies`

Deep health check. Verifies: Redis, LibreTranslate, storage, ffmpeg, TTS API.

---

## Folder Structure

```
voice-service/
├── api/                    # FastAPI routers (external layer)
│   ├── transcript.py       #   POST /transcribe
│   ├── synthesize.py       #   POST /respond
│   ├── health.py           #   GET /health, /health/dependencies
│   └── upload.py           #   Audio download utilities
├── application/            # Use cases (orchestration)
│   ├── transcribe_usecase.py
│   ├── respond_usecase.py
│   └── dto.py              #   Internal data transfer objects
├── domain/                 # Pure contracts (zero dependencies)
│   ├── entities.py         #   Immutable dataclasses
│   └── contracts.py        #   Protocol interfaces (ports)
├── stt/                    # Speech-to-Text adapter
│   ├── whisper_engine.py   #   faster-whisper implementation
│   ├── preprocess.py       #   ffmpeg normalization
│   └── interfaces.py       #   Contract re-exports
├── translation/            # Translation adapter
│   ├── libretranslate.py   #   LibreTranslate HTTP client
│   ├── language_detect.py  #   Detection utilities
│   └── interfaces.py
├── tts/                    # Text-to-Speech adapter
│   ├── openai_tts.py       #   OpenAI TTS implementation
│   ├── encoder.py          #   WAV→OGG/Opus encoding
│   └── interfaces.py
├── tasks/                  # Celery async tasks
│   ├── celery_worker.py
│   └── retry_policy.py
├── core/                   # Shared infrastructure
│   ├── config.py           #   Pydantic Settings (env-based)
│   ├── logging.py          #   Structured JSON logging
│   ├── exceptions.py       #   Domain exception hierarchy
│   └── schemas.py          #   API contract schemas
├── storage/                # Ephemeral file storage
│   ├── audio/              #   Downloaded/normalized input
│   └── generated/          #   TTS output files
├── docker/
│   ├── Dockerfile          #   Multi-stage build
│   ├── docker-compose.yml  #   4 containers + healthchecks
│   └── entrypoint.sh
├── tests/
│   ├── conftest.py         #   Shared fixtures
│   ├── unit/               #   All modules tested in isolation
│   └── integration/        #   End-to-end with Docker
├── main.py                 #   FastAPI app factory + DI wiring
├── requirements.txt
├── pyproject.toml
├── Makefile
└── .env.example
```

---

## Configuration

All settings are loaded from environment variables with the `VOICE_` prefix. See `.env.example` for all options.

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE_WHISPER_MODEL_SIZE` | `base` | Whisper model: tiny, base, small, medium, large-v3 |
| `VOICE_WHISPER_DEVICE` | `cpu` | Device: cpu or cuda |
| `VOICE_OPENAI_API_KEY` | (required) | OpenAI API key for TTS |
| `VOICE_TTS_MODEL` | `tts-1` | OpenAI TTS model |
| `VOICE_TRANSLATION_ENABLED` | `true` | Enable/disable translation |
| `VOICE_TRANSLATION_TARGET_LANGUAGE` | `en` | Target language for translation |
| `VOICE_MAX_AUDIO_DURATION_SECONDS` | `60` | Max input audio length |
| `VOICE_LOG_LEVEL` | `INFO` | Logging level |

---

## Docker Services

| Container | Port | Purpose |
|-----------|------|---------|
| `voice-api` | 8000 | FastAPI server |
| `voice-celery-worker` | — | Async task processing |
| `voice-redis` | 6379 | Celery broker + result backend |
| `voice-libretranslate` | 5000 | Self-hosted translation |

---

## Development

### Local Setup (without Docker)

```bash
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env
# Edit .env

# Ensure ffmpeg is installed
ffmpeg -version

# Start Redis locally
# Start the server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Running Tests

```bash
# Unit tests (no Docker needed)
pytest tests/unit/ -v --cov=. --cov-report=term-missing

# Integration tests (Docker required)
docker compose -f docker/docker-compose.yml up -d
INTEGRATION_TESTS=1 pytest tests/integration/ -v

# Full suite
make test
```

---

## Extending This Service

### Adding a New TTS Provider (e.g., ElevenLabs)

1. Create `tts/elevenlabs_tts.py`
2. Implement the `SpeechSynthesizer` protocol:
   ```python
   class ElevenLabsTTSProvider:
       def synthesize(self, text, voice, language) -> SynthesisResult:
           ...
   ```
3. Add config variables to `core/config.py`
4. Wire in `main.py` based on a config flag
5. No other files change

### Adding a New STT Engine

1. Create a new file in `stt/`
2. Implement the `SpeechRecognizer` protocol
3. Wire in `main.py`

The hexagonal architecture ensures adding a provider never touches the use cases, API layer, or other adapters.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| LibreTranslate slow to start | First run downloads models (~2-3 min). Subsequent starts are fast. |
| `ffmpeg not found` | Install ffmpeg: `apt-get install ffmpeg` or check `VOICE_FFMPEG_PATH` |
| OpenAI TTS 401 | Check `VOICE_OPENAI_API_KEY` is valid and has billing enabled |
| Whisper OOM on large-v3 | Use `base` or `small` model, or increase Docker memory limit |
| Redis connection refused | Ensure Redis container is running and healthy |
| Translation circuit breaker open | LibreTranslate may be down; check `docker logs voice-libretranslate` |

---

## API Documentation

Interactive API docs are available at:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc
- **OpenAPI JSON**: http://localhost:8000/openapi.json
