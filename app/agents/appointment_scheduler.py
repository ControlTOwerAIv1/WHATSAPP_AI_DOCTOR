"""
Appointment Scheduler Agent — Books doctor appointments via Google Sheets.

Handles the "appointment" intent with a two-turn flow:
  Turn 1: Patient asks for appointment → query Sheets → Claude ranks
          2-3 slots considering urgency/symptoms → present options
  Turn 2: Patient confirms → Claude resolves the choice → book via Sheets
          → send confirmation with doctor name, time, booking ref

Urgency logic:
  If patient mentions urgent symptoms (chest pain, bleeding, high fever,
  difficulty breathing), rank by earliest available slot.  Otherwise,
  respect patient time preferences if stated, or present in chronological
  order.
"""

from __future__ import annotations

import json
from agents.state import PatientState
from core.logging import get_logger
from services.llm import get_llm
from services.sheets import book_slot, get_available_slots

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

SLOT_PRESENTATION_PROMPT = """You are a medical appointment scheduler. Present available doctor appointment slots to the patient in a friendly, clear way.

Available slots (from the system — these are the ONLY real slots, do not invent any):
{slots}

Patient's message: {message}

{urgency_instruction}

If the patient initially requested a specific doctor, date, or time (Initial request: {initial_request}), you MUST prioritize matching slots from the list below if they exist.

Rules:
- Present 2-3 of the best slots as numbered options (1, 2, 3)
- DIVERSITY RULE: Unless the patient explicitly asks for a specific doctor, you MUST offer slots from DIFFERENT doctors or at significantly different times of the day. Do not just list 3 slots from the exact same doctor back-to-back.
- Include the doctor's name, specialty, date, and time for each
- Format dates clearly (e.g., "Thursday, July 3rd at 10:00 AM")
- HIDDEN ID RULE: Do NOT show the internal `[ID:...]` tags to the patient. Keep those hidden.
- Keep it extremely brief to save tokens
- Ask the patient to reply with the option number to confirm
- If no slots are available, apologize and suggest checking back later
- NEVER invent slots that aren't in the list above"""

BOOKING_CONFIRM_PROMPT = """You are a medical appointment scheduler. The patient is confirming which slot they want.

Slots that were offered to the patient:
{slots}

Patient's response: {message}

Determine which slot the patient is choosing. They might say "1", "option 2", "the Tuesday one", "the morning slot", "Dr. Patel's slot", etc.

CRITICAL: Reply with ONLY the option number (1, 2, or 3) on the first line. Nothing else.
If you truly cannot determine which slot, reply with 0."""


NAME_VALIDATION_PROMPT = """You are a medical receptionist validating patient input.
The patient was asked for their full name.

Patient's response: "{message}"

Does this string look like a plausible human name?
Return ONLY valid JSON in the following format:
{{
  "valid": true/false,
  "name": "Extracted name (if valid) or null",
  "reason": "Brief reason if invalid, or null"
}}"""


CONDITION_VALIDATION_PROMPT = """You are a medical receptionist validating patient input.
The patient was asked to briefly describe their symptoms or reason for visit.

Patient's response: "{message}"

Does this string describe a plausible medical condition, symptom, or reason for a doctor's visit?
Return ONLY valid JSON in the following format:
{{
  "valid": true/false,
  "condition": "Extracted condition (if valid) or null",
  "reason": "Brief reason if invalid, or null"
}}"""


from services.session_store import update_session, clear_session

# ---------------------------------------------------------------------------
# Main node
# ---------------------------------------------------------------------------

