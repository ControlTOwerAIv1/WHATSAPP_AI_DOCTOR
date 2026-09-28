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

module.exports = {
  transcribe,
  isAvailable,
};
