"""
Upload Utilities — Audio download, validation, and file handling.

This module is NOT a router — it provides shared utilities used by
the TranscribeUseCase for audio file operations.

Functions here handle:
  - Async audio download from URL with httpx
  - Streaming download with progress tracking
  - Timeout and max-size enforcement during streaming
  - SHA-256 checksum calculation
  - MIME type guessing from Content-Type and URL extension
"""

from __future__ import annotations

# Upload utilities are implemented directly in the TranscribeUseCase
# to avoid an extra layer of indirection. This module exists as a
# namespace for future extraction if upload logic grows complex enough
# to warrant its own module (e.g., multipart upload support, presigned
# URL generation for S3).
#
# Current implementation: see application/transcribe_usecase.py
#   - _download_audio()
#   - _guess_extension()
#   - _cleanup()
#
# If you need to add upload functionality (e.g., direct file upload
# via multipart form), add it here and inject it into the use case.
