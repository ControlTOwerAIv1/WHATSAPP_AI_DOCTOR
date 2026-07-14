"""
Medicine Tracker Agent — Extracts prescriptions from messages (demo version).

Handles the "medicine" intent:
  1. Passes message to Claude with a structured-output prompt
  2. Parses the returned JSON for medication details
  3. Returns a confirmation to the patient (in-memory only — no DB)

In production, this would persist to a database and schedule Celery
reminder tasks.
"""

from __future__ import annotations

import json

from agents.state import PatientState
from core.logging import get_logger
from services.llm import get_llm

logger = get_logger(__name__)

EXTRACTION_PROMPT = """You are a medication extraction assistant. Extract all medications mentioned in the patient's message.

Return ONLY a valid JSON array. Each element must have these fields:
- "drug_name": string (the medication name)
- "dosage": string or null (e.g., "500mg", "10ml")
- "frequency": string or null (e.g., "twice daily", "every 8 hours", "once at night")

If NO medications are mentioned, return an empty array: []

Examples:
- Input: "Doctor prescribed metformin 500mg twice a day and amlodipine 5mg once daily"
  Output: [{{"drug_name": "Metformin", "dosage": "500mg", "frequency": "twice daily"}}, {{"drug_name": "Amlodipine", "dosage": "5mg", "frequency": "once daily"}}]

- Input: "I need to take my blood pressure medicine"
  Output: [{{"drug_name": "blood pressure medicine", "dosage": null, "frequency": null}}]

- Input: "When is my next appointment?"
  Output: []

Patient's message: {message}

Return ONLY the JSON array, no other text:"""

CONFIRMATION_PROMPT = """You are a friendly medical assistant. The patient just told you about their medications and you've logged them.

Medications logged:
{medications}

Write a brief, warm confirmation message that:
1. Lists each medication with its dosage and frequency
2. Lets them know you'll send reminders
3. Asks if the details are correct
4. Uses simple language and a friendly tone

Keep it concise (3-5 sentences max)."""


def medicine_tracker_node(state: PatientState) -> dict:
    """Extract medications and confirm to the patient.

    Args:
        state: Current PatientState.

    Returns:
        Dict update with 'reply_text' set.
    """
    message = state.get("transcript") or state.get("message_text", "")

    try:
        medications = _extract_medications(message)

        if not medications:
            return {
                "reply_text": (
                    "I couldn't identify any specific medications in your message. 🤔\n\n"
                    "Could you please tell me the medication name, dosage, and how often "
                    "you need to take it? For example:\n"
                    '"Metformin 500mg twice a day"'
                )
            }

        logger.info(
            "medications_extracted",
            count=len(medications),
            drugs=[m["drug_name"] for m in medications],
        )

        reply = _generate_confirmation(medications)
        return {"reply_text": reply}

    except Exception as exc:
        logger.error("medicine_tracker_failed", error=str(exc))
        return {
            "reply_text": (
                "I had trouble processing your medication information. "
                "Could you please try again? 🙏"
            )
        }


def _extract_medications(message: str) -> list[dict]:
    """Extract medication data from the message using Claude."""
    try:
        llm = get_llm()
        response = llm.invoke(EXTRACTION_PROMPT.format(message=message))
        raw_text = response.content.strip()

        # Handle markdown code blocks
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0].strip()
        elif "```" in raw_text:
            raw_text = raw_text.split("```")[1].split("```")[0].strip()

        medications = json.loads(raw_text)

        if not isinstance(medications, list):
            return []

        return [m for m in medications if isinstance(m, dict) and m.get("drug_name")]

    except (json.JSONDecodeError, Exception) as exc:
        logger.warning("medication_extraction_failed", error=str(exc))
        return []


def _generate_confirmation(medications: list[dict]) -> str:
    """Generate a friendly confirmation message for extracted medications."""
    try:
        meds_text = "\n".join(
            f"- {m['drug_name']}"
            + (f" {m['dosage']}" if m.get("dosage") else "")
            + (f", {m['frequency']}" if m.get("frequency") else "")
            for m in medications
        )

        llm = get_llm()
        prompt = CONFIRMATION_PROMPT.format(medications=meds_text)
        response = llm.invoke(prompt)
        return response.content.strip()

    except Exception:
        # Fallback: manual confirmation without LLM
        lines = ["✅ I've logged the following medications:\n"]
        for med in medications:
            line = f"💊 {med['drug_name']}"
            if med.get("dosage"):
                line += f" — {med['dosage']}"
            if med.get("frequency"):
                line += f" ({med['frequency']})"
            lines.append(line)
        lines.append("\nI'll send you reminders! Let me know if anything needs correcting. 😊")
        return "\n".join(lines)
