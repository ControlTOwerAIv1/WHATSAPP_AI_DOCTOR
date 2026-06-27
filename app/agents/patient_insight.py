"""
Patient Insight Agent — RAG retrieval node.

Runs before Clinical Reasoning when intent is "clinical_question".
Embeds the patient's query, searches Qdrant for relevant past
consultations and history, and attaches results to state.

This agent does NOT generate a reply — it only enriches the state
with retrieved context for the Clinical Reasoning agent to use.
"""

from __future__ import annotations

from agents.state import PatientState
from core.logging import get_logger

logger = get_logger(__name__)


def patient_insight_node(state: PatientState) -> dict:
    """Retrieve relevant patient history from Qdrant.

    Args:
        state: Current PatientState with message_text/transcript and phone.

    Returns:
        Dict update with 'retrieved_context' set.
    """
    query = state.get("transcript") or state.get("message_text", "")
    phone = state.get("phone", "")

    if not query.strip():
        logger.warning("patient_insight_empty_query")
        return {"retrieved_context": None}

    try:
        from rag.qdrant_store import QdrantStore

        store = QdrantStore()
        chunks = store.search(phone=phone, query=query, top_k=3)

        if not chunks:
            logger.info("patient_insight_no_results", phone=phone)
            return {"retrieved_context": None}

        # Format retrieved chunks as context
        context_parts = []
        for i, chunk in enumerate(chunks, 1):
            context_parts.append(f"[Past record {i}]: {chunk}")

        retrieved_context = "\n\n".join(context_parts)

        logger.info(
            "patient_insight_retrieved",
            phone=phone,
            chunks_found=len(chunks),
            context_length=len(retrieved_context),
        )

        return {"retrieved_context": retrieved_context}

    except Exception as exc:
        logger.error("patient_insight_failed", error=str(exc))
        # Don't block the pipeline — Clinical Reasoning can work without RAG
        return {"retrieved_context": None}
