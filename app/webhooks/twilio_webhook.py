"""
Twilio WhatsApp Webhook — Receives messages from the Twilio Sandbox.

POST /whatsapp
  Accepts Twilio's form fields (From, Body).
  Routes through the LangGraph agent pipeline.
  Replies with TwiML MessagingResponse XML.

The sender's WhatsApp number (From) is used as the session key so
multi-turn flows (e.g. appointment Turn 1 → Turn 2) work correctly.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Form, Response

from agents.graph import run_agent_graph
from core.logging import bind_context, get_logger

logger = get_logger(__name__)

router = APIRouter(tags=["Twilio WhatsApp"])


@router.post("/whatsapp")
async def twilio_whatsapp_webhook(
    From: str = Form(""),
    Body: str = Form(""),
) -> Response:
    """Handle an incoming WhatsApp message from Twilio Sandbox.

    Args:
        From: Sender number in ``whatsapp:+91xxxxxxxxxx`` format.
        Body: Message text body.

    Returns:
        TwiML MessagingResponse XML.
    """
    # Strip the "whatsapp:" prefix to get a clean phone number
    phone = From.replace("whatsapp:", "").strip()
    message_text = Body.strip()

    bind_context(phone=phone)
    logger.info(
        "twilio_message_received",
        phone=phone,
        message_length=len(message_text),
        message_preview=message_text[:80],
    )

    if not message_text:
        return _twiml_reply("Hi! I'm Dr. AI 🩺 Send me a message and I'll help you.")

    # Generate a simple session ID from the phone number
    session_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, phone))

    try:
        reply_text, _reply_audio_url = await run_agent_graph(
            phone=phone,
            session_id=session_id,
            message_text=message_text,
            msg_type="text",
        )

        if not reply_text:
            reply_text = "I'm sorry, I couldn't process that. Could you try again? 🙏"

        logger.info(
            "twilio_reply_sent",
            phone=phone,
            reply_length=len(reply_text),
        )

        return _twiml_reply(reply_text)

    except Exception as exc:
        logger.exception("twilio_webhook_failed", error=str(exc))
        return _twiml_reply(
            "I'm having trouble right now — please try again in a moment. 🙏"
        )


def _twiml_reply(text: str) -> Response:
    """Wrap *text* in a TwiML MessagingResponse XML envelope."""
    # Escape basic XML characters in the reply text
    safe_text = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f"<Message>{safe_text}</Message>"
        "</Response>"
    )
    return Response(content=twiml, media_type="application/xml")
