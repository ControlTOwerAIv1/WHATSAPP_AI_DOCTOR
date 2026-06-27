"""
LangGraph Agent Graph — Wires all agent nodes together with conditional routing.

Architecture:
    Entry → load_history → Supervisor → (conditional routing by intent) →
      ├─ general           → conversation_listener → END
      ├─ appointment       → appointment_scheduler → END
      ├─ medicine          → medicine_tracker → END
      └─ clinical_question → patient_insight → clinical_reasoning → END

After the graph runs, results are used by the dispatcher to:
  1. Send reply text (and optionally TTS audio) via WhatsApp
  2. Trigger async RAG ingestion of the conversation turn

Uses LangGraph's MemorySaver for in-memory checkpointing.
"""

from __future__ import annotations

from typing import Optional

from langgraph.graph import END, StateGraph
from langgraph.checkpoint.memory import MemorySaver
from sqlmodel import Session, select

from agents.appointment_scheduler import appointment_scheduler_node
from agents.clinical_reasoning import clinical_reasoning_node
from agents.conversation_listener import conversation_listener_node
from agents.medicine_tracker import medicine_tracker_node
from agents.patient_insight import patient_insight_node
from agents.state import PatientState
from agents.supervisor import supervisor_node
from core.logging import get_logger
from models.db import get_engine
from models.message import Message

logger = get_logger(__name__)


# ── History Loader Node ───────────────────────────────────────────────

def load_history_node(state: PatientState) -> dict:
    """Load recent conversation history from PostgreSQL.

    Fetches the last 10 messages for the current session and attaches
    them to state.history for use by downstream agents.
    """
    session_id = state.get("session_id", "")

    try:
        engine = get_engine()
        with Session(engine) as db:
            messages = db.exec(
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.created_at.desc())
                .limit(10)
            ).all()

            # Reverse to chronological order
            history = [
                {
                    "direction": msg.direction,
                    "content": msg.content or msg.transcript or "",
                    "type": msg.msg_type,
                }
                for msg in reversed(messages)
            ]

            return {"history": history}

    except Exception as exc:
        logger.warning("history_load_failed", error=str(exc))
        return {"history": []}


# ── Routing Function ─────────────────────────────────────────────────

def route_by_intent(state: PatientState) -> str:
    """Route to the appropriate agent based on classified intent.

    Returns the node name to transition to.
    """
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
    """Build the LangGraph StateGraph with all agent nodes and edges.

    Returns:
        Compiled StateGraph ready for invocation.
    """
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
    # load_history → supervisor (always)
    graph.add_edge("load_history", "supervisor")

    # supervisor → conditional routing by intent
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

    This is the main entry point called by the webhook dispatcher.

    Args:
        phone: Patient phone number.
        session_id: Current session ID.
        message_text: The message text (or transcript for audio).
        msg_type: Message type (text, audio, image).

    Returns:
        Tuple of (reply_text, reply_audio_url).
        reply_audio_url is None unless msg_type is audio and TTS is successful.
    """
    graph = _get_graph()

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
        "reply_text": None,
        "reply_audio_url": None,
    }

    # Configuration with thread_id for checkpointer
    config = {"configurable": {"thread_id": f"{phone}_{session_id}"}}

    try:
        # Run the graph
        result = graph.invoke(initial_state, config)

        reply_text = result.get("reply_text")
        reply_audio_url = result.get("reply_audio_url")

        # If the original message was audio, try to generate a voice reply
        if msg_type == "audio" and reply_text:
            try:
                from integrations.voice_service_client import VoiceServiceClient

                voice = VoiceServiceClient()
                audio_url = await voice.synthesize(
                    text=reply_text,
                    language="en",
                    voice="doctor",
                )
                if audio_url:
                    reply_audio_url = audio_url
            except Exception as exc:
                logger.warning("tts_reply_failed", error=str(exc))
                # Fall back to text-only reply

        # Trigger async RAG ingestion (best-effort)
        _trigger_ingestion(phone, session_id, message_text, reply_text)

        logger.info(
            "agent_graph_complete",
            phone=phone,
            intent=result.get("intent"),
            agent=result.get("current_agent"),
            reply_length=len(reply_text) if reply_text else 0,
            has_audio=reply_audio_url is not None,
        )

        return reply_text, reply_audio_url

    except Exception as exc:
        logger.exception("agent_graph_failed", error=str(exc))
        return (
            "Sorry, I'm having trouble right now. Please try again in a moment. 🙏",
            None,
        )


def _trigger_ingestion(
    phone: str,
    session_id: str,
    user_message: str,
    bot_reply: Optional[str],
) -> None:
    """Trigger async RAG ingestion of the conversation turn.

    Best-effort — doesn't block or fail if Celery is unavailable.
    """
    try:
        from tasks.ingestion_tasks import ingest_conversation

        # Combine user message and bot reply for ingestion
        parts = []
        if user_message:
            parts.append(f"Patient: {user_message}")
        if bot_reply:
            parts.append(f"Dr. AI: {bot_reply}")

        if parts:
            text = "\n".join(parts)
            ingest_conversation.delay(
                phone=phone,
                session_id=session_id,
                text=text,
            )

    except Exception as exc:
        logger.warning("ingestion_trigger_failed", error=str(exc))
