"""
LangGraph Agent Graph — Wires all agent nodes together with conditional routing.

Architecture:
    Entry → load_history → Supervisor → (conditional routing by intent) →
      ├─ general           → conversation_listener → END
      ├─ appointment       → appointment_scheduler → END
      ├─ medicine          → medicine_tracker → END
      └─ clinical_question → patient_insight → clinical_reasoning → END

Uses an in-memory session store (dict keyed by phone) for conversation
history.  LangGraph's MemorySaver handles graph checkpointing.
"""

from __future__ import annotations

from typing import Optional

from langgraph.graph import END, StateGraph
from langgraph.checkpoint.memory import MemorySaver

from agents.appointment_scheduler import appointment_scheduler_node
from agents.clinical_reasoning import clinical_reasoning_node
from agents.conversation_listener import conversation_listener_node
from agents.medicine_tracker import medicine_tracker_node
from agents.patient_insight import patient_insight_node
from agents.state import PatientState
from agents.supervisor import supervisor_node
from core.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# In-memory session store: phone → list of message dicts
# ---------------------------------------------------------------------------
_session_history: dict[str, list[dict]] = {}


def _get_session_history(phone: str) -> list[dict]:
    """Return conversation history for *phone*, creating if needed."""
    if phone not in _session_history:
        _session_history[phone] = []
    return _session_history[phone]


def _append_to_history(phone: str, direction: str, content: str) -> None:
    """Append a message to the in-memory history for *phone*."""
    history = _get_session_history(phone)
    history.append({"direction": direction, "content": content})
    # Keep last 20 messages
    if len(history) > 20:
        _session_history[phone] = history[-20:]


from services.session_store import get_session

# ── History Loader Node ───────────────────────────────────────────────

def load_history_node(state: PatientState) -> dict:
    """Load recent conversation history from in-memory store.

    Fetches the last 10 messages for the current phone and attaches
    them to state.history for use by downstream agents.
    Also injects the centralized session store values for appointment flow.
    """
    phone = state.get("phone", "")
    history = _get_session_history(phone)[-10:]

    # Inject session variables
    session = get_session(phone)

    return {
        "history": history,
        "appointment_stage": session.get("stage"),
        "patient_name": session.get("name"),
        "patient_condition": session.get("condition"),
        "name_failures": session.get("name_failures", 0),
        "condition_failures": session.get("condition_failures", 0),
        "offered_slots": session.get("offered_slots"),
    }


# ── Routing Function ─────────────────────────────────────────────────

def route_by_intent(state: PatientState) -> str:
    """Route to the appropriate agent based on classified intent or active session."""
    stage = state.get("appointment_stage")
    
    # Lock the user into the appointment flow if they are in the middle of booking
    if stage and stage != "start":
        logger.info("graph_routing", stage=stage, destination="appointment_scheduler")
        return "appointment_scheduler"

    intent = state.get("intent", "general")

    route_map = {
        "general": "conversation_listener",
        "appointment": "appointment_scheduler",
        "medicine": "medicine_tracker",
        "clinical_question": "patient_insight",
    }

    destination = route_map.get(intent, "conversation_listener")
    logger.info("graph_routing", intent=intent, destination=destination)
    return destination


# ── Graph Builder ────────────────────────────────────────────────────

def build_graph() -> StateGraph:
    """Build the LangGraph StateGraph with all agent nodes and edges."""
    graph = StateGraph(PatientState)

    # ── Add nodes ──────────────────────────────────────────────────
    graph.add_node("load_history", load_history_node)
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("conversation_listener", conversation_listener_node)
    graph.add_node("appointment_scheduler", appointment_scheduler_node)
    graph.add_node("medicine_tracker", medicine_tracker_node)
    graph.add_node("patient_insight", patient_insight_node)
    graph.add_node("clinical_reasoning", clinical_reasoning_node)

    # ── Set entry point ────────────────────────────────────────────
    graph.set_entry_point("load_history")

    # ── Add edges ──────────────────────────────────────────────────
    graph.add_edge("load_history", "supervisor")

    graph.add_conditional_edges(
        "supervisor",
        route_by_intent,
        {
            "conversation_listener": "conversation_listener",
            "appointment_scheduler": "appointment_scheduler",
            "medicine_tracker": "medicine_tracker",
            "patient_insight": "patient_insight",
        },
    )

    # Terminal nodes → END
    graph.add_edge("conversation_listener", END)
    graph.add_edge("appointment_scheduler", END)
    graph.add_edge("medicine_tracker", END)

    # clinical_question flow: patient_insight → clinical_reasoning → END
    graph.add_edge("patient_insight", "clinical_reasoning")
    graph.add_edge("clinical_reasoning", END)

    return graph


# ── Compiled Graph (singleton) ───────────────────────────────────────

_compiled_graph = None
_checkpointer = MemorySaver()


def _get_graph():
    """Get or compile the singleton graph instance."""
    global _compiled_graph
    if _compiled_graph is None:
        graph = build_graph()
        _compiled_graph = graph.compile(checkpointer=_checkpointer)
        logger.info("agent_graph_compiled")
    return _compiled_graph


# ── Public Entry Point ───────────────────────────────────────────────

async def run_agent_graph(
    phone: str,
    session_id: str,
    message_text: str,
    msg_type: str,
) -> tuple[Optional[str], Optional[str]]:
    """Run the full agent graph for an incoming message.

    Args:
        phone: Patient phone number.
        session_id: Current session ID.
        message_text: The message text (or transcript for audio).
        msg_type: Message type (text, audio, image).

    Returns:
        Tuple of (reply_text, reply_audio_url).
    """
    graph = _get_graph()

    # Record inbound message in history
    _append_to_history(phone, "in", message_text)

    # Build initial state
    initial_state: PatientState = {
        "phone": phone,
        "session_id": session_id,
        "message_text": message_text,
        "message_type": msg_type,
        "transcript": message_text if msg_type == "audio" else None,
        "intent": None,
        "current_agent": None,
        "history": [],
        "retrieved_context": None,
        "offered_slots": None,
        "reply_text": None,
        "reply_audio_url": None,
    }

    config = {"configurable": {"thread_id": f"{phone}_{session_id}"}}

    try:
        result = graph.invoke(initial_state, config)

        reply_text = result.get("reply_text")
        reply_audio_url = result.get("reply_audio_url")

        # Record outbound message in history
        if reply_text:
            _append_to_history(phone, "out", reply_text)

        logger.info(
            "agent_graph_complete",
            phone=phone,
            intent=result.get("intent"),
            agent=result.get("current_agent"),
            reply_length=len(reply_text) if reply_text else 0,
        )

        return reply_text, reply_audio_url

    except Exception as exc:
        logger.exception("agent_graph_failed", error=str(exc))
        return (
            "Sorry, I'm having trouble right now. Please try again in a moment. ",
            None,
        )