def appointment_scheduler_node(state: PatientState) -> dict:
    """Handle appointment scheduling requests via FSM.

    States:
      - start / None (new request)
      - waiting_for_name
      - waiting_for_condition
      - waiting_for_slot
    """
    message = state.get("transcript") or state.get("message_text", "")
    phone = state.get("phone", "")
    
    stage = state.get("appointment_stage") or "start"
    name = state.get("patient_name")
    condition = state.get("patient_condition")
    offered = state.get("offered_slots")
    initial_request = state.get("initial_request")

    # Global escape hatch
    message_lower = message.lower().strip()
    if message_lower in ["cancel", "restart", "start over", "new appointment", "never mind"]:
        clear_session(phone)
        try:
            llm = get_llm()
            cancel_prompt = f"""You are the receptionist of Dr AI. The patient just cancelled their current booking by saying "{message}".
Acknowledge the cancellation naturally and ask how else you can help them today.
Keep it under 2 sentences."""
            return {"reply_text": llm.invoke(cancel_prompt).content.strip()}
        except:
            return {"reply_text": "No problem. I've cancelled the current booking. How can I help you today?"}

    try:
        if stage == "start":
            # Just started, save their initial request (e.g. "I'll take the 4 PM slot") and ask for name
            update_session(phone, stage="waiting_for_name", initial_request=message)
            try:
                llm = get_llm()
                prompt = f"""You are the receptionist of Dr AI. A patient just entered the booking flow by saying: "{message}".
Politely and warmly acknowledge their choice (e.g. "Certainly, I can help you book that."), and then ask for their full name to get started. 
Keep it under 2 sentences."""
                reply = llm.invoke(prompt).content.strip()
            except:
                reply = "Certainly! Before I reserve that appointment, may I have your full name?"
            return {"reply_text": reply}

        elif stage == "waiting_for_name":
            name_failures = state.get("name_failures", 0)
            val = _validate_name(message)
            
            if val.get("valid") or name_failures >= 2:
                # Accept if valid or if they failed 2 times already
                name = val.get("name") or message.strip()
                update_session(phone, stage="waiting_for_condition", name=name, name_failures=0)
                try:
                    llm = get_llm()
                    prompt = f"You are the receptionist of Dr AI. The patient just provided their name: {name}. Thank them naturally and ask them to briefly describe their symptoms or reason for visit. Keep it under 2 sentences."
                    reply = llm.invoke(prompt).content.strip()
                except:
                    reply = f"Thank you, {name}. Could you briefly describe the reason for your visit or your symptoms?"
                return {"reply_text": reply}
            else:
                # Invalid name
                new_failures = name_failures + 1
                update_session(phone, name_failures=new_failures)
                return {"reply_text": _generate_natural_reprompt("full name", message)}

        elif stage == "waiting_for_condition":
            cond_failures = state.get("condition_failures", 0)
            val = _validate_condition(message)
            
            if val.get("valid") or cond_failures >= 2:
                condition = val.get("condition") or message.strip()
                update_session(phone, condition=condition, condition_failures=0)
            else:
                # Invalid condition
                new_failures = cond_failures + 1
                update_session(phone, condition_failures=new_failures)
                return {"reply_text": _generate_natural_reprompt("medical symptoms or reason for visit", message)}
            
            # Fetch slots (only reached if valid or bypassed)
            available = get_available_slots()
            if not available:
                clear_session(phone)
                return {
                    "reply_text": (
                        "I'm sorry, there are no available appointment slots right now. 😔\n\n"
                        "Please check back later."
                    )
                }

            # Present slots
            urgency = _detect_urgency(condition)
            diverse = _pick_diverse_slots(available, count=3, urgent=urgency)
            slots_for_llm = _format_slots_for_llm(diverse)
            reply = _present_slots(condition, slots_for_llm, urgency, initial_request)

            update_session(phone, stage="waiting_for_slot", offered_slots=diverse)
            return {"reply_text": reply}

        elif stage == "waiting_for_slot":
            # Message is the slot choice
            reply = _handle_booking_confirmation(message, offered, phone, name, condition)
            
            # Clear session only if booking was confirmed successfully
            if "✅" in reply:
                clear_session(phone)
            return {"reply_text": reply}

    except Exception as exc:
        logger.error("appointment_scheduler_failed", error=str(exc))
        clear_session(phone)
        return {
            "reply_text": "I'm having trouble accessing the appointment system right now. Please try again in a moment. 🙏"
        }


