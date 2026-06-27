"""
Appointment Scheduler Agent — Books doctor appointments.

Handles the "appointment" intent:
  1. Queries doctor_availability for open slots
  2. Asks Ollama to rank and present 2-3 slots naturally
  3. On confirmation (follow-up message), books the slot

Two-turn flow:
  Turn 1: Patient asks for appointment → present available slots
  Turn 2: Patient confirms a slot → book it and confirm
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlmodel import Session, select

from agents.state import PatientState
from core.logging import get_logger
from llm.ollama_client import get_llm
from models.appointment import Appointment
from models.db import get_engine
from models.doctor_availability import DoctorAvailability

logger = get_logger(__name__)

SLOT_PRESENTATION_PROMPT = """You are a medical appointment scheduler. Present available doctor appointment slots to the patient in a friendly, clear way.

Available slots:
{slots}

Patient's message: {message}

Rules:
- Present 2-3 of the best/most convenient slots
- Format dates and times clearly (e.g., "Tuesday, July 1st at 10:00 AM")
- Keep it brief and friendly
- Ask the patient to confirm which slot they'd like
- If no slots are available, apologize and suggest they check back later
- Don't mention UUIDs or technical details"""

BOOKING_CONFIRM_PROMPT = """You are a medical appointment scheduler. The patient is trying to confirm an appointment.

Available slots:
{slots}

Patient's response: {message}

Determine which slot the patient is choosing based on their response.
Reply with a confirmation message including the exact date and time.
If you can't determine which slot they want, ask them to clarify.

IMPORTANT: Start your response with the slot number (1, 2, or 3) on the first line, then your message on the next line.
If you can't determine the slot, start with 0."""


def appointment_scheduler_node(state: PatientState) -> dict:
    """Handle appointment scheduling requests.

    Args:
        state: Current PatientState.

    Returns:
        Dict update with 'reply_text' set.
    """
    message = state.get("transcript") or state.get("message_text", "")
    phone = state.get("phone", "")

    try:
        engine = get_engine()

        with Session(engine) as db:
            # Get available (unbooked) slots
            now = datetime.now(timezone.utc)
            available_slots = db.exec(
                select(DoctorAvailability)
                .where(DoctorAvailability.is_booked == False)
                .where(DoctorAvailability.slot_start > now)
                .order_by(DoctorAvailability.slot_start)
                .limit(5)
            ).all()

            if not available_slots:
                return {
                    "reply_text": (
                        "I'm sorry, there are no available appointment slots right now. 😔\n\n"
                        "Please check back later or send me a message and I'll notify you "
                        "when new slots open up."
                    )
                }

            # Format slots for the LLM
            slots_text = _format_slots(available_slots)

            # Check if this is a confirmation of a previously shown slot
            # Simple heuristic: if message contains confirmatory language
            is_confirmation = _looks_like_confirmation(message)

            if is_confirmation:
                reply = _handle_booking_confirmation(
                    db, message, available_slots, slots_text, phone
                )
            else:
                reply = _present_slots(message, slots_text)

            return {"reply_text": reply}

    except Exception as exc:
        logger.error("appointment_scheduler_failed", error=str(exc))
        return {
            "reply_text": (
                "I'm having trouble accessing the appointment system right now. "
                "Please try again in a moment. 🙏"
            )
        }


def _format_slots(slots: list[DoctorAvailability]) -> str:
    """Format slots into human-readable text for the LLM."""
    lines = []
    for i, slot in enumerate(slots, 1):
        start = slot.slot_start.strftime("%A, %B %d at %I:%M %p")
        end = slot.slot_end.strftime("%I:%M %p")
        lines.append(f"{i}. {start} - {end}")
    return "\n".join(lines)


def _looks_like_confirmation(message: str) -> bool:
    """Simple heuristic to detect if a message is confirming a slot."""
    lower = message.lower().strip()
    confirmation_signals = [
        "yes", "confirm", "book", "that one", "first", "second", "third",
        "option 1", "option 2", "option 3", "slot 1", "slot 2", "slot 3",
        "1st", "2nd", "3rd", "sounds good", "perfect", "let's go",
        "i'll take", "go ahead",
    ]
    return any(signal in lower for signal in confirmation_signals)


def _present_slots(message: str, slots_text: str) -> str:
    """Present available slots to the patient via LLM."""
    try:
        llm = get_llm()
        prompt = SLOT_PRESENTATION_PROMPT.format(slots=slots_text, message=message)
        response = llm.invoke(prompt)
        return response.content.strip()
    except Exception as exc:
        logger.error("slot_presentation_failed", error=str(exc))
        return f"Here are the available appointment slots:\n\n{slots_text}\n\nWhich one works for you?"


def _handle_booking_confirmation(
    db: Session,
    message: str,
    available_slots: list[DoctorAvailability],
    slots_text: str,
    phone: str,
) -> str:
    """Try to book the slot the patient is confirming."""
    try:
        llm = get_llm()
        prompt = BOOKING_CONFIRM_PROMPT.format(slots=slots_text, message=message)
        response = llm.invoke(prompt)
        reply_lines = response.content.strip().split("\n", 1)

        # Parse slot number from first line
        try:
            slot_num = int(reply_lines[0].strip())
        except (ValueError, IndexError):
            slot_num = 0

        reply_message = reply_lines[1].strip() if len(reply_lines) > 1 else response.content.strip()

        if slot_num > 0 and slot_num <= len(available_slots):
            # Book the slot
            slot = available_slots[slot_num - 1]
            slot.is_booked = True
            db.add(slot)

            # Create appointment record
            appointment = Appointment(
                id=uuid.uuid4(),
                user_phone=phone,
                slot_start=slot.slot_start,
                slot_end=slot.slot_end,
                status="confirmed",
            )
            db.add(appointment)
            db.commit()

            formatted_time = slot.slot_start.strftime("%A, %B %d at %I:%M %p")
            logger.info(
                "appointment_booked",
                phone=phone,
                slot_start=str(slot.slot_start),
                appointment_id=str(appointment.id),
            )

            return (
                f"✅ Your appointment has been confirmed!\n\n"
                f"📅 {formatted_time}\n"
                f"⏱️ Duration: 30 minutes\n\n"
                f"I'll send you a reminder before your appointment. "
                f"If you need to reschedule, just let me know!"
            )
        else:
            return reply_message

    except Exception as exc:
        logger.error("booking_confirmation_failed", error=str(exc))
        return (
            "I couldn't process your booking. Could you please specify "
            "which slot number you'd like? (e.g., 'Slot 1' or 'the first one')"
        )
