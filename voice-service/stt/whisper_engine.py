"""
Whisper Engine — faster-whisper adapter implementing SpeechRecognizer.

Uses CTranslate2-accelerated Whisper for local, multilingual speech recognition.
The model is loaded once at init (via dependency injection) and reused across
all requests — CTranslate2 inference is thread-safe.

Supports:
  - Multilingual transcription (auto-detect or forced language)
  - Segment-level timestamps with start/end times
  - Per-segment confidence scores (averaged for overall confidence)
  - Configurable model size, device, and compute type
"""

from __future__ import annotations

from faster_whisper import WhisperModel

from core.config import VoiceServiceConfig
from core.exceptions import TranscriptionError
from core.logging import get_logger
from domain.entities import TimestampSegment, TranscriptionResult

logger = get_logger(__name__)


class WhisperEngine:
    """Speech recognizer powered by faster-whisper (CTranslate2).

    Satisfies the SpeechRecognizer protocol via structural subtyping.
    The caller (TranscribeUseCase) only sees the SpeechRecognizer interface.
    """

    def __init__(self, config: VoiceServiceConfig) -> None:
        """Initialize the Whisper model.

        Model weights are downloaded on first use and cached in
        ~/.cache/huggingface/hub/ (or the WHISPER_MODEL_CACHE env var).

        Args:
            config: Application configuration with model parameters.
        """
        self._model_size = config.whisper_model_size
        self._device = config.whisper_device
        self._compute_type = config.whisper_compute_type
        self._beam_size = config.whisper_beam_size
        self._language = config.whisper_language  # None = auto-detect
        self._model: WhisperModel | None = None

    def _get_model(self) -> WhisperModel:
        """Lazy-load the Whisper model on first use.

        Lazy loading avoids slow startup when the model isn't immediately
        needed (e.g., health check requests).
        """
        if self._model is None:
            logger.info(
                "whisper_model_loading",
                stage="stt",
                model_size=self._model_size,
                device=self._device,
                compute_type=self._compute_type,
            )
            try:
                self._model = WhisperModel(
                    self._model_size,
                    device=self._device,
                    compute_type=self._compute_type,
                )
            except Exception as exc:
                raise TranscriptionError(
                    f"Failed to load Whisper model '{self._model_size}': {exc}",
                    details={
                        "model_size": self._model_size,
                        "device": self._device,
                        "compute_type": self._compute_type,
                    },
                ) from exc

            logger.info(
                "whisper_model_loaded",
                stage="stt",
                model_size=self._model_size,
            )
        return self._model

    def transcribe(self, audio_path: str) -> TranscriptionResult:
        """Transcribe a normalized audio file.

        Expects WAV/mono/16kHz input (output of FFmpegPreprocessor).

        Args:
            audio_path: Absolute path to the normalized WAV file.

        Returns:
            TranscriptionResult with transcript, language, confidence,
            and timestamped segments.

        Raises:
            TranscriptionError: If inference fails.
        """
        model = self._get_model()

        logger.info(
            "transcription_started",
            stage="stt",
            audio_path=audio_path,
            model_size=self._model_size,
        )

        try:
            segments_generator, info = model.transcribe(
                audio_path,
                beam_size=self._beam_size,
                language=self._language,
                word_timestamps=False,
                vad_filter=True,  # Skip silence for speed
            )

            # Materialize the generator into a list of segments
            segments_list = list(segments_generator)

        except Exception as exc:
            raise TranscriptionError(
                f"Whisper transcription failed: {exc}",
                details={"audio_path": audio_path},
            ) from exc

        # Build timestamp segments
        timestamps: list[TimestampSegment] = []
        confidence_scores: list[float] = []

        for segment in segments_list:
            timestamps.append(
                TimestampSegment(
                    start=round(segment.start, 3),
                    end=round(segment.end, 3),
                    text=segment.text.strip(),
                )
            )
            # avg_logprob is log-probability; convert to 0-1 confidence
            # using a sigmoid-like mapping: higher (less negative) = more confident
            if hasattr(segment, "avg_logprob") and segment.avg_logprob is not None:
                # Map avg_logprob (typically -1.0 to 0.0) to a 0-1 range
                import math
                raw = segment.avg_logprob
                confidence = 1.0 / (1.0 + math.exp(-2.0 * (raw + 0.5)))
                confidence_scores.append(confidence)

        # Assemble full transcript
        full_transcript = " ".join(ts.text for ts in timestamps).strip()

        # Overall confidence is the mean of segment confidences
        overall_confidence = (
            sum(confidence_scores) / len(confidence_scores)
            if confidence_scores
            else 0.0
        )

        detected_language = info.language if info.language else "unknown"

        result = TranscriptionResult(
            transcript=full_transcript,
            detected_language=detected_language,
            confidence=round(overall_confidence, 4),
            timestamps=timestamps,
        )

        logger.info(
            "transcription_complete",
            stage="stt",
            detected_language=detected_language,
            confidence=result.confidence,
            segment_count=len(timestamps),
            transcript_length=len(full_transcript),
        )

        return result
