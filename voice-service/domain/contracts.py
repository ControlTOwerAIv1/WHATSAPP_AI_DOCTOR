"""
Domain Contracts — Protocol interfaces (Ports) for the voice processing pipeline.

All infrastructure adapters MUST implement these protocols.
Using typing.Protocol for structural subtyping — no inheritance required.
Adapters satisfy contracts by duck-typing, not by explicitly inheriting.

Dependency Rule:
  Infrastructure → Domain (implements)
  Application → Domain (depends on)
  API → Application (calls)
  Domain → Nothing (pure)
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from domain.entities import (
    AudioMetadata,
    SynthesisResult,
    TranscriptionResult,
    TranslationResult,
)


@runtime_checkable
class SpeechRecognizer(Protocol):
    """Port for speech-to-text engines.

    Implementations: WhisperEngine (faster-whisper).
    Future: Google STT, Azure STT, Deepgram.
    """

    def transcribe(self, audio_path: str) -> TranscriptionResult:
        """Transcribe a normalized audio file to text.

        Args:
            audio_path: Absolute path to a normalized WAV file
                        (mono, 16kHz, 16-bit PCM).

        Returns:
            TranscriptionResult with transcript, language, confidence,
            and timestamps.

        Raises:
            TranscriptionError: If the engine fails to process the audio.
        """
        ...


@runtime_checkable
class TextTranslator(Protocol):
    """Port for text translation services.

    Implementations: LibreTranslateAdapter.
    Future: Google Translate, DeepL.
    """

    def translate(
        self, text: str, source_lang: str, target_lang: str
    ) -> TranslationResult:
        """Translate text from source language to target language.

        Args:
            text: The text to translate.
            source_lang: ISO 639-1 language code (e.g., "hi", "ta").
            target_lang: ISO 639-1 language code (e.g., "en").

        Returns:
            TranslationResult with original and translated text.

        Raises:
            TranslationError: If the translation service is unavailable.
        """
        ...

    def detect_language(self, text: str) -> str:
        """Detect the language of the given text.

        Args:
            text: Text to analyze.

        Returns:
            ISO 639-1 language code.

        Raises:
            TranslationError: If detection fails.
        """
        ...


@runtime_checkable
class SpeechSynthesizer(Protocol):
    """Port for text-to-speech engines.

    Implementations: OpenAITTSProvider.
    Future: ElevenLabsProvider, Azure TTS.
    """

    def synthesize(
        self, text: str, voice: str, language: str
    ) -> SynthesisResult:
        """Convert text to speech audio.

        Args:
            text: The text to synthesize.
            voice: Voice identifier (e.g., "doctor", "patient").
                   Provider maps this to its internal voice IDs.
            language: ISO 639-1 language code for pronunciation hints.

        Returns:
            SynthesisResult with path to generated WAV file.

        Raises:
            SynthesisError: If synthesis fails.
        """
        ...


@runtime_checkable
class AudioStorage(Protocol):
    """Port for audio file persistence.

    Implementations: LocalFileStorage.
    Future: S3Storage, MinIOStorage.
    """

    def save(self, data: bytes, filename: str, directory: str) -> str:
        """Save raw audio bytes to storage.

        Args:
            data: Raw audio bytes.
            filename: Target filename (e.g., "abc123.ogg").
            directory: Subdirectory ("audio" or "generated").

        Returns:
            Absolute path to the saved file.

        Raises:
            StorageError: If write fails.
        """
        ...

    def get_url(self, file_path: str) -> str:
        """Generate a publicly accessible URL for a stored file.

        Args:
            file_path: Absolute path to the file.

        Returns:
            URL string (e.g., "http://localhost:8000/storage/generated/x.ogg").
        """
        ...

    def delete(self, file_path: str) -> None:
        """Delete a file from storage.

        Args:
            file_path: Absolute path to the file.

        Raises:
            StorageError: If deletion fails.
        """
        ...

    def exists(self, file_path: str) -> bool:
        """Check if a file exists in storage.

        Args:
            file_path: Absolute path to check.

        Returns:
            True if the file exists.
        """
        ...


@runtime_checkable
class AudioPreprocessor(Protocol):
    """Port for audio normalization and format conversion.

    Implementations: FFmpegPreprocessor.
    """

    def normalize(self, input_path: str, output_path: str) -> AudioMetadata:
        """Normalize audio to standard format for STT consumption.

        Target format: WAV, mono, 16000 Hz, 16-bit PCM.

        Args:
            input_path: Path to the source audio file (any format).
            output_path: Path where the normalized WAV will be written.

        Returns:
            AudioMetadata describing the normalized file.

        Raises:
            AudioProcessingError: If normalization fails.
        """
        ...

    def get_duration(self, file_path: str) -> float:
        """Get the duration of an audio file in seconds.

        Args:
            file_path: Path to the audio file.

        Returns:
            Duration in seconds.

        Raises:
            AudioProcessingError: If the file cannot be probed.
        """
        ...


@runtime_checkable
class AudioEncoder(Protocol):
    """Port for audio encoding/container conversion.

    Implementations: OggOpusEncoder.
    """

    def encode_to_ogg_opus(self, wav_path: str, output_path: str) -> str:
        """Encode a WAV file to OGG container with Opus codec.

        Args:
            wav_path: Path to the source WAV file.
            output_path: Path for the output .ogg file.

        Returns:
            Absolute path to the encoded .ogg file.

        Raises:
            AudioProcessingError: If encoding fails.
        """
        ...
