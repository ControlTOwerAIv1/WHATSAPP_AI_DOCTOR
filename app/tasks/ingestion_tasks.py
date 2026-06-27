"""
Ingestion Tasks — Async RAG ingestion via Celery.

After each conversation turn, the transcript/message is chunked,
embedded, and upserted into Qdrant. This runs async so it doesn't
block the webhook response.
"""

from __future__ import annotations

from tasks.celery_app import celery_app
from core.logging import get_logger

logger = get_logger(__name__)


@celery_app.task(
    bind=True,
    name="ingestion.conversation",
    max_retries=3,
    acks_late=True,
)
def ingest_conversation(
    self,
    phone: str,
    session_id: str,
    text: str,
) -> dict:
    """Chunk text, embed with BGE-M3, and upsert to Qdrant.

    Args:
        phone: Patient phone number (used as Qdrant filter).
        session_id: Session identifier.
        text: The conversation text to ingest.

    Returns:
        Dict with ingestion status.
    """
    try:
        from rag.ingest import chunk_text
        from rag.qdrant_store import QdrantStore

        chunks = chunk_text(text)
        if not chunks:
            logger.info("ingestion_skipped", reason="no_chunks", phone=phone)
            return {"status": "skipped", "reason": "no_chunks"}

        store = QdrantStore()
        store.upsert_chunks(phone=phone, session_id=session_id, chunks=chunks)

        logger.info(
            "ingestion_complete",
            phone=phone,
            session_id=session_id,
            chunk_count=len(chunks),
        )

        return {"status": "ingested", "chunks": len(chunks)}

    except Exception as exc:
        logger.error(
            "ingestion_failed",
            phone=phone,
            error=str(exc),
        )
        raise self.retry(exc=exc, countdown=30)
