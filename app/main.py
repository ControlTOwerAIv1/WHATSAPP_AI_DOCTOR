"""
WhatsApp AI Doctor — Core Backend FastAPI Application.

This is the main entrypoint for the core backend service.
Runs on port 8080 alongside voice-service on port 8000.

Usage:
    uvicorn main:app --host 0.0.0.0 --port 8080 --reload
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.config import get_settings
from core.logging import get_logger, setup_logging
from models.db import init_db
from webhooks.routes import router as webhook_router

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management.

    Startup:
      - Initialize structured logging
      - Create database tables and seed data
      - Log configuration summary

    Shutdown:
      - Log shutdown
    """
    config = get_settings()

    # Initialize logging
    json_output = config.environment != "development"
    setup_logging(log_level=config.log_level, json_output=json_output)

    logger.info(
        "core_service_starting",
        environment=config.environment,
        ollama_model=config.ollama_model,
        database_url=config.database_url.split("@")[-1] if "@" in config.database_url else "configured",
    )

    # Initialize database
    try:
        init_db()
        logger.info("database_initialized")
    except Exception as exc:
        logger.error("database_init_failed", error=str(exc))
        # Don't crash on DB failure — allows health checks to report status
        # The service can still start and retry DB connections per-request

    logger.info("core_service_ready", port=8080)

    yield

    logger.info("core_service_shutting_down")


# ── Application Factory ──────────────────────────────────────────────

app = FastAPI(
    title="WhatsApp AI Doctor — Core Backend",
    description=(
        "Multi-agent AI healthcare assistant on WhatsApp. "
        "Handles consultations, appointments, prescriptions, "
        "and medicine reminders through a LangGraph agent system."
    ),
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)


# ── CORS Middleware ───────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Exception Handlers ───────────────────────────────────────────────

@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all for unexpected exceptions."""
    logger.exception(
        "unhandled_exception",
        error_type=type(exc).__name__,
        message=str(exc),
    )
    return JSONResponse(
        status_code=500,
        content={
            "error": "InternalServerError",
            "message": "An unexpected error occurred.",
        },
    )


# ── Router Registration ──────────────────────────────────────────────

app.include_router(webhook_router)


# ── Health Check ─────────────────────────────────────────────────────

@app.get("/health", tags=["Health"])
async def health():
    """Simple liveness probe."""
    return {"status": "healthy", "service": "core-backend"}
