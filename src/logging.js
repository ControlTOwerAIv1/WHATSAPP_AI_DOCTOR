/**
 * Tees everything written to stdout/stderr into logs/bridge.log, in addition
 * to the terminal, so a crash (including the events leading up to it) stays
 * traceable after the terminal scrollback is gone. Must be required and
 * called before any other module that might log at require-time.
 */

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 20 * 1024 * 1024; // 20MB — rotate so repeated dev restarts don't grow this forever.

function setupFileLogging(rootDir) {
  const logsDir = path.join(rootDir, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, 'bridge.log');

  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      const rotated = path.join(logsDir, 'bridge.log.1');
      fs.rmSync(rotated, { force: true });
      fs.renameSync(logFile, rotated);
    }
  } catch (e) {
    // Non-critical — if rotation fails, just keep appending to the existing file.
  }

  const stream = fs.createWriteStream(logFile, { flags: 'a' });

  const tee = (originalWrite) => function (chunk, encoding, callback) {
    try {
      stream.write(chunk, typeof encoding === 'string' ? encoding : undefined);
    } catch (e) {
      // Never let a logging failure break the app's actual output.
    }
    return originalWrite(chunk, encoding, callback);
  };

  process.stdout.write = tee(process.stdout.write.bind(process.stdout));
  process.stderr.write = tee(process.stderr.write.bind(process.stderr));

  stream.write(`\n=== Bridge started: ${new Date().toISOString()} (pid ${process.pid}) ===\n`);

  process.on('exit', () => {
    try { stream.end(); } catch (e) {}
  });
}

module.exports = { setupFileLogging };
