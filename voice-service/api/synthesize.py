"""
Synthesize Router — POST /api/v1/voice/respond

Thin router that:
  1. Validates the incoming request via Pydantic schema
  2. Maps API schema → application DTO
  3. Calls RespondUseCase.execute()
  4. Maps application DTO → API response schema
  5. Returns 200 with RespondResponse
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from application.dto import RespondInput
from application.respond_usecase import RespondUseCase
from core.schemas import RespondRequest, RespondResponse

router = APIRouter(prefix="/api/v1/voice", tags=["Voice - Synthesis"])


def get_respond_usecase() -> RespondUseCase:
    """Dependency injection stub — overridden in main.py at startup."""
    raise NotImplementedError(
        "RespondUseCase dependency not configured. "
        "Ensure main.py wires the dependency override."
    )


@router.post(
    "/respond",
    response_model=RespondResponse,
    status_code=200,
    summary="Convert text to voice",
    description=(
        "Converts the provided text to a voice audio file (.ogg) "
        "using the specified voice and language. Returns a URL "
        "to download the generated audio."
    ),
    responses={
        422: {"description": "Unprocessable — invalid input"},
        500: {"description": "Internal server error — TTS or encoding failed"},
    },
)
def respond(
    request: RespondRequest,
    usecase: RespondUseCase = Depends(get_respond_usecase),
) -> RespondResponse:
    """Generate a voice response from text."""
    # Map API schema → internal DTO
    input_dto = RespondInput(
        text=request.text,
        language=request.language,
        voice=request.voice,
    )

    # Execute pipeline
    output = usecase.execute(input_dto)

    # Map internal DTO → API response schema
    return RespondResponse(
        voice_url=output.voice_url,
        format=output.format,
    )
