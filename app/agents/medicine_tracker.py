"""
Medicine Tracker Agent — Extracts prescriptions and schedules reminders.

Handles the "medicine" intent:
  1. Passes message to Ollama with a structured-output prompt
  2. Parses the returned JSON for medication details
  3. Writes each medication to the prescriptions table
  4. Schedules Celery reminder tasks
  5. Confirms what was logged to the patient
"""

from __future__ import annotations

import json
import uuid
from typing import Optional

from sqlmodel import Session

from agents.state import PatientState
from core.logging import get_logger
from llm.ollama_client import get_llm
from models.db import get_engine
from models.prescription import Prescription

logger = get_logger(__name__)

EXTRACTION_PROMPT = """You are a medication extraction assistant. Extract all medications mentioned in the patient's message.

Return ONLY a valid JSON array. Each element must have these fields:
- "drug_name": string (the medication name)
- "dosage": string or null (e.g., "500mg", "10ml")
- "frequency": string or null (e.g., "twice daily", "every 8 hours", "once at night")

If NO medications are mentioned, return an empty array: []

Examples:
- Input: "Doctor prescribed metformin 500mg twice a day and amlodipine 5mg once daily"
  Output: [{"drug_name": "Metformin", "dosage": "500mg", "frequency": "twice daily"}, {"drug_name": "Amlodipine", "dosage": "5mg", "frequency": "once daily"}]

- Input: "I need to take my blood pressure medicine"
  Output: [{"drug_name": "blood pressure medicine", "dosage": null, "frequency": null}]

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
    """Extract medications and log prescriptions.

    Args:
        state: Current PatientState.

    Returns:
        Dict update with 'reply_text' set.
    """
    message = state.get("transcript") or state.get("message_text", "")
    phone = state.get("phone", "")
    msg_type = state.get("message_type", "text")

    try:
        # Step 1: Extract medications via Ollama structured output
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

        # Step 2: Save to database
        engine = get_engine()
        saved_meds = []

        with Session(engine) as db:
            for med in medications:
                prescription = Prescription(
                    id=uuid.uuid4(),
                    user_phone=phone,
                    drug_name=med["drug_name"],
                    dosage=med.get("dosage"),
                    frequency=med.get("frequency"),
                    parsed_from="transcript" if msg_type == "audio" else "text",
                )
                db.add(prescription)
                saved_meds.append(prescription)

            db.commit()

            logger.info(
                "prescriptions_saved",
                phone=phone,
                count=len(saved_meds),
                drugs=[m.drug_name for m in saved_meds],
            )

        # Step 3: Schedule reminders (best-effort, don't fail if Celery is down)
        _schedule_reminders(phone, medications)

        # Step 4: Generate confirmation message
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
    """Extract medication data from the message using Ollama.

    Returns:
        List of dicts with drug_name, dosage, frequency.
        Empty list if no medications found or extraction fails.
    """
    try:
        llm = get_llm()
        response = llm.invoke(EXTRACTION_PROMPT.format(message=message))
        raw_text = response.content.strip()

        # Try to extract JSON from the response
        # Handle cases where the LLM wraps JSON in markdown code blocks
        if "```json" in raw_text:
            raw_text = raw_text.split("```json")[1].split("```")[0].strip()
        elif "```" in raw_text:
            raw_text = raw_text.split("```")[1].split("```")[0].strip()

        medications = json.loads(raw_text)

        if not isinstance(medications, list):
            logger.warning("medication_extraction_not_list", raw=raw_text[:200])
            return []

        # Validate each entry has at least drug_name
        valid_meds = [
            m for m in medications
            if isinstance(m, dict) and m.get("drug_name")
        ]

        logger.info(
            "medications_extracted",
            count=len(valid_meds),
            drugs=[m["drug_name"] for m in valid_meds],
        )

        return valid_meds

    except (json.JSONDecodeError, Exception) as exc:
        logger.warning("medication_extraction_failed", error=str(exc))
        return []


def _schedule_reminders(phone: str, medications: list[dict]) -> None:
    """Schedule Celery reminder tasks for each medication.

    Best-effort — failures are logged but don't block the response.
    """
    try:
        from tasks.reminders import send_medicine_reminder

        for med in medications:
            # Schedule a single reminder for now
            # Full beat scheduling will be added when Celery beat is wired
            send_medicine_reminder.delay(
                phone=phone,
                drug_name=med["drug_name"],
                dosage=med.get("dosage", "as prescribed"),
            )
            logger.info(
                "reminder_scheduled",
                phone=phone,
                drug=med["drug_name"],
            )

    except Exception as exc:
        logger.warning(
            "reminder_scheduling_failed",
            error=str(exc),
            note="Celery may not be running — reminders will not be sent",
        )


def _generate_confirmation(medications: list[dict]) -> str:
    """Generate a friendly confirmation message for logged medications."""
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
