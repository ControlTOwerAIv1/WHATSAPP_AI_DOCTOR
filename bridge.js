/**
 * ECHO WhatsApp Bridge - Full Media Support
 * Supports: text, images, video, audio, documents, stickers, location
 *
 * Install:
 *   npm install @whiskeysockets/baileys @hapi/boom express socket.io qrcode cors multer mime-types better-sqlite3
 *
 * Entrypoint only — wires together src/db.js (persistence), src/stores.js
 * (in-memory state + chat locking), src/whatsapp.js (Baileys connection),
 * and src/routes.js (REST + Socket.IO API), then starts listening.
 */

const path = require('path');

const ROOT_DIR = __dirname;

// Must run before any other module logs anything, so nothing is missed.
const { setupFileLogging } = require('./src/logging');
setupFileLogging(ROOT_DIR);

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

const { RelayDatabase } = require('./src/db');
const stores = require('./src/stores');
const whatsapp = require('./src/whatsapp');
const { registerRoutes } = require('./src/routes');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50 * 1024 * 1024,
});

app.use(cors());
app.use(express.json());

// Serve the operator dashboard (and its css/js) from public/.
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
app.use(express.static(PUBLIC_DIR));
const DASHBOARD_FILE = path.join(PUBLIC_DIR, 'dashboard.html');
app.get('/', (req, res) => {
  res.sendFile(DASHBOARD_FILE);
});
app.get('/dashboard.html', (req, res) => {
  res.sendFile(DASHBOARD_FILE);
});

// Media storage setup
const MEDIA_DIR = path.join(ROOT_DIR, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR));

// Configuration
const CONFIG = {
  MAX_MESSAGES_PER_CHAT: 500,
  SAVE_DEBOUNCE_MS: 2000,
  DB_PATH: './relay.sqlite',
  RELEASE_ASSIGNMENTS_ON_DISCONNECT: true,
  MESSAGE_EDIT_WINDOW_SECONDS: 15 * 60,
  MESSAGE_DELETE_FOR_EVERYONE_WINDOW_SECONDS: 60 * 60 * 60,
};
try {
  const configFile = path.join(ROOT_DIR, 'config.json');
  if (fs.existsSync(configFile)) {
    Object.assign(CONFIG, JSON.parse(fs.readFileSync(configFile, 'utf8')));
  }
} catch (e) {
  console.error('[Bridge] Failed to load config.json:', e.message);
}

// Wire up modules. Order matters: stores must exist before the database can be
// constructed (it injects stores' normalizers), and both must be wired with
// `io`/`database` before whatsapp/routes are initialized.
stores.init({ rootDir: ROOT_DIR, config: CONFIG });

const database = new RelayDatabase(CONFIG.DB_PATH, ROOT_DIR, CONFIG, {
  normalizeChat: stores.normalizeChat,
  normalizeMessageRecord: stores.normalizeMessageRecord,
  toTimestamp: stores.toTimestamp,
});

stores.setDatabase(database);
stores.setIo(io);
stores.loadStore();

whatsapp.init({ stores, database, io, ROOT_DIR, MEDIA_DIR });

registerRoutes({ app, io, stores, database, whatsapp, CONFIG, MEDIA_DIR });

const PORT = process.env.PORT || 3001;

process.on('uncaughtException', (err) => {
  console.error('\n❌ FATAL ERROR:', err.message);
  console.error(err.stack);
  console.error('\nPress Ctrl+C to exit...');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ UNHANDLED REJECTION:', reason);
});

try {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('   ECHO WhatsApp Bridge - Running');
    console.log('========================================\n');
    console.log('Server started successfully!');
    console.log(`\nAccess URL: http://localhost:${PORT}`);
    console.log(`Network URL: http://<YOUR_PC_IP>:${PORT}`);
    console.log(`\nWaiting for WhatsApp authentication...`);
    console.log('========================================\n');
    whatsapp.connectToWhatsApp();
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ ERROR: Port ${PORT} is already in use!`);
      console.error('   • Close other applications using this port');
      console.error('   • Or set PORT environment variable to a different port');
    } else {
      console.error(`\n❌ Server error: ${err.message}`);
    }
    process.exit(1);
  });
} catch (err) {
  console.error('\n❌ Failed to start server:', err.message);
  console.error(err.stack);
  console.error('\nPress Ctrl+C to exit...');
}
