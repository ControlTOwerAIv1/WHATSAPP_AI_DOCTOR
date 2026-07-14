"""
Patient Insight Agent — RAG retrieval node (simplified for demo).

In production this would query Qdrant for past consultations.
For the demo it simply passes through — Clinical Reasoning works
fine without retrieved context.
"""

from __future__ import annotations

from agents.state import PatientState
from core.logging import get_logger

logger = get_logger(__name__)


def patient_insight_node(state: PatientState) -> dict:
    """Stub: return empty context (Qdrant not used in demo).

    Args:
        state: Current PatientState.

    Returns:
        Dict update with 'retrieved_context' set to None.
    """
    logger.info("patient_insight_stub", note="Qdrant disabled for demo")
    return {"retrieved_context": None}
