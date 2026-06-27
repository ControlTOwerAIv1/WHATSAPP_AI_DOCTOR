"""
TTS Interfaces — Re-exports domain contracts for discoverability.

    from tts.interfaces import SpeechSynthesizer, AudioEncoder
"""

from domain.contracts import AudioEncoder, SpeechSynthesizer

__all__ = ["SpeechSynthesizer", "AudioEncoder"]
