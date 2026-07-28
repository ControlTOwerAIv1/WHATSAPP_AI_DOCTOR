"""
Clinical Reasoning Agent — Produces clinical replies using RAG context.

Handles the "clinical_question" intent AFTER Patient Insight has run.
Takes retrieved_context + history + message_text and generates a reply.
"""

from __future__ import annotations

from agents.state import PatientState
from core.logging import get_logger
from services.llm import get_llm

logger = get_logger(__name__)

CLINICAL_SYSTEM_PROMPT = """You are a knowledgeable medical AI assistant on WhatsApp. A patient is asking a health-related question.

{context_section}

Conversation history:
{history}

Guidelines:
- Provide accurate, helpful medical information based on the patient's history and current question
- If past records are available, reference them naturally (e.g., "Based on your previous visit...")
- Use simple, patient-friendly language
- Keep responses concise but thorough (3-6 sentences)
- If the question involves a serious or urgent condition, advise seeing a doctor
- NEVER diagnose — provide general information and suggest professional consultation
- If you reference past history, be specific about what you found
- End with a helpful follow-up prompt

Patient's question: {message}"""


def clinical_reasoning_node(state: PatientState) -> dict:
    """Generate a clinical reply using RAG context and conversation history.

    Args:
        state: Current PatientState with retrieved_context, history, message.

    Returns:
        Dict update with 'reply_text' set.
    """
    message = state.get("transcript") or state.get("message_text", "")
    history = state.get("history", [])
    retrieved_context = state.get("retrieved_context")

    # Build context section
    if retrieved_context:
        context_section = f"Relevant past records for this patient:\n{retrieved_context}"
    else:
        context_section = "No past records available for this patient."

    # Format history
    history_text = _format_history(history)

    try:
        llm = get_llm()
        prompt = CLINICAL_SYSTEM_PROMPT.format(
            context_section=context_section,
            history=history_text,
            message=message,
        )
        response = llm.invoke(prompt)
        reply = response.content.strip()

        logger.info(
            "clinical_reasoning_reply",
            reply_length=len(reply),
            has_rag_context=retrieved_context is not None,
        )

        return {"reply_text": reply}

    except Exception as exc:
        logger.error("clinical_reasoning_failed", error=str(exc))
        return {
            "reply_text": (
                "I'm having trouble processing your health question right now. "
                "For any urgent concerns, please contact your doctor directly. 🙏"
            )
        }


def _format_history(history: list[dict]) -> str:
    """Format message history for LLM context."""
    if not history:
        return "No previous conversation history."

    lines = []
    for msg in history[-15:]:  # Last 15 messages
        direction = "Patient" if msg.get("direction") == "in" else "Dr. AI"
        content = msg.get("content", "")
        lines.append(f"{direction}: {content}")

    return "\n".join(lines)
