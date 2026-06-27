"""
Celery App — Task queue for async processing.

Separate Celery instance from voice-service (different broker DB index).
Uses Redis DB 1 (voice-service uses DB 0).
"""

from __future__ import annotations

from celery import Celery

from core.config import get_settings

settings = get_settings()

celery_app = Celery(
    "whatsapp_doctor",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_time_limit=120,
    task_soft_time_limit=90,
    result_expires=86400,
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=100,
    worker_hijack_root_logger=False,
)
