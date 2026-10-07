/**
 * Express REST API and Socket.IO operator-facing events.
 * Owns the connected-operator registry (who's at the dashboard right now),
 * separate from stores.js which owns chat/message/contact data.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const mime = require('mime-types');
const store = require('./ai-bot/store');

function registerRoutes({ app, io, stores, database, whatsapp, CONFIG, MEDIA_DIR }) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = path.extname(file.originalname) || `.${mime.extension(file.mimetype) || 'bin'}`;
      cb(null, unique + ext);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

  // Operator registry (connected dashboard sockets)
  const operators = new Map(); // socketId -> { id, name, connectedAt, socketId }

  function buildOperator(socketLike) {
    if (!socketLike) return null;
    return {
      id: socketLike.id,
      name: socketLike.name || socketLike.id,
    };
  }

  function getOperatorFromSocket(socket) {
    return buildOperator(operators.get(socket.id));
  }

  function getOperatorFromRequest(req) {
    const id = req.headers['x-operator-id'] || req.body.operatorId || req.query.operatorId;
    const name = req.headers['x-operator-name'] || req.body.operatorName || req.query.operatorName || id;
    if (!id) return null;
    return { id, name };
  }

  function broadcastOperators() {
    const list = Array.from(operators.values()).map((op) => ({
      id: op.id,
      name: op.name,
      connectedAt: op.connectedAt,
    }));
    io.emit('operators', list);
  }

  const notConnected = (res) => res.status(503).json({ error: 'Not connected to WhatsApp' });

  function getFirstLanIpv4() {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
        if (addr.address.startsWith('169.254.')) continue;
        return addr.address;
      }
    }
    return null;
  }

  function getBridgeLiveAddress(req) {
    const forwardedHost = (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
    const hostHeader = forwardedHost || req.get('host') || '';

    let host = hostHeader;
    let port = '';
    if (host.startsWith('[')) {
      const idx = host.indexOf(']');
      if (idx > -1) {
        const rest = host.slice(idx + 1);
        if (rest.startsWith(':')) port = rest.slice(1);
        host = host.slice(1, idx);
      }
    } else {
      const parts = host.split(':');
      host = parts[0] || '';
      port = parts[1] || '';
    }

    const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
    if (loopbackHosts.has(host)) {
      host = getFirstLanIpv4() || host;
    }

    const resolvedPort = port || String(process.env.PORT || 3001);
    return `${host}${resolvedPort ? `:${resolvedPort}` : ''}`;
  }

  function getBridgeLiveUrl(req) {
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    return `${protocol}://${getBridgeLiveAddress(req)}`;
  }

  // ── Meta WhatsApp Cloud API Webhook Endpoints ─────────────────────────

  /**
   * Verify X-Hub-Signature-256 on the raw request body.
   * Returns true if OK. Returns false and sends 403 if invalid.
   * Skips (returns true) if WHATSAPP_APP_SECRET is not configured (warns once).
   */
  function _verifyWebhookSignature(req, res) {
    const appSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '';
    const sigHeader = req.headers['x-hub-signature-256'] || '';

    if (!appSecret) {
      if (!_verifyWebhookSignature._warned) {
        console.warn('[Webhook] WHATSAPP_APP_SECRET not set — skipping signature verification');
        _verifyWebhookSignature._warned = true;
      }
      return true;
    }

    if (!sigHeader) {
      console.warn('[Webhook] ⚠️ Rejected POST /webhook: missing X-Hub-Signature-256');
      res.status(403).json({ error: 'Missing signature' });
      return false;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      console.warn('[Webhook] ⚠️ Rejected POST /webhook: raw body not available');
      res.status(403).json({ error: 'Bad request' });
      return false;
    }

    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const sigBuf   = Buffer.from(sigHeader);
    const expBuf   = Buffer.from(expected);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn('[Webhook] ⚠️ Rejected POST /webhook: signature mismatch');
      res.status(403).json({ error: 'Invalid signature' });
      return false;
    }

    return true;
  }

  app.get('/webhook', (req, res) => {
    whatsapp.handleWebhookVerification(req, res);
  });

  app.post('/webhook', async (req, res) => {
    if (!_verifyWebhookSignature(req, res)) return;
    res.sendStatus(200);
    try {
      if (typeof whatsapp.handleWebhookPayload === 'function') {
        await whatsapp.handleWebhookPayload(req.body);
      }
    } catch (err) {
      console.error('[Routes] Webhook processing error:', err.message);
    }
  });

  app.get('/api/webhook', (req, res) => {
    whatsapp.handleWebhookVerification(req, res);
  });

  app.post('/api/webhook', async (req, res) => {
    if (!_verifyWebhookSignature(req, res)) return;
    res.sendStatus(200);
    try {
      if (typeof whatsapp.handleWebhookPayload === 'function') {
        await whatsapp.handleWebhookPayload(req.body);
      }
    } catch (err) {
      console.error('[Routes] Webhook processing error:', err.message);
    }
  });

  // ── Dashboard Auth (login / logout) ─────────────────────────────────

  function _getAdminHash() {
    return process.env.ECHO_ADMIN_PASSWORD_HASH || '';
  }

  function _getAdminUser() {
    return process.env.ECHO_ADMIN_USER || 'admin';
  }

  function _verifyPassword(plain, hash) {
    // Constant-time bcrypt comparison
    try {
      const bcrypt = require('bcrypt');
      return bcrypt.compareSync(plain, hash);
    } catch {
      // bcrypt not installed — fall back to argon2 if available
      try {
        const argon2 = require('argon2');
        return argon2.verify(hash, plain); // returns Promise but we call sync fallback
      } catch {
        return false;
      }
    }
  }

  // Public login endpoint (not protected)
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const ip = req.ip || req.socket?.remoteAddress || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    if (store.isLoginRateLimited(ip, username)) {
      console.warn(`[Auth] Rate-limited login attempt from ${ip} for user ${username}`);
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    const adminUser = _getAdminUser();
    const adminHash = _getAdminHash();

    if (!adminHash) {
      console.error('[Auth] ECHO_ADMIN_PASSWORD_HASH not set — dashboard login disabled');
      return res.status(503).json({ error: 'Dashboard login not configured' });
    }

    // Constant-time username comparison
    const userBuf = Buffer.from(username);
    const adminBuf = Buffer.from(adminUser);
    const userMatch = userBuf.length === adminBuf.length && crypto.timingSafeEqual(userBuf, adminBuf);

    let passwordMatch = false;
    try {
      const bcrypt = require('bcrypt');
      passwordMatch = await bcrypt.compare(password, adminHash);
    } catch {
      // bcrypt not installed, try timing-safe constant-time hash compare as fallback
      passwordMatch = false;
    }

    if (!userMatch || !passwordMatch) {
      store.recordLoginAttempt(ip, username);
      console.warn(`[Auth] Failed login attempt: user=${username} ip=${ip}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Successful login — create session
    const token = crypto.randomBytes(32).toString('hex');
    store.createSession(username, token);

    res.cookie('echo_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 24 * 60 * 60 * 1000, // 24h max cookie life
    });

    console.log(`[Auth] Login successful: user=${username} ip=${ip}`);
    res.json({ success: true, username });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.echo_session;
    if (token) store.deleteSession(token);
    res.clearCookie('echo_session');
    res.json({ success: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const token = req.cookies?.echo_session;
    const session = store.getSession(token);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ username: session.username });
  });

  // ── Session authentication middleware (protects all /api/* except auth routes) ─

  function _requireSession(req, res, next) {
    const adminHash = _getAdminHash();
    if (!adminHash) return next();

    // Public routes: webhook verification is handled separately; auth endpoints are public
    const PUBLIC_PREFIXES = ['/api/auth/', '/api/webhook', '/api/health'];
    if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();
    const token = req.cookies?.echo_session;
    if (!store.getSession(token)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  }

  app.use('/api', _requireSession);

  app.get('/api/status', (req, res) => {
    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    const bridgeLiveAddress = getBridgeLiveAddress(req);
    res.json({
      status: whatsapp.getStatus(),
      connectorOperatorId,
      connectorOperatorName,
      bridgeLiveAddress,
      bridgeLiveUrl: getBridgeLiveUrl(req),
    });
  });

  app.get('/api/bridge/live', (req, res) => {
    const bridgeLiveAddress = getBridgeLiveAddress(req);
    res.json({
      bridgeLiveAddress,
      bridgeLiveUrl: getBridgeLiveUrl(req),
    });
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      const operator = getOperatorFromRequest(req);
      const { id: connectorOperatorId } = stores.getConnectorOperator();
      if (connectorOperatorId && (!operator || operator.id !== connectorOperatorId)) {
        return res.status(403).json({ error: 'Only the operator who connected WhatsApp first can disconnect it.' });
      }
      await whatsapp.disconnectWhatsApp();
      res.json({ success: true, message: 'WhatsApp session disconnected and reset.' });
    } catch (err) {
      console.error('[Bridge] Failed to disconnect WhatsApp:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/health', (req, res) =>
    res.json({ uptime: process.uptime(), status: whatsapp.getStatus(), operators: operators.size, chats: Object.keys(stores.chatStore).length })
  );
  app.get('/api/bot/mode', (req, res) => {
    res.json({ mode: store.getBotMode() });
  });
  app.post('/api/bot/mode', (req, res) => {
    const { mode } = req.body || {};
    if (!mode || (mode !== 'ai' && mode !== 'manual')) {
      return res.status(400).json({ error: "mode must be 'ai' or 'manual'" });
    }
    const newMode = store.setBotMode(mode);
    io.emit('bot_mode_changed', { mode: newMode });
    res.json({ success: true, mode: newMode });
  });
  app.get('/api/operators', (req, res) =>
    res.json(Array.from(operators.values()).map((op) => ({ id: op.id, name: op.name, connectedAt: op.connectedAt })))
  );
  app.get('/api/groups', (req, res) => res.json(Object.values(stores.groupStore)));
  app.get('/api/chats', (req, res) => res.json(stores.sortedChats()));
  app.get('/api/contacts/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json([]);
    const results = Object.values(stores.contactStore)
      .filter((contact) => {
        const name = (contact.name || contact.notify || '').toLowerCase();
        const phone = (contact.id || '').split('@')[0].split(':')[0];
        return name.includes(q) || phone.includes(q);
      })
      .slice(0, 20)
      .map((contact) => ({
        id: contact.id,
        name: contact.name || contact.notify || contact.id.split('@')[0].split(':')[0],
        phone: contact.id.split('@')[0].split(':')[0],
      }));
    res.json(results);
  });

  function parseVcfContacts(content) {
    const unfolded = content.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
    const contactsList = [];
    const cards = unfolded.split('BEGIN:VCARD');

    for (const card of cards) {
      if (!card.trim()) continue;

      const nameMatch = card.match(/^FN(?:;[^:]*)?:(.+)$/m);
      if (!nameMatch) continue;

      const name = nameMatch[1].trim();
      const telMatches = card.matchAll(/^TEL[^:]*:([^\n]+)/gm);

      for (const match of telMatches) {
        let digits = match[1].replace(/\D/g, '');
        if (digits.length < 7) continue;

        if (digits.startsWith('00')) {
          digits = digits.slice(2);
        }

        if (!contactsList.some(c => c.phone === digits)) {
          contactsList.push({ phone: digits, name });
        }
      }
    }
    return contactsList;
  }

  app.get('/api/contacts', (req, res) => {
    try {
      const contacts = Object.values(stores.contactStore)
        .map((c) => ({
          id: c.id,
          name: c.name || c.notify || c.verifiedName || c.id.split('@')[0].split(':')[0],
          phone: c.id.split('@')[0].split(':')[0],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json(contacts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const vcfPath = req.file.path;
    try {
      const content = fs.readFileSync(vcfPath, 'utf8');
      const parsedContacts = parseVcfContacts(content);

      let imported = 0;
      let skipped = 0;

      const existingByFullPhone = new Map();
      const existingByLast10 = new Map();

      for (const jid of Object.keys(stores.contactStore)) {
        const p = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (p) {
          if (!existingByFullPhone.has(p)) existingByFullPhone.set(p, []);
          existingByFullPhone.get(p).push(jid);

          if (p.length >= 10) {
            const last10 = p.slice(-10);
            if (!existingByLast10.has(last10)) existingByLast10.set(last10, []);
            existingByLast10.get(last10).push(jid);
          }
        }
      }

      for (const c of parsedContacts) {
        const matchedJidsSet = new Set();
        const fullMatches = existingByFullPhone.get(c.phone);
        if (fullMatches) {
          for (const j of fullMatches) matchedJidsSet.add(j);
        }
        if (c.phone.length >= 10) {
          const last10Matches = existingByLast10.get(c.phone.slice(-10));
          if (last10Matches) {
            for (const j of last10Matches) matchedJidsSet.add(j);
          }
        }

        if (matchedJidsSet.size > 0) {
          let updated = false;
          for (const matchedJid of matchedJidsSet) {
            const contactObj = stores.contactStore[matchedJid];
            if (contactObj) {
              if (contactObj.name !== c.name || contactObj.notify !== c.name) {
                contactObj.name = c.name;
                contactObj.notify = c.name;
                database.upsertContact(contactObj);
                updated = true;
              }
            }

            const chatObj = stores.chatStore[matchedJid];
            if (chatObj && chatObj.name !== c.name) {
              chatObj.name = c.name;
              database.upsertChat(chatObj);
              updated = true;
            }
          }

          if (updated) {
            imported++;
          } else {
            skipped++;
          }
        } else {
          const jid = `${c.phone}@s.whatsapp.net`;
          const contactObj = { id: jid, name: c.name, notify: c.name };
          stores.contactStore[jid] = contactObj;
          database.upsertContact(contactObj);

          if (!existingByFullPhone.has(c.phone)) existingByFullPhone.set(c.phone, []);
          existingByFullPhone.get(c.phone).push(jid);

          if (c.phone.length >= 10) {
            const last10 = c.phone.slice(-10);
            if (!existingByLast10.has(last10)) existingByLast10.set(last10, []);
            existingByLast10.get(last10).push(jid);
          }

          imported++;
        }
      }

      try { fs.unlinkSync(vcfPath); } catch { }

      io.emit('contacts_updated');
      stores.broadcastChats();
      stores.saveStore();

      res.json({ success: true, imported, skipped });
    } catch (err) {
      try { fs.unlinkSync(vcfPath); } catch { }
      console.error('[Bridge] Contact import failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/messages', async (req, res) => {
    const { jid, limit = 50, before } = req.query;
    if (!jid) {
      const allMsgs = Object.values(stores.messageStore)
        .flat()
        .sort((a, b) => stores.toTimestamp(a.timestamp) - stores.toTimestamp(b.timestamp));
      return res.json(allMsgs.slice(-Number(limit)));
    }

    // Hydrate from DB if cold before returning list
    if (!stores.messageStore[jid] || stores.messageStore[jid].length === 0) {
      try {
        const dbMsgsStmt = database.db.prepare(
          'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
        );
        const rows = dbMsgsStmt.all(jid, CONFIG.MAX_MESSAGES_PER_CHAT);
        if (rows.length > 0) {
          stores.messageStore[jid] = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
        }
      } catch (dbErr) {
        console.warn(`[Bridge] API messages DB hydration error for ${jid}:`, dbErr.message);
      }
    }

    const filterToBefore = (list) => {
      if (!before) return list;
      const beforeTs = Number(before);
      return list.filter((msg) => stores.toTimestamp(msg.timestamp) < beforeTs);
    };

    const msgs = filterToBefore(stores.getMessagesForJid(jid));
    const total = msgs.length;
    const sliced = msgs.slice(-Number(limit));
    res.json({ messages: sliced, hasMore: total > sliced.length, total, chat: stores.normalizeChat(stores.chatStore[jid]) || null });
  });

  app.get('/api/messages/search', async (req, res) => {
    try {
      const { jid, q } = req.query;
      if (!jid || !q) {
        return res.status(400).json({ error: 'jid and query q are required' });
      }

      const sql = `
        SELECT payload FROM messages
        WHERE jid = ?
          AND (
            json_extract(payload, '$.content') LIKE ?
            OR json_extract(payload, '$.fileName') LIKE ?
            OR json_extract(payload, '$.sender') LIKE ?
            OR json_extract(payload, '$.operatorName') LIKE ?
          )
        ORDER BY timestamp DESC, id DESC
      `;
      
      const searchPattern = `%${q}%`;
      const queryParams = [jid, searchPattern, searchPattern, searchPattern, searchPattern];
      
      const stmt = database.db.prepare(sql);
      const rows = stmt.all(...queryParams);
      
      const messages = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
      res.json({ messages });
    } catch (err) {
      console.error('[Bridge] Message search failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/chats/:jid/claim', (req, res) => {
    const operator = getOperatorFromRequest(req);
    const result = stores.assignChat(req.params.jid, operator);
    if (!result.ok) return res.status(result.status).json({ error: result.message, chat: result.chat });
    res.json({ success: true, chat: result.chat });
  });

  app.post('/api/chats/:jid/release', (req, res) => {
    const operator = getOperatorFromRequest(req);
    const result = stores.releaseChat(req.params.jid, operator);
    if (!result.ok) return res.status(result.status).json({ error: result.message, chat: result.chat });
    res.json({ success: true, chat: result.chat });
  });

  app.post('/api/send', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const jid = req.body.jid;
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const options = req.body.quotedMessageId ? { quotedMessageId: req.body.quotedMessageId } : {};
      const result = await sock.sendMessage(jid, { text: req.body.text }, options);
      const quotedMsg = req.body.quotedMessageId ? stores.findMessageInThread(jid, req.body.quotedMessageId) : null;
      const message = await stores.recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: req.body.text,
          mediaType: 'text',
          clientTempId: req.body.clientTempId || null,
          quotedMessageId: quotedMsg?.id || null,
          quotedContent: quotedMsg?.content || null,
          quotedSender: quotedMsg?.sender || null,
          quotedMediaType: quotedMsg?.mediaType || null,
        },
      });
      res.json({ success: true, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/send/image', upload.single('file'), async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const jid = req.body.jid;
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(jid, {
        image: fs.readFileSync(req.file.path),
        caption: req.body.caption || '',
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: req.body.caption || '',
          mediaType: 'image',
          mediaUrl: `/media/${req.file.filename}`,
          fileName: req.file.originalname,
          mimetype: req.file.mimetype,
          clientTempId: req.body.clientTempId || null,
        },
      });
      res.json({ success: true, mediaUrl: `/media/${req.file.filename}`, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/send/video', upload.single('file'), async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const jid = req.body.jid;
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(jid, {
        video: fs.readFileSync(req.file.path),
        caption: req.body.caption || '',
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: req.body.caption || '',
          mediaType: 'video',
          mediaUrl: `/media/${req.file.filename}`,
          fileName: req.file.originalname,
          mimetype: req.file.mimetype,
          clientTempId: req.body.clientTempId || null,
        },
      });
      res.json({ success: true, mediaUrl: `/media/${req.file.filename}`, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/send/audio', upload.single('file'), async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const jid = req.body.jid;
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const ptt = req.body.ptt === 'true';
      const result = await sock.sendMessage(jid, {
        audio: fs.readFileSync(req.file.path),
        mimetype: req.file.mimetype || 'audio/ogg; codecs=opus',
        ptt,
      });
      const message = await stores.recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: ptt ? 'Voice message' : 'Audio file',
          mediaType: ptt ? 'voice' : 'audio',
          mediaUrl: `/media/${req.file.filename}`,
          fileName: req.file.originalname,
          mimetype: req.file.mimetype,
          clientTempId: req.body.clientTempId || null,
        },
      });
      res.json({ success: true, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/send/document', upload.single('file'), async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const jid = req.body.jid;
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const fileName = req.body.filename || req.file.originalname;
      const result = await sock.sendMessage(jid, {
        document: fs.readFileSync(req.file.path),
        fileName,
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: `Document: ${fileName}`,
          mediaType: 'document',
          mediaUrl: `/media/${req.file.filename}`,
          fileName,
          mimetype: req.file.mimetype,
          clientTempId: req.body.clientTempId || null,
        },
      });
      res.json({ success: true, mediaUrl: `/media/${req.file.filename}`, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/send/location', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const jid = req.body.jid;
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const latitude = parseFloat(req.body.latitude);
      const longitude = parseFloat(req.body.longitude);
      const result = await sock.sendMessage(jid, {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          name: req.body.name || '',
        },
      });
      const message = await stores.recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: req.body.name || 'Shared location',
          mediaType: 'location',
          mediaUrl: `https://maps.google.com/?q=${latitude},${longitude}`,
          clientTempId: req.body.clientTempId || null,
        },
      });
      res.json({ success: true, message });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/messages/:jid/:id/download-media', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);

    const { jid, id } = req.params;
    let msg = stores.findMessageInThread(jid, id);
    if (!msg) {
      const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(id);
      if (row) {
        msg = stores.normalizeMessageRecord(JSON.parse(row.payload));
      }
    }

    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (msg.mediaUrl && msg.mediaUrl !== 'null') {
      return res.json({
        success: true,
        mediaUrl: msg.mediaUrl,
        fileName: msg.fileName,
        content: msg.content,
      });
    }

    if (!msg.raw) {
      const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(id);
      if (row) {
        msg = stores.normalizeMessageRecord(JSON.parse(row.payload));
      }
    }

    if (msg.mediaUrl) {
      const localFileName = path.basename(msg.mediaUrl);
      const localFilePath = path.join(MEDIA_DIR, localFileName);
      if (fs.existsSync(localFilePath)) {
        return res.json({ success: true, mediaUrl: msg.mediaUrl, messageId: id });
      }
    }

    if (typeof whatsapp.downloadMedia === 'function' && msg.raw?.mediaId) {
      try {
        const media = await whatsapp.downloadMedia(msg.raw.mediaId);
        const ext = media.extension || mime.extension(msg.mimetype) || 'bin';
        const localName = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, localName), media.buffer);
        const mediaUrl = `/media/${localName}`;
        msg.mediaUrl = mediaUrl;
        stores.updateMessageInStore(msg);
        database.upsertMessage(msg);
        io.emit('message_media_updated', { jid, messageId: id, mediaUrl });
        return res.json({ success: true, mediaUrl, messageId: id });
      } catch (dlErr) {
        return res.status(500).json({ error: `Failed to download media: ${dlErr.message}` });
      }
    }

    return res.status(404).json({ error: 'Media file not found locally and cannot be redownloaded.' });
  });

  // WebSocket (operator dashboard <-> server)
  // Session guard: reject unauthenticated socket.io handshakes (if auth is configured)
  io.use((socket, next) => {
    const adminHash = _getAdminHash();
    if (!adminHash) return next();

    const cookies = socket.handshake.headers.cookie || '';
    const match   = cookies.match(/echo_session=([^;]+)/);
    const token   = match ? match[1] : null;
    if (store.getSession(token)) return next();
    console.warn(`[Auth] Rejected socket.io handshake: no valid session (socket ${socket.id})`);
    next(new Error('Authentication required'));
  });

  io.on('connection', (socket) => {
    console.log(`[Bridge] Operator connected: ${socket.id}`);

    let opId = socket.handshake.query.operatorId;
    let opName = socket.handshake.query.operatorName;

    if (!opId || opId === 'undefined' || opId === 'null') {
      opId = `OP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    }
    if (!opName || opName === 'undefined' || opName === 'null') {
      opName = opId;
    }

    operators.set(socket.id, { id: opId, name: opName, connectedAt: new Date().toISOString(), socketId: socket.id });
    broadcastOperators();
    socket.emit('operator_id', { id: opId });

    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    const sock = whatsapp.getSock();
    socket.emit('status', { status: whatsapp.getStatus(), connectorOperatorId, connectorOperatorName, myJid: sock?.user?.id || null });
    socket.emit('groups', Object.values(stores.groupStore));
    socket.emit('chats', stores.sortedChats(opId));
    socket.emit('flagged_list', stores.getFlaggedMessages());
    socket.emit('sync_status', stores.getSyncState());
    socket.emit('stats', database.counts());

    socket.on('set_operator_name', ({ name }) => {
      const op = operators.get(socket.id);
      if (op) {
        op.name = name || op.id;
        operators.set(socket.id, op);
      }
      broadcastOperators();
      socket.emit('chats', stores.sortedChats(op ? op.id : opId));
    });

    socket.on('claim_chat', ({ jid }) => {
      const operator = getOperatorFromSocket(socket);
      const result = stores.assignChat(jid, operator);
      if (!result.ok) return stores.sendLockError(socket, result);
      socket.emit('chat_claimed', { jid, chat: result.chat });
    });

    socket.on('release_chat', ({ jid }) => {
      const operator = getOperatorFromSocket(socket);
      const result = stores.releaseChat(jid, operator);
      if (!result.ok) return stores.sendLockError(socket, result);
      socket.emit('chat_released', { jid, chat: result.chat });
    });

    socket.on('open_chat', ({ jid }) => {
      socket.activeJid = jid;
      whatsapp.markChatAsRead(jid);

      // Update operator's read pointer to latest message in this thread
      const latestMsg = stores.getMessagesForJid(jid).slice(-1)[0];
      const latestTimestamp = latestMsg ? stores.toTimestamp(latestMsg.timestamp) : Math.floor(Date.now() / 1000);
      const latestId = latestMsg ? latestMsg.id : null;
      
      stores.setOperatorReadPointer(opId, jid, latestId, latestTimestamp);

      const chat = stores.chatStore[jid];
      if (chat && chat.unreadCount > 0) {
        chat.unreadCount = 0;
        database.upsertChat(chat);
        stores.broadcastChats();
        stores.saveStore();
      } else {
        stores.broadcastChats();
      }

      // If in-memory store is cold, hydrate from SQLite
      if (!stores.messageStore[jid] || stores.messageStore[jid].length === 0) {
        try {
          const dbMsgsStmt = database.db.prepare(
            'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
          );
          const rows = dbMsgsStmt.all(jid, CONFIG.MAX_MESSAGES_PER_CHAT);
          if (rows.length > 0) {
            stores.messageStore[jid] = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
          }
        } catch (dbErr) {
          console.warn(`[Bridge] open_chat DB hydration error for ${jid}:`, dbErr.message);
        }
      }

      const msgs = stores.getMessagesForJid(jid);
      const limit = 50;
      const sliced = msgs.slice(-limit);
      socket.emit('chat_messages', {
        jid,
        messages: sliced,
        hasMore: msgs.length > limit,
        total: msgs.length,
        chat: stores.normalizeChat(stores.chatStore[jid], opId) || null,
      });
    });

    socket.on('set_read_pointer', ({ jid, messageId, timestamp }) => {
      stores.setOperatorReadPointer(opId, jid, messageId, timestamp);
      stores.broadcastChats();
    });

    socket.on('mark_chat_unread', ({ jid }) => {
      database.db.prepare('DELETE FROM operator_chat_reads WHERE chat_id = ?').run(jid);
      for (const otherOpId of Object.keys(stores.operatorReads || {})) {
        if (stores.operatorReads[otherOpId]) {
          delete stores.operatorReads[otherOpId][jid];
        }
      }
      const chat = stores.chatStore[jid];
      if (chat) {
        chat.unreadCount = 1;
        database.upsertChat(chat);
      }
      stores.broadcastChats();
      stores.saveStore();
    });

    socket.on('flag_message', ({ messageId, jid, note }) => {
      const timestamp = Math.floor(Date.now() / 1000);
      stores.flagMessage(messageId, jid, opId, opName, note, timestamp);
      
      const flag = stores.getMessageFlag(messageId);
      io.emit('message_flagged', { messageId, jid, flag });
      
      const msg = stores.findMessageInThread(jid, messageId);
      if (msg) {
        msg.isFlagged = true;
        msg.flaggedByOperatorId = opId;
        msg.flaggedByOperatorName = opName;
        msg.flaggedNote = note;
        msg.flaggedAt = timestamp;
      }
      
      io.emit('flagged_list_updated', stores.getFlaggedMessages());
    });

    socket.on('unflag_message', ({ messageId, jid }) => {
      stores.unflagMessage(messageId);
      io.emit('message_unflagged', { messageId, jid });
      
      const msg = stores.findMessageInThread(jid, messageId);
      if (msg) {
        msg.isFlagged = false;
        msg.flaggedByOperatorId = null;
        msg.flaggedByOperatorName = null;
        msg.flaggedNote = null;
        msg.flaggedAt = null;
      }
      
      io.emit('flagged_list_updated', stores.getFlaggedMessages());
    });

    socket.on('get_flagged_messages', () => {
      socket.emit('flagged_list', stores.getFlaggedMessages());
    });

    socket.on('get_bot_mode', () => {
      socket.emit('bot_mode_changed', { mode: store.getBotMode() });
    });

    socket.on('set_bot_mode', (data) => {
      const mode = data?.mode;
      if (mode === 'ai' || mode === 'manual') {
        const newMode = store.setBotMode(mode);
        io.emit('bot_mode_changed', { mode: newMode });
      }
    });

    socket.on('send_message', async (data) => {
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      const { jid, text, clientTempId, quotedMessageId } = data;
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);
      try {
        const options = quotedMessageId ? { quotedMessageId } : {};
        const result = await sock.sendMessage(jid, { text }, options);
        const quotedMsg = quotedMessageId ? stores.findMessageInThread(jid, quotedMessageId) : null;
        const sentMsg = await stores.recordOutboundMessage({
          jid,
          operator,
          result,
          message: {
            content: text,
            mediaType: 'text',
            clientTempId: clientTempId || null,
            quotedMessageId: quotedMsg?.id || null,
            quotedContent: quotedMsg?.content || null,
            quotedSender: quotedMsg?.sender || null,
            quotedMediaType: quotedMsg?.mediaType || null,
          },
        });
        socket.emit('message_ack', { clientTempId, serverId: sentMsg.id, timestamp: sentMsg.timestamp });
      } catch (e) {
        socket.emit('message_failed', { clientTempId, jid, error: e.message });
        socket.emit('error', { message: e.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Bridge] Operator disconnected: ${socket.id}`);
      const operator = getOperatorFromSocket(socket);
      operators.delete(socket.id);
      if (CONFIG.RELEASE_ASSIGNMENTS_ON_DISCONNECT && operator?.id) {
        for (const chat of Object.values(stores.chatStore)) {
          if (chat.assignedOperatorId === operator.id) {
            stores.releaseChat(chat.id, operator, { force: true });
          }
        }
      }
      broadcastOperators();
    });
  });
  // ── Booking Export API (Part 4g) ───────────────────────────────────
  app.get('/api/export', async (req, res) => {
    try {
      const token = req.cookies?.echo_session;
      const session = store.getSession(token);
      if (!session) return res.status(401).json({ error: 'Authentication required' });

      let { from, to, format = 'csv' } = req.query;

      // Default to last 30 days
      if (!from || !to) {
        const now = new Date();
        to   = to   || now.toISOString().slice(0, 10);
        const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
        from = from || d30.toISOString().slice(0, 10);
      }

      const rows = store.getBookingsInRange(from, to);
      store.logExport({ requestedBy: session.username, fromDate: from, toDate: to, rowCount: rows.length, format });

      const { buildExportCsv } = require('./ai-bot/export');
      const csv = buildExportCsv(rows);
      const filename = `bookings_${from}_to_${to}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      console.error('[Routes] Export error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
