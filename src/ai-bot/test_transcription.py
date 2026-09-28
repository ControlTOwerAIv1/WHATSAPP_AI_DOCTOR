"""
Test faster-whisper transcription on existing WhatsApp voice notes.
Tests with 'small' model first, reports accuracy and speed.
Fixed: UTF-8 encoding for Hindi/Devanagari output on Windows.
"""
import time
import os
import sys
import io

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def test_transcription(model_size="small"):
    print(f"\n{'='*60}")
    print(f"Testing faster-whisper with model: {model_size}")
    print(f"{'='*60}")
    
    # Check for audio files in media/
    media_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "media")
    audio_files = []
    if os.path.exists(media_dir):
        for f in os.listdir(media_dir):
            if f.endswith(".oga") or f.endswith(".ogg"):
                audio_files.append(os.path.join(media_dir, f))
    
    # Also grab .mp4 files but mark them as potentially video-only
    mp4_files = []
    if os.path.exists(media_dir):
        for f in os.listdir(media_dir):
            if f.endswith(".mp4"):
                mp4_files.append(os.path.join(media_dir, f))
    
    all_files = audio_files + mp4_files[:3]  # Only test first 3 mp4s to save time
    
    if not all_files:
        print("ERROR: No audio files found in media/ directory")
        return
    
    print(f"\nTesting {len(all_files)} file(s):")
    for f in all_files:
        size_kb = os.path.getsize(f) / 1024
        print(f"  - {os.path.basename(f)} ({size_kb:.1f} KB)")
    
    # Load model
    print(f"\nLoading {model_size} model...")
    load_start = time.time()
    
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    
    load_time = time.time() - load_start
    print(f"Model loaded in {load_time:.1f}s")
    
    # Transcribe each file
    for audio_path in all_files:
        print(f"\n--- Transcribing: {os.path.basename(audio_path)} ---")
        file_size_kb = os.path.getsize(audio_path) / 1024
        print(f"File size: {file_size_kb:.1f} KB")
        
        trans_start = time.time()
        
        try:
            segments, info = model.transcribe(
                audio_path,
                beam_size=5,
                language=None,  # Auto-detect
                vad_filter=True,
            )
            
            # Collect all segments
            full_text = ""
            segment_details = []
            for segment in segments:
                full_text += segment.text + " "
                segment_details.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                    "avg_logprob": segment.avg_logprob,
                    "no_speech_prob": segment.no_speech_prob,
                })
            
            trans_time = time.time() - trans_start
            
            print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")
            print(f"Transcription time: {trans_time:.2f}s")
            print(f"Audio duration: {info.duration:.1f}s")
            if trans_time > 0:
                print(f"Speed ratio: {info.duration / trans_time:.1f}x realtime")
            print(f"\nFull transcript:")
            print(f'  "{full_text.strip()}"')
            
            if segment_details:
                print(f"\nSegment details:")
                for i, seg in enumerate(segment_details):
                    confidence = f"logprob={seg['avg_logprob']:.2f}, no_speech={seg['no_speech_prob']:.2f}"
                    print(f"  [{seg['start']:.1f}s - {seg['end']:.1f}s] ({confidence})")
                    print(f'    "{seg["text"].strip()}"')
            
        except Exception as e:
            trans_time = time.time() - trans_start
            err_msg = str(e)
            if "tuple index out of range" in err_msg:
                print(f"SKIPPED: No audio stream in file (video-only mp4)")
            else:
                print(f"ERROR: Transcription failed after {trans_time:.2f}s: {e}")

if __name__ == "__main__":
    model_size = sys.argv[1] if len(sys.argv) > 1 else "small"
    test_transcription(model_size)
