"""
STT Interfaces — Re-exports domain contracts for discoverability.

Consumers within the STT package (or external packages looking for STT
contracts) import from here rather than reaching into the domain layer.

This keeps the import path intuitive:
    from stt.interfaces import SpeechRecognizer
"""

from domain.contracts import AudioPreprocessor, SpeechRecognizer

__all__ = ["SpeechRecognizer", "AudioPreprocessor"]
