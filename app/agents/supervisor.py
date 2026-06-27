"""
Supervisor Node — Intent classification for routing.

Classifies the user's message into one of:
  - general          → Conversation Listener
  - appointment      → Appointment Scheduler
  - medicine         → Medicine Tracker
  - clinical_question → Patient Insight → Clinical Reasoning

Uses a fast Ollama call with temperature=0 for deterministic classification.
"""

from __future__ import annotations

from agents.state import PatientState
from core.logging import get_logger
from llm.ollama_client import get_fast_llm

logger = get_logger(__name__)

CLASSIFICATION_PROMPT = """You are an intent classifier for a medical AI assistant on WhatsApp.

Classify the following patient message into exactly ONE category:

- "general" — casual greetings, small talk, general questions, or anything that doesn't fit the other categories
- "appointment" — scheduling, rescheduling, cancelling appointments, asking about available slots or timings
- "medicine" — mentions of medications, prescriptions, dosages, drug names, refills, or medicine-related instructions
- "clinical_question" — medical symptoms, health concerns, diagnosis questions, lab results, treatment queries, follow-up on conditions

Respond with ONLY the category name, nothing else. No explanation, no punctuation.

Patient message: {message}"""


def supervisor_node(state: PatientState) -> dict:
    """Classify intent and route to the appropriate agent.

    Args:
        state: Current PatientState with message_text or transcript.

    Returns:
        Dict update with 'intent' and 'current_agent' fields set.
    """
    message = state.get("transcript") or state.get("message_text", "")

    if not message.strip():
        logger.warning("supervisor_empty_message")
        return {"intent": "general", "current_agent": "conversation_listener"}

    try:
        llm = get_fast_llm()
        response = llm.invoke(CLASSIFICATION_PROMPT.format(message=message))
        raw_intent = response.content.strip().lower().replace('"', "").replace("'", "")

        # Normalize to valid intents
        valid_intents = {"general", "appointment", "medicine", "clinical_question"}
        intent = raw_intent if raw_intent in valid_intents else "general"

        # Map intent → agent name
        agent_map = {
            "general": "conversation_listener",
            "appointment": "appointment_scheduler",
            "medicine": "medicine_tracker",
            "clinical_question": "patient_insight",
        }

        current_agent = agent_map[intent]

        logger.info(
            "intent_classified",
            raw_intent=raw_intent,
            normalized_intent=intent,
            current_agent=current_agent,
            message_preview=message[:80],
        )

        return {"intent": intent, "current_agent": current_agent}

    except Exception as exc:
        logger.error("supervisor_classification_failed", error=str(exc))
        # Fallback to general on any error
        return {"intent": "general", "current_agent": "conversation_listener"}
