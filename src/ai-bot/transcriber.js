/**
 * AI Bot — Transcriber Client
 *
 * Node.js client for the local faster-whisper Python transcription server.
 * Sends audio file paths to the server and receives transcriptions.
 *
 * If the server is down or unreachable, returns null gracefully (never throws).
 */

const http = require('http');

const WHISPER_PORT = parseInt(process.env.WHISPER_PORT || '5555', 10);
const WHISPER_HOST = '127.0.0.1';
const TIMEOUT_MS = 60000; // 60 second timeout for transcription

/**
 * Transcribe an audio file via the local Python server.
 * @param {string} filePath - Absolute path to the audio file
 * @returns {Promise<{text: string, language: string, confidence: number, duration: number, transcription_time: number}|null>}
 */
async function transcribe(filePath) {
  try {
    const body = JSON.stringify({ file_path: filePath });

    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: WHISPER_HOST,
          port: WHISPER_PORT,
          path: '/transcribe',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const data = JSON.parse(raw);
              resolve(data);
            } catch (e) {
              reject(new Error(`Invalid JSON from transcription server: ${e.message}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        reject(new Error(`Transcription server unreachable: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Transcription request timed out'));
      });

      req.write(body);
      req.end();
    });

    // Check for server-side errors
    if (result.error) {
      console.warn(`[Transcriber] Server error: ${result.error}`);
      return null;
    }

    // Check for empty/low-quality transcription
    if (!result.text || result.text.trim().length === 0) {
      console.log('[Transcriber] Empty transcription returned');
      return null;
    }

    return result;
  } catch (err) {
    console.warn(`[Transcriber] ${err.message}`);
    return null;
  }
}

/**
 * Check if the transcription server is running and healthy.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: WHISPER_HOST,
          port: WHISPER_PORT,
          path: '/health',
          method: 'GET',
          timeout: 3000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve(data.status === 'ok');
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    return result;
  } catch {
    return false;
  }
}

const { spawn } = require('child_process');
const path = require('path');

let _serverProcess = null;

/**
 * Ensure the Whisper transcription server is running.
 * If not already available, automatically spawns the Python server.
 * @returns {Promise<boolean>}
 */
async function ensureServerRunning() {
  const healthy = await isAvailable();
  if (healthy) {
    console.log(`[Transcriber] ✅ Whisper transcription server is already running on port ${WHISPER_PORT}`);
    return true;
  }

  console.log('[Transcriber] 🚀 Starting Python Whisper transcription server...');
  const scriptPath = path.join(__dirname, 'transcribe-server.py');

  try {
    _serverProcess = spawn('python', ['-u', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: 'pipe',
      detached: false,
    });

    _serverProcess.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[Whisper] ${line}`);
    });

    _serverProcess.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.warn(`[Whisper] ${line}`);
    });

    _serverProcess.on('exit', (code) => {
      console.warn(`[Transcriber] Whisper server process exited with code ${code}`);
      _serverProcess = null;
    });

    // Wait up to 30 seconds for server to become healthy
    const start = Date.now();
    while (Date.now() - start < 30000) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isAvailable()) {
        console.log('[Transcriber] ✅ Whisper transcription server is ready and healthy!');
        return true;
      }
    }
    console.warn('[Transcriber] Whisper server did not become healthy within 30s');
    return false;
  } catch (err) {
    console.error('[Transcriber] Failed to spawn Whisper server:', err.message);
    return false;
  }
}

process.on('exit', () => {
  if (_serverProcess) {
    try { _serverProcess.kill(); } catch (_) {}
  }
});

module.exports = {
  transcribe,
  isAvailable,
  ensureServerRunning,
};
