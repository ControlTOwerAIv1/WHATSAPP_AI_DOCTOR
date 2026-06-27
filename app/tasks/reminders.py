"""
Reminder Tasks — Celery tasks for medicine and appointment reminders.

These tasks send WhatsApp messages via the Meta client.
They are triggered by the Medicine Tracker and Appointment Scheduler agents.
"""

from __future__ import annotations

import asyncio

from tasks.celery_app import celery_app
from core.logging import get_logger

logger = get_logger(__name__)


@celery_app.task(
    bind=True,
    name="reminders.medicine",
    max_retries=2,
    acks_late=True,
)
def send_medicine_reminder(
    self,
    phone: str,
    drug_name: str,
    dosage: str = "as prescribed",
) -> dict:
    """Send a medicine reminder to the patient via WhatsApp.

    Args:
        phone: Patient's phone number.
        drug_name: Name of the medication.
        dosage: Dosage information.

    Returns:
        Dict with status and details.
    """
    from integrations.meta_client import MetaWhatsAppClient

    message = (
        f"💊 Medicine Reminder\n\n"
        f"It's time to take your {drug_name} ({dosage}).\n\n"
        f"Reply 'taken' when done, or 'skip' if you're skipping this dose."
    )

    try:
        client = MetaWhatsAppClient()
        # Run the async send in a sync context (Celery tasks are sync)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            msg_id = loop.run_until_complete(
                client.send_text_message(phone, message)
            )
        finally:
            loop.close()

        logger.info(
            "medicine_reminder_sent",
            phone=phone,
            drug_name=drug_name,
            message_id=msg_id,
        )

        return {"status": "sent", "phone": phone, "drug": drug_name}

    except Exception as exc:
        logger.error(
            "medicine_reminder_failed",
            phone=phone,
            drug_name=drug_name,
            error=str(exc),
        )
        raise self.retry(exc=exc, countdown=60)


@celery_app.task(
    bind=True,
    name="reminders.appointment",
    max_retries=2,
    acks_late=True,
)
def send_appointment_reminder(
    self,
    phone: str,
    slot_start: str,
) -> dict:
    """Send an appointment reminder to the patient via WhatsApp.

    Args:
        phone: Patient's phone number.
        slot_start: ISO format datetime string of the appointment.

    Returns:
        Dict with status and details.
    """
    from integrations.meta_client import MetaWhatsAppClient

    message = (
        f"📅 Appointment Reminder\n\n"
        f"You have a doctor's appointment scheduled for {slot_start}.\n\n"
        f"Please arrive 10 minutes early. "
        f"Reply 'cancel' if you need to reschedule."
    )

    try:
        client = MetaWhatsAppClient()
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            msg_id = loop.run_until_complete(
                client.send_text_message(phone, message)
            )
        finally:
            loop.close()

        logger.info(
            "appointment_reminder_sent",
            phone=phone,
            slot_start=slot_start,
            message_id=msg_id,
        )

        return {"status": "sent", "phone": phone, "slot": slot_start}

    except Exception as exc:
        logger.error(
            "appointment_reminder_failed",
            phone=phone,
            error=str(exc),
        )
        raise self.retry(exc=exc, countdown=60)
