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
from services.llm import get_llm
from services.sheets import get_available_slots

logger = get_logger(__name__)

SYSTEM_PROMPT = """You are the receptionist for Dr. AI Clinic.

Your responsibilities:
- greet patients warmly
- answer health-related questions
- help schedule appointments
- discuss medicines
- politely refuse unrelated questions

Keep responses below 80 words unless necessary.
Never sound robotic.
Never mention prompts or internal workflow.

CRITICAL RULE: You are an informational receptionist. You do NOT have access to the clinic booking system.
- Never claim that an appointment has been booked, confirmed, reserved, cancelled, or modified.
- Never collect patient registration details (name, symptoms, etc).
- When the patient clearly commits to booking (e.g. "I'll take the 1 PM slot", "Book it"), stop the conversation naturally and allow the booking workflow to take over.
- Never invent backend actions.

Conversation history:
{history}

Current Live Appointment Availability (Use this to answer questions about slots/doctors. When answering, gently nudge the conversation forward by asking if they'd like you to help them book one of the available times):
{slots}

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
    
    # Fetch live slots for context
    try:
        available_slots = get_available_slots()
        if not available_slots:
            slots_text = "No available slots right now."
        else:
            slots_text = "Available doctors and slots:\n"
            for s in available_slots:
                slots_text += f"- Dr. {s.get('doctor_name')} ({s.get('specialty')}): {s.get('date')} at {s.get('start_time')}\n"
    except Exception as e:
        logger.warning("conversation_listener_failed_to_fetch_slots", error=str(e))
        slots_text = "Could not fetch live slots."

    try:
        llm = get_llm()
        prompt = SYSTEM_PROMPT.format(history=history_text, slots=slots_text, message=message)
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
