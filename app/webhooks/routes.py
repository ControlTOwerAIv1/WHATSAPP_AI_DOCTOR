"""
Webhook Routes — WhatsApp webhook verification and message reception (Meta).

GET  /webhook  — Meta verification handshake
POST /webhook  — Receive inbound WhatsApp messages

These endpoints are kept for future production use with Meta's Cloud API.
For the demo, the Twilio webhook at POST /whatsapp is the primary endpoint.

NOTE: The dispatcher module depends on PostgreSQL / SQLModel which are
not available in the demo stack.  Imports are deferred so the app starts
cleanly even when Meta env vars are empty.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Query, Request, Response

from core.config import get_settings
from core.logging import bind_context, get_logger

logger = get_logger(__name__)

router = APIRouter(tags=["Webhook"])


@router.get("/webhook")
async def verify_webhook(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge"),
) -> Response:
    """Meta webhook verification handshake.

    Meta sends a GET request with hub.mode, hub.verify_token, and
    hub.challenge. We verify the token and echo back the challenge.
    """
    settings = get_settings()

    if hub_mode == "subscribe" and hub_verify_token == settings.whatsapp_verify_token:
        logger.info("webhook_verified")
        return Response(content=hub_challenge, media_type="text/plain")

    logger.warning(
        "webhook_verification_failed",
        hub_mode=hub_mode,
        token_match=hub_verify_token == settings.whatsapp_verify_token,
    )
    return Response(content="Verification failed", status_code=403)


@router.post("/webhook")
async def receive_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict:
    """Receive inbound WhatsApp messages from Meta.

    Returns 200 immediately (Meta requires <5s response).
    Actual processing happens in a background task.

    NOTE: This endpoint requires PostgreSQL and the dispatcher module.
    For the demo, use POST /whatsapp (Twilio) instead.
    """
    body = await request.json()

    try:
        entry = body.get("entry", [])
        if not entry:
            return {"status": "ok"}

        changes = entry[0].get("changes", [])
        if not changes:
            return {"status": "ok"}

        value = changes[0].get("value", {})
        messages = value.get("messages", [])
        contacts = value.get("contacts", [])

        if not messages:
            logger.debug("webhook_non_message", payload_type="status_update")
            return {"status": "ok"}

        message = messages[0]
        contact = contacts[0] if contacts else {}

        phone = message.get("from", "")
        wa_message_id = message.get("id", "")
        msg_type = message.get("type", "text")
        sender_name = contact.get("profile", {}).get("name")

        bind_context(phone=phone, wa_message_id=wa_message_id)
        logger.info(
            "webhook_message_received",
            msg_type=msg_type,
            sender_name=sender_name,
        )

        # Lazy import — dispatcher needs PostgreSQL which isn't in the demo stack
        try:
            from webhooks.dispatcher import process_incoming_message

            background_tasks.add_task(
                process_incoming_message,
                phone=phone,
                wa_message_id=wa_message_id,
                msg_type=msg_type,
                message_data=message,
                sender_name=sender_name,
            )
        except ImportError:
            logger.warning(
                "meta_dispatcher_unavailable",
                note="PostgreSQL/SQLModel not installed — use POST /whatsapp instead",
            )

    except Exception as exc:
        logger.error("webhook_parse_error", error=str(exc))

    # Always return 200 to Meta
    return {"status": "ok"}
