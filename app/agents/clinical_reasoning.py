"""
Clinical Reasoning Agent — Produces clinical replies using RAG context.

Handles the "clinical_question" intent AFTER Patient Insight has run.
Takes retrieved_context + history + message_text and generates a reply.

Also exposes a dual-output mode for post-session summaries:
  - Doctor brief: structured clinical summary
  - Patient summary: plain-language recap
"""

from __future__ import annotations

from agents.state import PatientState
from core.logging import get_logger
from llm.ollama_client import get_llm

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

DOCTOR_BRIEF_PROMPT = """You are generating a clinical brief for the doctor. Summarize the consultation in a structured medical format.

Patient history from records:
{context}

Current conversation:
{history}

Format the brief as:
- Chief Complaint:
- Relevant History:
- Key Findings from conversation:
- Current Medications (if mentioned):
- Suggested Follow-up:

Be concise, clinical, and factual. Use medical terminology appropriate for a physician."""

PATIENT_SUMMARY_PROMPT = """You are writing a friendly, clear summary of the consultation for the patient.

Conversation:
{history}

Write a brief, warm summary that:
1. Recaps what was discussed
2. Lists any medications or instructions mentioned
3. Reminds about follow-up appointments if any
4. Uses simple, everyday language
5. Includes relevant emojis for warmth
6. Ends with an encouraging note

Keep it to 4-6 sentences."""


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


def generate_doctor_brief(history: list[dict], context: str | None = None) -> str:
    """Generate a structured clinical brief for the doctor.

    Called post-session (not during the real-time graph flow).

    Args:
        history: Full conversation history.
        context: Retrieved RAG context, if any.

    Returns:
        Structured clinical brief text.
    """
    try:
        llm = get_llm()
        history_text = _format_history(history)
        prompt = DOCTOR_BRIEF_PROMPT.format(
            context=context or "No prior records available.",
            history=history_text,
        )
        response = llm.invoke(prompt)
        return response.content.strip()

    except Exception as exc:
        logger.error("doctor_brief_failed", error=str(exc))
        return "Error generating doctor brief."


def generate_patient_summary(history: list[dict]) -> str:
    """Generate a plain-language consultation summary for the patient.

    Called post-session (not during the real-time graph flow).

    Args:
        history: Full conversation history.

    Returns:
        Patient-friendly summary text.
    """
    try:
        llm = get_llm()
        history_text = _format_history(history)
        prompt = PATIENT_SUMMARY_PROMPT.format(history=history_text)
        response = llm.invoke(prompt)
        return response.content.strip()

    except Exception as exc:
        logger.error("patient_summary_failed", error=str(exc))
        return "Error generating summary."


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
