"""
Transcript Router — POST /api/v1/voice/transcribe

Thin router that:
  1. Validates the incoming request via Pydantic schema
  2. Maps API schema → application DTO
  3. Calls TranscribeUseCase.execute()
  4. Maps application DTO → API response schema
  5. Returns 200 with TranscribeResponse

No business logic lives here. The router is a shell.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from application.dto import TranscribeInput
from application.transcribe_usecase import TranscribeUseCase
from core.schemas import (
    TimestampSchema,
    TranscribeRequest,
    TranscribeResponse,
)

router = APIRouter(prefix="/api/v1/voice", tags=["Voice - Transcription"])


def get_transcribe_usecase() -> TranscribeUseCase:
    """Dependency injection stub — overridden in main.py at startup."""
    raise NotImplementedError(
        "TranscribeUseCase dependency not configured. "
        "Ensure main.py wires the dependency override."
    )


@router.post(
    "/transcribe",
    response_model=TranscribeResponse,
    status_code=200,
    summary="Transcribe audio to text",
    description=(
        "Downloads audio from the provided URL, normalizes it, "
        "runs speech-to-text, optionally translates the transcript, "
        "and returns the result with timestamps and confidence."
    ),
    responses={
        400: {"description": "Bad request — invalid input"},
        408: {"description": "Request timeout — audio download timed out"},
        422: {"description": "Unprocessable — audio validation failed"},
        500: {"description": "Internal server error"},
    },
)
def transcribe(
    request: TranscribeRequest,
    usecase: TranscribeUseCase = Depends(get_transcribe_usecase),
) -> TranscribeResponse:
    """Transcribe audio from a URL to text with optional translation."""
    # Map API schema → internal DTO
    input_dto = TranscribeInput(
        audio_url=request.audio_url,
        patient_id=request.patient_id,
        session_id=request.session_id,
    )

    # Execute pipeline
    output = usecase.execute(input_dto)

    # Map internal DTO → API response schema
    return TranscribeResponse(
        transcript=output.transcript,
        detected_language=output.detected_language,
        translated_text=output.translated_text,
        timestamps=[
            TimestampSchema(
                start=ts["start"],
                end=ts["end"],
                text=ts["text"],
            )
            for ts in output.timestamps
        ],
        confidence=output.confidence,
    )
