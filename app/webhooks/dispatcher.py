"""
Dispatcher — Routes inbound WhatsApp messages by type and processes them.

Responsibilities:
  1. Idempotency check (wa_message_id against messages table)
  2. Ensure user + session exist in DB
  3. Persist inbound message
  4. Route by message type: text / audio / image
  5. Run the LangGraph agent graph (Stage 2+, echoes text for now)
  6. Persist outbound reply
  7. Send reply via Meta API

This is the central orchestration function called from the webhook
background task. Every external call is wrapped in try/except.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select

from core.config import get_settings
from core.logging import bind_context, get_logger
from integrations.meta_client import MetaWhatsAppClient
from integrations.voice_service_client import VoiceServiceClient
from models.db import get_engine
from models.message import Message
from models.session import ConversationSession
from models.user import User

logger = get_logger(__name__)

# Singletons created on first use
_meta_client: Optional[MetaWhatsAppClient] = None
_voice_client: Optional[VoiceServiceClient] = None


def _get_meta_client() -> MetaWhatsAppClient:
    global _meta_client
    if _meta_client is None:
        _meta_client = MetaWhatsAppClient()
    return _meta_client


def _get_voice_client() -> VoiceServiceClient:
    global _voice_client
    if _voice_client is None:
        _voice_client = VoiceServiceClient()
    return _voice_client


async def process_incoming_message(
    phone: str,
    wa_message_id: str,
    msg_type: str,
    message_data: dict,
    sender_name: Optional[str] = None,
) -> None:
    """Process a single inbound WhatsApp message end-to-end.

    This runs as a background task — exceptions are logged, never raised.
    """
    bind_context(phone=phone, wa_message_id=wa_message_id)

    try:
        engine = get_engine()

        with Session(engine) as db:
            # ── Step 1: Idempotency check ──────────────────────────
            existing = db.exec(
                select(Message).where(Message.wa_message_id == wa_message_id)
            ).first()
            if existing is not None:
                logger.info("duplicate_message_skipped", wa_message_id=wa_message_id)
                return

            # ── Step 2: Ensure user exists ─────────────────────────
            user = db.get(User, phone)
            if user is None:
                user = User(phone=phone, name=sender_name)
                db.add(user)
                db.commit()
                db.refresh(user)
                logger.info("user_created", phone=phone, name=sender_name)

            # ── Step 3: Get or create session ──────────────────────
            session = _get_or_create_session(db, phone)
            bind_context(session_id=str(session.id))

            # ── Step 4: Extract content by message type ────────────
            message_text, transcript = await _extract_content(
                msg_type, message_data, phone, str(session.id)
            )

            # ── Step 5: Persist inbound message ────────────────────
            inbound_msg = Message(
                id=uuid.uuid4(),
                session_id=session.id,
                wa_message_id=wa_message_id,
                direction="in",
                msg_type=msg_type,
                content=message_text,
                transcript=transcript,
            )
            db.add(inbound_msg)
            db.commit()

            # ── Step 6: Generate reply ─────────────────────────────
            # The text to reason over: transcript (for audio) or message_text
            input_text = transcript or message_text or ""

            reply_text, reply_audio_url = await _generate_reply(
                phone=phone,
                session_id=str(session.id),
                message_text=input_text,
                msg_type=msg_type,
            )

            # ── Step 7: Persist outbound message ───────────────────
            outbound_msg = Message(
                id=uuid.uuid4(),
                session_id=session.id,
                wa_message_id=None,
                direction="out",
                msg_type="text" if not reply_audio_url else "audio",
                content=reply_text,
            )
            db.add(outbound_msg)

            # Update session activity
            session.last_active_at = datetime.now(timezone.utc)
            db.add(session)
            db.commit()

            # ── Step 8: Send reply via WhatsApp ────────────────────
            meta = _get_meta_client()

            if reply_audio_url:
                await meta.send_audio_message(phone, reply_audio_url)
            if reply_text:
                await meta.send_text_message(phone, reply_text)

            logger.info(
                "message_processed",
                msg_type=msg_type,
                reply_length=len(reply_text) if reply_text else 0,
                has_audio_reply=reply_audio_url is not None,
            )

    except Exception as exc:
        logger.exception(
            "message_processing_failed",
            phone=phone,
            error=str(exc),
        )
        # Best-effort: try to send a fallback error message
        try:
            meta = _get_meta_client()
            await meta.send_text_message(
                phone,
                "Sorry, I'm having trouble right now — please try again in a moment. 🙏",
            )
        except Exception:
            logger.error("fallback_message_failed", phone=phone)


def _get_or_create_session(
    db: Session, phone: str
) -> ConversationSession:
    """Get the active session or create a new one.

    A session is considered active if last_active_at is within the last
    30 minutes. Otherwise, a new session is created.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)

    existing = db.exec(
        select(ConversationSession)
        .where(ConversationSession.user_phone == phone)
        .where(ConversationSession.last_active_at >= cutoff)
        .order_by(ConversationSession.last_active_at.desc())
    ).first()

    if existing is not None:
        return existing

    new_session = ConversationSession(
        id=uuid.uuid4(),
        user_phone=phone,
    )
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    logger.info("session_created", session_id=str(new_session.id))
    return new_session


