# WhatsApp AI Doctor

A WhatsApp-native AI healthcare assistant built with FastAPI, LangGraph, and local LLM inference. Handles the full consultation lifecycle: doctor-patient conversations, appointment scheduling, prescription tracking, and medicine reminders — all through WhatsApp.

## Architecture

```
WhatsApp ──► FastAPI /webhook ──► LangGraph Agent Graph ──► WhatsApp Reply
                │                       │
                │                 ┌─────┴──────────┐
                │                 │  Supervisor     │
                │                 │  (intent class) │
                │                 └──┬──┬──┬──┬─────┘
                │                    │  │  │  │
                │            ┌───────┘  │  │  └──────────┐
                │            ▼          ▼  ▼              ▼
                │     Conversation  Appt  Med       Patient Insight
                │      Listener    Sched  Track     (RAG/Qdrant)
                │                                        │
                │                                        ▼
                │                                  Clinical Reasoning
                │
           voice-service ◄──── STT (faster-whisper)
           (port 8000)   ────► TTS (edge-tts, free)
```

## Tech Stack (All Free)

| Layer | Technology |
|---|---|
| LLM | Ollama + llama3.1:8b (local) |
| STT | faster-whisper (local) |
| TTS | edge-tts (free, no API key) |
| Embeddings | BGE-M3 via sentence-transformers |
| Vector DB | Qdrant (self-hosted) |
| Relational DB | PostgreSQL 16 |
| Queue | Celery + Redis |
| Messaging | Meta WhatsApp Cloud API |

## Quick Start

### 1. Clone and configure

```bash
cp .env.example .env
# Edit .env with your Meta WhatsApp credentials
```

### 2. Start the full stack

```bash
docker-compose up -d
```

This starts 8 services: PostgreSQL, Redis, Qdrant, Ollama, voice-service, voice Celery worker, core API, core Celery worker.

### 3. Pull the Ollama model

The Ollama container starts empty — you need to pull the LLM model:

```bash
docker-compose exec ollama ollama pull llama3.1:8b
```

> **Note**: This downloads ~4.7 GB. For machines with <16 GB RAM, use a lighter model:
> ```bash
> docker-compose exec ollama ollama pull qwen2.5:3b
> ```
> Then set `APP_OLLAMA_MODEL=qwen2.5:3b` in your `.env`.

### 4. Expose your webhook (for local development)

Meta needs a public HTTPS URL to send webhooks. Use [ngrok](https://ngrok.com/):

```bash
ngrok http 8080
```

Copy the `https://xxxx.ngrok.io` URL and configure it in your Meta App:
- **Webhook URL**: `https://xxxx.ngrok.io/webhook`
- **Verify Token**: the value of `APP_WHATSAPP_VERIFY_TOKEN` in your `.env`

### 5. Configure Meta WhatsApp

1. Go to [Meta for Developers](https://developers.facebook.com/apps/)
2. Create or select your app → WhatsApp → API Setup
3. Copy the **Phone Number ID** and **Access Token** into your `.env`
4. Set up the webhook URL (step 4 above)
5. Subscribe to the `messages` webhook field

### 6. Test it

Send a WhatsApp message to your test number. You should get a reply from the AI assistant.

## Services

| Service | Port | Description |
|---|---|---|
| `core-api` | 8080 | Main backend — webhook, agents, API |
| `voice-service` | 8000 | STT + TTS microservice |
| `postgres` | 5432 | Relational database |
| `redis` | 6379 | Celery broker + cache |
| `qdrant` | 6333 | Vector database for RAG |
| `ollama` | 11434 | Local LLM inference |

## Project Structure

```
├── app/                          # Core backend
│   ├── main.py                   # FastAPI entrypoint (port 8080)
│   ├── webhooks/                 # WhatsApp webhook receiver
│   │   ├── routes.py             # GET verify + POST receive
│   │   └── dispatcher.py         # Message routing + orchestration
│   ├── agents/                   # LangGraph multi-agent system
│   │   ├── state.py              # PatientState TypedDict
│   │   ├── graph.py              # StateGraph assembly
│   │   ├── supervisor.py         # Intent classification
│   │   ├── conversation_listener.py
│   │   ├── appointment_scheduler.py
│   │   ├── medicine_tracker.py
│   │   ├── patient_insight.py    # RAG retrieval
│   │   └── clinical_reasoning.py
│   ├── rag/                      # RAG pipeline
│   │   ├── embeddings.py         # BGE-M3 wrapper
│   │   ├── qdrant_store.py       # Vector DB operations
│   │   └── ingest.py             # Text chunking
│   ├── models/                   # PostgreSQL (SQLModel)
│   │   ├── db.py                 # Engine + session
│   │   ├── user.py
│   │   ├── session.py
│   │   ├── message.py
│   │   ├── appointment.py
│   │   ├── prescription.py
│   │   └── doctor_availability.py
│   ├── integrations/             # External service clients
│   │   ├── meta_client.py        # WhatsApp Cloud API
│   │   └── voice_service_client.py
│   ├── tasks/                    # Celery async tasks
│   │   ├── celery_app.py
│   │   ├── reminders.py
│   │   └── ingestion_tasks.py
│   ├── llm/
│   │   └── ollama_client.py      # LangChain Ollama wrapper
│   └── core/
│       ├── config.py             # Settings (pydantic-settings)
│       └── logging.py            # Structured logging
├── voice-service/                # Voice processing (pre-existing)
│   ├── stt/                      # Speech-to-text (faster-whisper)
│   ├── tts/                      # Text-to-speech
│   │   ├── openai_tts.py         # OpenAI adapter (paid)
│   │   └── edge_tts_provider.py  # Edge TTS adapter (free, default)
│   └── ...
├── docker-compose.yml            # Full stack orchestration
├── .env.example                  # Environment variable template
└── README.md                     # This file
```

## Agent Graph

The LangGraph `StateGraph` routes messages through specialized agents:

```
load_history → supervisor → (intent routing)
  ├─ "general"           → conversation_listener → END
  ├─ "appointment"       → appointment_scheduler → END
  ├─ "medicine"          → medicine_tracker → END
  └─ "clinical_question" → patient_insight → clinical_reasoning → END
```

**Supervisor** classifies intent via Ollama with temperature=0 for deterministic routing.

## Database Schema

| Table | Primary Key | Description |
|---|---|---|
| `users` | phone | Patient records |
| `sessions` | UUID | Conversation groupings |
| `messages` | UUID | All inbound/outbound messages |
| `appointments` | UUID | Booked appointments |
| `prescriptions` | UUID | Extracted medications |
| `doctor_availability` | UUID | Available time slots |

## Environment Variables

All core API variables use the `APP_` prefix. Voice service uses the `VOICE_` prefix. See [`.env.example`](.env.example) for the complete list.

## Development

### Run without Docker (local dev)

```bash
# Terminal 1: Core API
cd app
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080 --reload

# Terminal 2: Voice service
cd voice-service
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 3: Celery worker
cd app
celery -A tasks.celery_app worker --loglevel=info
```

You'll also need PostgreSQL, Redis, Qdrant, and Ollama running locally or via Docker.

### Health Checks

```bash
curl http://localhost:8080/health   # Core API
curl http://localhost:8000/health   # Voice service
curl http://localhost:6333/healthz  # Qdrant
curl http://localhost:11434/api/tags # Ollama
```

## License

Internal project — not for distribution.
