const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT_DIR = __dirname;
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const serverLog = fs.createWriteStream(path.join(LOGS_DIR, 'server_runner.log'), { flags: 'a' });
const cloudflaredLog = fs.createWriteStream(path.join(LOGS_DIR, 'cloudflared.log'), { flags: 'w' });

// Clear any existing cloudflare_url.txt
const urlFile = path.join(ROOT_DIR, 'cloudflare_url.txt');
if (fs.existsSync(urlFile)) {
  fs.unlinkSync(urlFile);
}

console.log('[Runner] Starting bridge.js...');
const server = spawn(process.execPath, ['--max-old-space-size=4096', 'bridge.js'], {
  cwd: ROOT_DIR,
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stdout.pipe(serverLog);
server.stderr.pipe(serverLog);

let tunnelProcess = null;

server.on('exit', (code, signal) => {
  const msg = `[Runner] Server exited with code ${code} signal ${signal}\n`;
  console.log(msg);
  serverLog.write(msg);
});

// Find cloudflared binary
let cloudflaredBin = 'cloudflared';
const defaultCloudflaredPath = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
if (fs.existsSync(defaultCloudflaredPath)) {
  cloudflaredBin = defaultCloudflaredPath;
}

function checkPort(retries = 30) {
  const req = http.get('http://127.0.0.1:3000/login', (res) => {
    console.log(`[Runner] Server is responding with HTTP ${res.statusCode}`);
    startTunnel();
  });
  req.on('error', () => {
    if (retries > 0) {
      setTimeout(() => checkPort(retries - 1), 1000);
    } else {
      console.log('[Runner] Timeout waiting for server, starting tunnel anyway...');
      startTunnel();
    }
  });
}

function startTunnel() {
  console.log(`[Runner] Starting cloudflared tunnel using ${cloudflaredBin}...`);
  tunnelProcess = spawn(cloudflaredBin, ['tunnel', '--url', 'http://localhost:3000'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
  let foundUrl = false;

  const onData = (chunk) => {
    const text = chunk.toString();
    cloudflaredLog.write(text);
    if (!foundUrl) {
      const match = text.match(urlRegex);
      if (match) {
        foundUrl = true;
        const url = match[0];
        console.log(`[Runner] CLOUDFLARE URL: ${url}`);
        fs.writeFileSync(urlFile, url, 'utf8');
      }
    }
  };

  tunnelProcess.stdout.on('data', onData);
  tunnelProcess.stderr.on('data', onData);

  tunnelProcess.on('exit', (code, signal) => {
    const msg = `[Runner] Tunnel exited with code ${code} signal ${signal}\n`;
    console.log(msg);
    cloudflaredLog.write(msg);
  });
}

process.on('SIGINT', () => {
  if (server) server.kill();
  if (tunnelProcess) tunnelProcess.kill();
  process.exit();
});

process.on('SIGTERM', () => {
  if (server) server.kill();
  if (tunnelProcess) tunnelProcess.kill();
  process.exit();
});

setTimeout(() => checkPort(), 1500);
