"""
Conversation Listener Agent — Default/fallback agent for general chat.

Handles the "general" intent: casual greetings, triage questions,
general health information, and anything that doesn't fit the
specialized agents.

This is the agent most patients will interact with most often.
"""

from __future__ import annotations

from agents.state import PatientState
from core.logging import get_logger
from llm.ollama_client import get_llm

logger = get_logger(__name__)

SYSTEM_PROMPT = """You are a friendly, professional AI health assistant on WhatsApp called "Dr. AI".

Your role:
- Greet patients warmly and make them feel comfortable
- Answer general health questions with accurate, helpful information
- Triage: if a patient describes serious symptoms, advise them to see a doctor promptly
- Help patients navigate the system (appointments, medicine tracking)
- Keep responses concise (2-4 sentences for simple questions, more for detailed explanations)
- Use simple language — patients may not understand medical jargon
- Use appropriate emojis sparingly to keep the tone warm 😊
- Always end with a helpful prompt (e.g., "Would you like to book an appointment?" or "Is there anything else I can help with?")

Important:
- You are NOT a replacement for a real doctor. Always make this clear for serious medical questions.
- Never diagnose conditions. You can provide general health information.
- If a patient mentions an emergency (chest pain, difficulty breathing, severe bleeding), tell them to call emergency services immediately.

Conversation history:
{history}

Patient's message: {message}"""


def conversation_listener_node(state: PatientState) -> dict:
    """Handle general conversation with the patient.

    Args:
        state: Current PatientState.

    Returns:
        Dict update with 'reply_text' set.
    """
    message = state.get("transcript") or state.get("message_text", "")
    history = state.get("history", [])

    # Format history for context
    history_text = _format_history(history)

    try:
        llm = get_llm()
        prompt = SYSTEM_PROMPT.format(history=history_text, message=message)
        response = llm.invoke(prompt)
        reply = response.content.strip()

        logger.info(
            "conversation_listener_reply",
            reply_length=len(reply),
            message_preview=message[:60],
        )

        return {"reply_text": reply}

    except Exception as exc:
        logger.error("conversation_listener_failed", error=str(exc))
        return {
            "reply_text": (
                "I'm sorry, I'm having a bit of trouble right now. "
                "Could you try sending your message again? 🙏"
            )
        }


def _format_history(history: list[dict]) -> str:
    """Format recent message history for the LLM context window."""
    if not history:
        return "No previous conversation history."

    lines = []
    for msg in history[-10:]:  # Last 10 messages max
        direction = "Patient" if msg.get("direction") == "in" else "Dr. AI"
        content = msg.get("content", "")
        lines.append(f"{direction}: {content}")

    return "\n".join(lines)
