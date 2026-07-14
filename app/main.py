"""
WhatsApp AI Doctor — Core Backend FastAPI Application.

This is the main entrypoint for the core backend service.

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
from webhooks.routes import router as meta_webhook_router
from webhooks.twilio_webhook import router as twilio_router

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management.

    Startup:
      - Initialize structured logging
      - Verify Google Sheets connection (best-effort)
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
    )

    # Best-effort: test Google Sheets connection
    try:
        from services.sheets import get_available_slots
        slots = get_available_slots()
        logger.info("sheets_connection_ok", available_slots=len(slots))
    except Exception as exc:
        logger.warning(
            "sheets_connection_failed",
            error=str(exc),
            note="Google Sheets is not reachable — check credentials and sheet ID",
        )

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
    version="0.2.0",
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

# Meta Cloud API webhooks (kept for future production use)
app.include_router(meta_webhook_router)

# Twilio WhatsApp Sandbox webhook (primary for demo)
app.include_router(twilio_router)


# ── Health Check ─────────────────────────────────────────────────────

@app.get("/health", tags=["Health"])
async def health():
    """Simple liveness probe."""
    return {"status": "healthy", "service": "core-backend", "version": "0.2.0"}
