"""
Session Store — Centralized in-memory storage for patient session state.

Tracks the conversational stage and collected data for each patient's
interaction with the appointment scheduler.

Structure:
sessions = {
    "+918123456789": {
        "stage": "waiting_for_name",  # or waiting_for_condition, waiting_for_slot
        "name": None,
        "condition": None,
        "offered_slots": []
    }
}
"""

from typing import Any, Dict, Optional

_sessions: Dict[str, Dict[str, Any]] = {}


def get_session(phone: str) -> Dict[str, Any]:
    """Get the session for a phone number, creating it if it doesn't exist."""
    if phone not in _sessions:
        _sessions[phone] = {
            "stage": "start",
            "name": None,
            "condition": None,
            "offered_slots": [],
            "initial_request": None,
            "name_failures": 0,
            "condition_failures": 0,
        }
    return _sessions[phone]


def update_session(phone: str, **kwargs) -> None:
    """Update fields in the patient's session."""
    session = get_session(phone)
    session.update(kwargs)


def clear_session(phone: str) -> None:
    """Clear a patient's session (e.g., after successful booking)."""
    if phone in _sessions:
        del _sessions[phone]