# ---------------------------------------------------------------------------
# Slot presentation
# ---------------------------------------------------------------------------

def _generate_natural_reprompt(missing_field: str, message: str) -> str:
    """Generate a natural conversational prompt for missing info using the LLM."""
    try:
        llm = get_llm()
        prompt = f"""You are the receptionist of Dr AI.
The patient is currently booking an appointment.
We are waiting for them to provide their {missing_field}.
They just said: "{message}"

Politely greet them back (if applicable) and steer the conversation back toward collecting their {missing_field}.
Do NOT discuss unrelated topics. Keep it under 2 sentences and natural."""
        response = llm.invoke(prompt)
        return response.content.strip()
    except Exception as exc:
        logger.error("reprompt_generation_failed", error=str(exc))
        return f"Please provide your {missing_field} so we can continue booking your appointment."

def _format_slots_for_llm(slots: list[dict]) -> str:
    """Format slot dicts into numbered text for the LLM prompt.

    NOTE: Internal slot IDs are deliberately excluded so the LLM
    cannot leak them into the patient-facing reply.
    """
    lines = []
    for i, s in enumerate(slots, 1):
        doctor = s.get("doctor_name", "Doctor")
        specialty = s.get("specialty", "")
        date = s.get("date", "")
        start = s.get("start_time", "")
        end = s.get("end_time", "")
        line = f"{i}. Dr. {doctor} ({specialty}) - {date} at {start}"
        lines.append(line)
    return "\n".join(lines)


def _pick_diverse_slots(
    slots: list[dict], count: int = 3, urgent: bool = False
) -> list[dict]:
    """Pick *count* slots from different doctors when possible.

    If urgent, sorts by date+time first (earliest wins).
    Round-robins across doctors so the patient sees variety.
    """
    if urgent:
        slots = sorted(slots, key=lambda s: (s.get("date", ""), s.get("start_time", "")))

    picked: list[dict] = []
    seen_doctors: set[str] = set()

    # First pass: one slot per doctor
    for s in slots:
        if len(picked) >= count:
            break
        doc = s.get("doctor_name", "")
        if doc not in seen_doctors:
            picked.append(s)
            seen_doctors.add(doc)

    # Second pass: fill remaining from any doctor if we don't have enough
    if len(picked) < count:
        for s in slots:
            if len(picked) >= count:
                break
            if s not in picked:
                picked.append(s)

    return picked


def _clean_json_response(content: str) -> str:
    """Remove markdown code blocks from LLM response."""
    content = content.strip()
    if content.startswith("```json"):
        content = content[7:]
    elif content.startswith("```"):
        content = content[3:]
    if content.endswith("```"):
        content = content[:-3]
    return content.strip()

def _validate_name(message: str) -> dict:
    """Validate if the string is a plausible human name using LLM."""
    try:
        llm = get_llm()
        prompt = NAME_VALIDATION_PROMPT.format(message=message)
        response = llm.invoke(prompt)
        cleaned = _clean_json_response(response.content)
        return json.loads(cleaned)
    except Exception as exc:
        logger.error("name_validation_failed", error=str(exc))
        return {"valid": False, "reason": "Validation service error"}


def _validate_condition(message: str) -> dict:
    """Validate if the string is a plausible condition using LLM."""
    try:
        llm = get_llm()
        prompt = CONDITION_VALIDATION_PROMPT.format(message=message)
        response = llm.invoke(prompt)
        cleaned = _clean_json_response(response.content)
        return json.loads(cleaned)
    except Exception as exc:
        logger.error("condition_validation_failed", error=str(exc))
        return {"valid": False, "reason": "Validation service error"}


def _detect_urgency(message: str) -> bool:
    """Return True if the message suggests urgency."""
    urgent_keywords = [
        "urgent", "emergency", "chest pain", "bleeding", "can't breathe",
        "difficulty breathing", "severe", "high fever", "fainted", "collapsed",
        "dizzy", "numbness", "stroke", "heart attack",
    ]
    lower = message.lower()
    return any(kw in lower for kw in urgent_keywords)