async def _extract_content(
    msg_type: str,
    message_data: dict,
    phone: str,
    session_id: str,
) -> tuple[Optional[str], Optional[str]]:
    """Extract text content and/or transcript from the message.

    Returns:
        (message_text, transcript) — transcript is set only for audio messages.
    """
    if msg_type == "text":
        text_body = message_data.get("text", {}).get("body", "")
        return text_body, None

    elif msg_type == "audio":
        audio_info = message_data.get("audio", {})
        media_id = audio_info.get("id")

        if not media_id:
            logger.warning("audio_no_media_id")
            return None, None

        # Download media via Meta API and get a URL for voice-service
        # For now, we construct the media URL that voice-service can download from
        # In production, we'd save to S3/MinIO and pass that URL
        meta = _get_meta_client()
        media_bytes = await meta.download_media(media_id)

        if media_bytes is None:
            return None, None

        # Save to local temp file and construct a URL
        # The voice-service needs a reachable URL — for Docker networking,
        # we'll save to a shared volume and use a file path
        import tempfile
        import os

        storage_dir = os.path.join(os.getcwd(), "storage", "audio")
        os.makedirs(storage_dir, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.ogg"
        filepath = os.path.join(storage_dir, filename)

        with open(filepath, "wb") as f:
            f.write(media_bytes)

        # Construct URL reachable by voice-service within Docker network
        settings = get_settings()
        audio_url = f"{settings.voice_service_url}/storage/audio/{filename}"

        # Call voice-service STT
        voice = _get_voice_client()
        result = await voice.transcribe(audio_url, phone, session_id)

        if result is not None:
            transcript = result.get("transcript", "")
            return None, transcript

        return None, None

    elif msg_type == "image":
        logger.info("image_message_received", note="image processing coming soon")
        return "[Image received — image processing coming soon]", None

    else:
        logger.warning("unsupported_message_type", msg_type=msg_type)
        return None, None


async def _generate_reply(
    phone: str,
    session_id: str,
    message_text: str,
    msg_type: str,
) -> tuple[Optional[str], Optional[str]]:
    """Generate a reply using the agent graph.

    For Stage 1, this is a simple echo. Stage 2 replaces this with
    the full LangGraph pipeline.

    Returns:
        (reply_text, reply_audio_url) — audio_url is None for text replies.
    """
    if not message_text:
        return "I received your message but couldn't process it. Could you try again?", None

    # ── Stage 1: Echo mode ─────────────────────────────────────────
    # Will be replaced by the LangGraph graph in Stage 2.
    try:
        from agents.graph import run_agent_graph

        reply_text, reply_audio_url = await run_agent_graph(
            phone=phone,
            session_id=session_id,
            message_text=message_text,
            msg_type=msg_type,
        )
        return reply_text, reply_audio_url

    except ImportError:
        # Stage 1 fallback: echo mode before agents are built
        reply = f"🤖 Echo: {message_text}"
        logger.info("echo_reply", reply_length=len(reply))
        return reply, None

    except Exception as exc:
        logger.error("agent_graph_failed", error=str(exc))
        return "Sorry, I'm having trouble processing your request. Please try again.", None
