"""
Whisper Transcription Server — localhost-only HTTP API wrapping faster-whisper.

Endpoints:
  POST /transcribe  — Accepts JSON { "file_path": "/path/to/audio.oga" }
                       Returns JSON { "text": "...", "language": "hi", "confidence": 0.75 }
  GET  /health      — Returns { "status": "ok", "model": "small" }

Configuration via environment:
  WHISPER_MODEL    — Model size: tiny, base, small, medium, large (default: small)
  WHISPER_PORT     — Port to listen on (default: 5555)
"""
import os
import sys
import io
import json
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

# Force UTF-8 output on Windows
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

MODEL_SIZE = os.environ.get('WHISPER_MODEL', 'small')
PORT = int(os.environ.get('WHISPER_PORT', '5555'))

# Lazy-load model on first request
_model = None

def get_model():
    global _model
    if _model is None:
        print(f"[Whisper] Loading model '{MODEL_SIZE}' (device=cpu, compute_type=int8)...")
        load_start = time.time()
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        print(f"[Whisper] Model loaded in {time.time() - load_start:.1f}s")
    return _model

def transcribe_file(file_path):
    """Transcribe an audio file. Returns dict with text, language, confidence."""
    if not os.path.exists(file_path):
        return {"error": f"File not found: {file_path}", "text": "", "language": "", "confidence": 0}

    model = get_model()
    start = time.time()

    try:
        segments, info = model.transcribe(
            file_path,
            beam_size=5,
            language=None,  # Auto-detect
            vad_filter=True,
        )

        full_text = ""
        min_logprob = 0
        segment_count = 0
        for segment in segments:
            full_text += segment.text + " "
            min_logprob = min(min_logprob, segment.avg_logprob) if segment_count > 0 else segment.avg_logprob
            segment_count += 1

        elapsed = time.time() - start
        text = full_text.strip()

        print(f"[Whisper] Transcribed '{os.path.basename(file_path)}' in {elapsed:.1f}s "
              f"(lang={info.language}, prob={info.language_probability:.2f}, "
              f"duration={info.duration:.1f}s, segments={segment_count}): "
              f"\"{text[:80]}{'...' if len(text) > 80 else ''}\"")

        return {
            "text": text,
            "language": info.language or "",
            "confidence": round(info.language_probability, 3),
            "duration": round(info.duration, 1),
            "transcription_time": round(elapsed, 2),
            "segment_count": segment_count,
        }

    except Exception as e:
        elapsed = time.time() - start
        error_msg = str(e)
        print(f"[Whisper] ERROR transcribing '{os.path.basename(file_path)}' after {elapsed:.1f}s: {error_msg}")
        traceback.print_exc()
        return {
            "error": error_msg,
            "text": "",
            "language": "",
            "confidence": 0,
        }


class TranscribeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default access logs, we log manually
        pass

    def _send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_SIZE,
                "model_loaded": _model is not None,
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != '/transcribe':
            self._send_json(404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(content_length)
            body = json.loads(raw.decode('utf-8'))
        except Exception as e:
            self._send_json(400, {"error": f"Invalid JSON: {e}"})
            return

        file_path = body.get('file_path', '')
        if not file_path:
            self._send_json(400, {"error": "Missing 'file_path' in request body"})
            return

        result = transcribe_file(file_path)
        status = 200 if 'error' not in result else 500
        self._send_json(status, result)


def main():
    # Pre-load model at startup so first request isn't slow
    print(f"[Whisper] Starting transcription server on 127.0.0.1:{PORT}")
    print(f"[Whisper] Model size: {MODEL_SIZE}")
    get_model()

    server = HTTPServer(('127.0.0.1', PORT), TranscribeHandler)
    print(f"[Whisper] Server ready — listening on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Whisper] Shutting down...")
        server.server_close()


if __name__ == '__main__':
    main()