def _present_slots(message: str, slots_text: str, is_urgent: bool, initial_request: str = None) -> str:
    """Ask Claude to present 2-3 ranked slots."""
    if is_urgent:
        urgency_instruction = (
            "URGENCY DETECTED: The patient mentions urgent symptoms. "
            "Prioritize the EARLIEST available slot. Recommend they seek "
            "immediate care if symptoms are severe."
        )
    else:
        urgency_instruction = (
            "This is a routine appointment request. Present slots in a "
            "convenient order, considering any time preferences the patient mentioned."
        )

    try:
        llm = get_llm()
        prompt = SLOT_PRESENTATION_PROMPT.format(
            slots=slots_text, message=message, urgency_instruction=urgency_instruction, initial_request=initial_request or "None"
        )
        response = llm.invoke(prompt)
        return response.content.strip()
    except Exception as exc:
        logger.error("slot_presentation_failed", error=str(exc))
        # Fallback: show raw slots
        return f"Here are the available appointment slots:\n\n{slots_text}\n\nReply with a number to book."


# ---------------------------------------------------------------------------
# Confirmation & booking
# ---------------------------------------------------------------------------

def _looks_like_confirmation(message: str) -> bool:
    """Heuristic: does this message look like the patient is picking a slot?"""
    lower = message.lower().strip()
    signals = [
        "yes", "confirm", "book", "that one", "first", "second", "third",
        "option 1", "option 2", "option 3", "slot 1", "slot 2", "slot 3",
        "1st", "2nd", "3rd", "sounds good", "perfect", "let's go",
        "i'll take", "go ahead", "number 1", "number 2", "number 3",
    ]
    # Also match bare digits
    if lower in ("1", "2", "3"):
        return True
    return any(sig in lower for sig in signals)


def _handle_booking_confirmation(
    message: str,
    offered_slots: list[dict],
    phone: str,
    name: str,
    condition: str,
) -> str:
    """Resolve the patient's choice and book the slot."""
    try:
        # Format the offered slots so Claude can resolve the choice
        slots_text = _format_slots_for_llm(offered_slots)

        llm = get_llm()
        prompt = BOOKING_CONFIRM_PROMPT.format(slots=slots_text, message=message)
        response = llm.invoke(prompt)

        # Parse slot number from first line
        raw = response.content.strip().split("\n")[0].strip()
        try:
            slot_num = int(raw)
        except ValueError:
            slot_num = 0

        if slot_num < 1 or slot_num > len(offered_slots):
            return (
                "I couldn't tell which slot you'd like. Could you reply with the "
                "option number? (e.g., '1', '2', or '3')"
            )

        chosen = offered_slots[slot_num - 1]
        slot_id = str(chosen.get("slot_id", ""))

        # Book via Sheets (re-reads live row for double-booking safety)
        booking = book_slot(
            slot_id=slot_id,
            patient_name=name or "Unknown Patient",
            patient_phone=phone,
            condition=condition or "No condition provided",
        )

        if booking is None:
            # Slot was taken between offer and confirm
            return (
                "Oh no — that slot was just booked by someone else! 😔\n\n"
                "Let me check what else is available. Send me 'appointment' "
                "again and I'll show you the latest slots."
            )

        # Success!
        return (
            f"✅ Your appointment has been confirmed!\n\n"
            f"👨‍⚕️ Doctor: Dr. {booking['doctor_name']} ({booking['specialty']})\n"
            f"📅 Date: {booking['date']}\n"
            f"🕐 Time: {booking['start_time']} – {booking['end_time']}\n"
            f"🔖 Booking Ref: {booking['booking_ref']}\n\n"
            f"I'll send you a reminder before your appointment. "
            f"If you need to reschedule, just let me know!"
        )

    except Exception as exc:
        logger.error("booking_confirmation_failed", error=str(exc))
        return (
            "I couldn't process your booking. Could you please specify "
            "which option number you'd like? (e.g., '1' or '2')"
        )
