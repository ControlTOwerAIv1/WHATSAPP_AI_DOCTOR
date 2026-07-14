"""
PatientState — Shared state schema for the LangGraph multi-agent graph.

This TypedDict flows through every agent node. Each node reads from
and writes to specific fields. The Supervisor sets `intent`, agents
set `reply_text`, etc.

Keep this minimal — don't add speculative fields.
"""

from __future__ import annotations

from typing import Literal, Optional, TypedDict


class PatientState(TypedDict):
    """Shared state carried through the LangGraph agent graph."""

    # ── Identity ────────────────────────────────────────────────────
    phone: str
    session_id: str

    # ── Input ───────────────────────────────────────────────────────
    message_text: str
    message_type: Literal["text", "audio", "image"]
    transcript: Optional[str]

    # ── Routing ─────────────────────────────────────────────────────
    intent: Optional[str]
    current_agent: Optional[str]

    # ── Context ─────────────────────────────────────────────────────
    history: list[dict]
    retrieved_context: Optional[str]

    # ── Appointment flow (FSM) ──────────────────────────────────────
    appointment_stage: Optional[str]
    patient_name: Optional[str]
    patient_condition: Optional[str]
    name_failures: Optional[int]
    condition_failures: Optional[int]
    offered_slots: Optional[list[dict]]

    # ── Output ──────────────────────────────────────────────────────
    reply_text: Optional[str]
    reply_audio_url: Optional[str]
