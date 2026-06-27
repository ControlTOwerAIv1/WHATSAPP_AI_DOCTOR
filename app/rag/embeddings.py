"""
BGE-M3 Embeddings Wrapper — Local embedding model via sentence-transformers.

Provides a singleton model that loads once and is reused across requests.
BGE-M3 outputs 1024-dimensional vectors optimized for multilingual retrieval.

Usage:
    from rag.embeddings import get_embedder
    embedder = get_embedder()
    vectors = embedder.embed(["patient has fever and cough"])
"""

from __future__ import annotations

from core.logging import get_logger

logger = get_logger(__name__)

_model = None
_EMBEDDING_DIM = 1024  # BGE-M3 output dimension


def get_embedding_dim() -> int:
    """Return the embedding dimension for BGE-M3."""
    return _EMBEDDING_DIM


class EmbeddingModel:
    """Wrapper around sentence-transformers for BGE-M3 embeddings."""

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        logger.info("embedding_model_loading", model="BAAI/bge-m3")
        self._model = SentenceTransformer("BAAI/bge-m3")
        logger.info("embedding_model_loaded", model="BAAI/bge-m3", dim=_EMBEDDING_DIM)

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed a list of texts into vectors.

        Args:
            texts: List of text strings to embed.

        Returns:
            List of embedding vectors (each is a list of floats).
        """
        if not texts:
            return []

        embeddings = self._model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

        return embeddings.tolist()


def get_embedder() -> EmbeddingModel:
    """Get or create the singleton embedding model."""
    global _model
    if _model is None:
        _model = EmbeddingModel()
    return _model
