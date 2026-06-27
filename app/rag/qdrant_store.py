"""
Qdrant Store — Vector database client for patient history RAG.

Manages the `patient_history` collection:
  - ensure_collection() — create collection if not exists
  - upsert_chunks() — embed + upsert text chunks with patient metadata
  - search() — semantic search filtered by patient phone number

Each patient's data is isolated via payload filtering — one patient
never sees another's history.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from core.config import get_settings
from core.logging import get_logger
from rag.embeddings import get_embedder, get_embedding_dim

logger = get_logger(__name__)

_client: QdrantClient | None = None


def _get_client() -> QdrantClient:
    """Get or create the singleton Qdrant client."""
    global _client
    if _client is None:
        settings = get_settings()
        _client = QdrantClient(
            host=settings.qdrant_host,
            port=settings.qdrant_port,
        )
        logger.info(
            "qdrant_client_initialized",
            host=settings.qdrant_host,
            port=settings.qdrant_port,
        )
    return _client


class QdrantStore:
    """Vector store for patient history retrieval."""

    def __init__(self) -> None:
        self._client = _get_client()
        self._collection = get_settings().qdrant_collection
        self._embedder = get_embedder()

    def ensure_collection(self) -> None:
        """Create the patient_history collection if it doesn't exist.

        Vector size matches BGE-M3 output dimension (1024).
        Uses cosine distance for normalized embeddings.
        """
        collections = self._client.get_collections().collections
        existing_names = [c.name for c in collections]

        if self._collection in existing_names:
            logger.info("qdrant_collection_exists", collection=self._collection)
            return

        self._client.create_collection(
            collection_name=self._collection,
            vectors_config=VectorParams(
                size=get_embedding_dim(),
                distance=Distance.COSINE,
            ),
        )
        logger.info("qdrant_collection_created", collection=self._collection)

    def upsert_chunks(
        self,
        phone: str,
        session_id: str,
        chunks: list[str],
    ) -> int:
        """Embed and upsert text chunks with patient metadata.

        Args:
            phone: Patient phone number (for filtering).
            session_id: Session identifier.
            chunks: List of text chunks to embed and store.

        Returns:
            Number of points upserted.
        """
        if not chunks:
            return 0

        # Embed all chunks
        vectors = self._embedder.embed(chunks)

        # Build points with metadata payload
        now = datetime.now(timezone.utc).isoformat()
        points = []
        for chunk, vector in zip(chunks, vectors):
            point_id = str(uuid.uuid4())
            points.append(
                PointStruct(
                    id=point_id,
                    vector=vector,
                    payload={
                        "patient_phone": phone,
                        "session_id": session_id,
                        "timestamp": now,
                        "text_chunk": chunk,
                    },
                )
            )

        # Upsert to Qdrant
        self._client.upsert(
            collection_name=self._collection,
            points=points,
        )

        logger.info(
            "qdrant_upsert_complete",
            phone=phone,
            session_id=session_id,
            chunk_count=len(points),
        )

        return len(points)

    def search(
        self,
        phone: str,
        query: str,
        top_k: int = 3,
    ) -> list[str]:
        """Semantic search over a patient's own history.

        Args:
            phone: Patient phone number — results are filtered to this patient only.
            query: The search query text.
            top_k: Number of results to return.

        Returns:
            List of text chunks most relevant to the query.
        """
        # Embed the query
        query_vector = self._embedder.embed([query])[0]

        # Search with patient phone filter
        results = self._client.search(
            collection_name=self._collection,
            query_vector=query_vector,
            query_filter=Filter(
                must=[
                    FieldCondition(
                        key="patient_phone",
                        match=MatchValue(value=phone),
                    )
                ]
            ),
            limit=top_k,
        )

        chunks = [hit.payload["text_chunk"] for hit in results if hit.payload]

        logger.info(
            "qdrant_search_complete",
            phone=phone,
            query_preview=query[:60],
            results_count=len(chunks),
        )

        return chunks
