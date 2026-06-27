"""
Text Chunking — Simple sentence/paragraph chunker for RAG ingestion.

Splits text on paragraph and sentence boundaries.
Each chunk is ≤500 characters. No fancy splitting — keep it simple.

Usage:
    from rag.ingest import chunk_text
    chunks = chunk_text("Long conversation transcript...")
"""

from __future__ import annotations

import re

MAX_CHUNK_SIZE = 500
MIN_CHUNK_SIZE = 30  # Skip very short chunks


def chunk_text(text: str) -> list[str]:
    """Split text into chunks suitable for embedding.

    Strategy:
    1. Split on double newlines (paragraphs)
    2. If a paragraph is still too long, split on sentence boundaries
    3. Filter out very short chunks (< 30 chars)

    Args:
        text: The text to chunk.

    Returns:
        List of text chunks, each ≤500 chars.
    """
    if not text or not text.strip():
        return []

    # Step 1: Split on paragraphs
    paragraphs = re.split(r"\n\s*\n", text.strip())

    chunks: list[str] = []

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(para) <= MAX_CHUNK_SIZE:
            if len(para) >= MIN_CHUNK_SIZE:
                chunks.append(para)
        else:
            # Step 2: Split long paragraphs on sentence boundaries
            sentences = _split_sentences(para)
            current_chunk = ""

            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue

                if len(current_chunk) + len(sentence) + 1 <= MAX_CHUNK_SIZE:
                    current_chunk = (
                        f"{current_chunk} {sentence}" if current_chunk else sentence
                    )
                else:
                    if current_chunk and len(current_chunk) >= MIN_CHUNK_SIZE:
                        chunks.append(current_chunk.strip())
                    current_chunk = sentence

            if current_chunk and len(current_chunk) >= MIN_CHUNK_SIZE:
                chunks.append(current_chunk.strip())

    return chunks


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences on . ! ? boundaries.

    Handles common abbreviations (Dr., Mr., etc.) to avoid false splits.
    """
    # Simple sentence splitting — handles Dr., Mr., Mrs., etc.
    # Split on period, exclamation, or question mark followed by space + uppercase
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text)

    # Also split on ". " if parts are still too long
    result = []
    for part in parts:
        if len(part) > MAX_CHUNK_SIZE:
            sub_parts = part.split(". ")
            for i, sp in enumerate(sub_parts):
                if i < len(sub_parts) - 1:
                    result.append(sp + ".")
                else:
                    result.append(sp)
        else:
            result.append(part)

    return result
