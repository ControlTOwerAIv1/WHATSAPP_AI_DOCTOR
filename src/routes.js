/**
 * Express REST API and Socket.IO operator-facing events.
 * Owns the connected-operator registry (who's at the dashboard right now),
 * separate from stores.js which owns chat/message/contact data.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const mime = require('mime-types');

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
  const EDIT_WINDOW_SECONDS = Number(CONFIG.MESSAGE_EDIT_WINDOW_SECONDS) || (15 * 60);
  const DELETE_FOR_EVERYONE_WINDOW_SECONDS = Number(CONFIG.MESSAGE_DELETE_FOR_EVERYONE_WINDOW_SECONDS) || (60 * 60 * 60);

  function serializeActionError(result) {
    return {
      error: result.message,
      code: result.code,
      windowSeconds: result.windowSeconds,
      remainingSeconds: result.remainingSeconds,
    };
  }

  /**
   * Build a minimal synthetic quoted message object that Baileys accepts.
   * We don't store raw Baileys message objects, so we reconstruct from our
   * normalized record. This is sufficient for WhatsApp to render the reply
   * correctly with the quoted preview bubble on the recipient's device.
   */
  function buildQuotedContext(jid, quotedMessageId) {
    if (!quotedMessageId) return null;
    const msg = stores.findMessageInThread(jid, quotedMessageId);
    if (!msg) return null;
    // Determine participant for group messages (needed for Baileys key)
    const participant = msg.participant || null;
    const remoteJid = msg.from || msg.jid || jid;
    // Build the inner `message` payload: prefer conversation for text,
    // fall back to extendedTextMessage for captions/other.
    let innerMessage;
    if (!msg.mediaType || msg.mediaType === 'text') {
      innerMessage = { conversation: msg.content || '' };
    } else {
      // For media, wrap as extendedTextMessage so Baileys renders it
      innerMessage = { extendedTextMessage: { text: msg.content || '' } };
    }
    return {
      key: {
        remoteJid,
        fromMe: Boolean(msg.fromMe),
        id: msg.id,
        ...(participant ? { participant } : {}),
      },
      message: innerMessage,
      messageTimestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    };
  }

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

  app.get('/api/status', (req, res) => {
    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    const bridgeLiveAddress = getBridgeLiveAddress(req);
    res.json({
      status: whatsapp.getStatus(),
      qr: whatsapp.getQrCodeData(),
      connectorOperatorId,
      connectorOperatorName,
      bridgeLiveAddress,
      bridgeLiveUrl: getBridgeLiveUrl(req),
      messageRules: {
        editWindowSeconds: EDIT_WINDOW_SECONDS,
        deleteForEveryoneWindowSeconds: DELETE_FOR_EVERYONE_WINDOW_SECONDS,
      },
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

      // Build index maps of all existing contacts in memory by their full phone number and last 10 digits
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
        // Find all matching existing JIDs using full number or last 10 digits
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
          // Create new contact if not found
          const jid = `${c.phone}@s.whatsapp.net`;
          const contactObj = { id: jid, name: c.name, notify: c.name };
          stores.contactStore[jid] = contactObj;
          database.upsertContact(contactObj);

          // Add to our local index maps to prevent duplicate insertions
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

    // Hydrate from DB if cold before returning combined list
    const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
    const hydrate = (targetJid) => {
      if (!stores.messageStore[targetJid] || stores.messageStore[targetJid].length === 0) {
        try {
          const dbMsgsStmt = database.db.prepare(
            'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
          );
          const rows = dbMsgsStmt.all(targetJid, CONFIG.MAX_MESSAGES_PER_CHAT);
          if (rows.length > 0) {
            stores.messageStore[targetJid] = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
          }
        } catch (dbErr) {
          console.warn(`[Bridge] API messages DB hydration error for ${targetJid}:`, dbErr.message);
        }
      }
    };
    hydrate(jid);
    if (altJid) hydrate(altJid);

    const filterToBefore = (list) => {
      if (!before) return list;
      const beforeTs = Number(before);
      return list.filter((msg) => stores.toTimestamp(msg.timestamp) < beforeTs);
    };

    let msgs = filterToBefore(stores.getMessagesForJid(jid));

    // Local store had nothing older than the requested cursor — ask WhatsApp
    // itself for more history (on-demand sync) before giving up, since the
    // local cache only ever holds what's already been synced/received.
    if (before && msgs.length === 0) {
      try {
        const result = await whatsapp.requestOlderHistory(jid, Number(limit));
        if (result.ok && result.added > 0) {
          msgs = filterToBefore(stores.getMessagesForJid(jid));
        }
      } catch (e) {
        console.warn(`[Bridge] On-demand history fetch failed for ${jid}:`, e.message);
      }
    }

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

      const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
      const threadJids = altJid ? [jid, altJid] : [jid];
      const placeholders = threadJids.map(() => '?').join(',');

      const sql = `
        SELECT payload FROM messages
        WHERE jid IN (${placeholders})
          AND (
            json_extract(payload, '$.content') LIKE ?
            OR json_extract(payload, '$.fileName') LIKE ?
            OR json_extract(payload, '$.sender') LIKE ?
            OR json_extract(payload, '$.operatorName') LIKE ?
          )
        ORDER BY timestamp DESC, id DESC
      `;
      
      const searchPattern = `%${q}%`;
      const queryParams = [...threadJids, searchPattern, searchPattern, searchPattern, searchPattern];
      
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
    if (req.body.jid) req.body.jid = stores.getPreferredJid(req.body.jid);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const quotedCtx = buildQuotedContext(req.body.jid, req.body.quotedMessageId);
      const options = quotedCtx ? { quoted: quotedCtx } : {};
      const result = await sock.sendMessage(req.body.jid, { text: req.body.text }, options);
      // Look up quoted message metadata for storage
      const quotedMsg = req.body.quotedMessageId ? stores.findMessageInThread(req.body.jid, req.body.quotedMessageId) : null;
      const message = await stores.recordOutboundMessage({
        jid: req.body.jid,
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
    if (req.body.jid) req.body.jid = stores.getPreferredJid(req.body.jid);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(req.body.jid, {
        image: fs.readFileSync(req.file.path),
        caption: req.body.caption || '',
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
        jid: req.body.jid,
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
    if (req.body.jid) req.body.jid = stores.getPreferredJid(req.body.jid);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(req.body.jid, {
        video: fs.readFileSync(req.file.path),
        caption: req.body.caption || '',
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
        jid: req.body.jid,
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
    if (req.body.jid) req.body.jid = stores.getPreferredJid(req.body.jid);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const ptt = req.body.ptt === 'true';
      const result = await sock.sendMessage(req.body.jid, {
        audio: fs.readFileSync(req.file.path),
        mimetype: req.file.mimetype || 'audio/ogg; codecs=opus',
        ptt,
      });
      const message = await stores.recordOutboundMessage({
        jid: req.body.jid,
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
    if (req.body.jid) req.body.jid = stores.getPreferredJid(req.body.jid);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const fileName = req.body.filename || req.file.originalname;
      const result = await sock.sendMessage(req.body.jid, {
        document: fs.readFileSync(req.file.path),
        fileName,
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
        jid: req.body.jid,
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
    if (req.body.jid) req.body.jid = stores.getPreferredJid(req.body.jid);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const latitude = parseFloat(req.body.latitude);
      const longitude = parseFloat(req.body.longitude);
      const result = await sock.sendMessage(req.body.jid, {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          name: req.body.name || '',
        },
      });
      const message = await stores.recordOutboundMessage({
        jid: req.body.jid,
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

  app.put('/api/messages/:messageId', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const { messageId } = req.params;
    let { jid, newContent } = req.body;
    if (!jid || !newContent) return res.status(400).json({ error: 'jid and newContent required' });
    jid = stores.getPreferredJid(jid);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });

    const eligibility = stores.canEditMessage(jid, messageId, { windowSeconds: EDIT_WINDOW_SECONDS });
    if (!eligibility.ok) return res.status(eligibility.status).json(serializeActionError(eligibility));

    try {
      const result = await sock.sendMessage(jid, { edit: { id: messageId, remoteJid: jid, fromMe: true }, text: newContent });
      const editMsgId = result?.key?.id;
      const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
      const targetJids = altJid ? [jid, altJid] : [jid];
      let updatedEdits = [];
      const editTimestamp = Date.now();
      for (const tJid of targetJids) {
        const msgs = stores.messageStore[tJid];
        if (msgs) {
          const found = msgs.find((msg) => msg.id === messageId);
          if (found) {
            found.content = newContent;
            found.editedAt = editTimestamp;
            if (editMsgId) {
              found.latestEditMsgId = editMsgId;
            }
            if (found.fromMe) {
              found.status = 2; // Reset status back to sent (SERVER_ACK) when edited
            }
            if (!found.edits) found.edits = [];
            const exists = found.edits.some((e) => e.editedAt === editTimestamp);
            if (!exists) {
              found.edits.push({
                operatorId: operator?.id || 'unknown',
                operatorName: operator?.name || 'Unknown',
                editedAt: editTimestamp,
                editMsgId: editMsgId || null,
              });
            }
            updatedEdits = found.edits;
            database.upsertMessage(found);
          }
        }
      }
      io.emit('message_edited', { jid, messageId, newContent, editedAt: editTimestamp, edits: updatedEdits });
      for (const tJid of targetJids) {
        io.emit('message_status_update', { jid: tJid, messageId, status: 2, fromMe: true });
      }
      stores.saveStore();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/messages/:messageId', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const { messageId } = req.params;
    let jid = req.query.jid || req.body.jid;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    jid = stores.getPreferredJid(jid);
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });

    const eligibility = stores.canDeleteForEveryone(jid, messageId, { windowSeconds: DELETE_FOR_EVERYONE_WINDOW_SECONDS });
    if (!eligibility.ok) return res.status(eligibility.status).json(serializeActionError(eligibility));

    try {
      await sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe: true } });
      const msgs = stores.messageStore[jid];
      if (msgs) {
        const found = msgs.find((msg) => msg.id === messageId);
        if (found) {
          found.deleted = true;
          found.content = '';
          database.upsertMessage(found);
        }
      }
      io.emit('message_deleted', { jid, messageId });
      stores.saveStore();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/create', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);

    const name = String(req.body.name || '').trim();
    const rawParticipants = Array.isArray(req.body.participants) ? req.body.participants : [];
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    if (!rawParticipants.length) return res.status(400).json({ error: 'At least one participant is required' });

    // Accept "+91 98765 43210", "919876543210" or full jids; dedupe by digits.
    const skipped = [];
    const seen = new Set();
    const numbers = [];
    for (const raw of rawParticipants) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      let value = raw.trim();
      if (value.includes('@')) value = value.split('@')[0].split(':')[0];
      const digits = value.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        skipped.push({ input: raw, reason: 'Invalid phone number' });
        continue;
      }
      if (!seen.has(digits)) {
        seen.add(digits);
        numbers.push({ input: raw, digits });
      }
    }
    if (!numbers.length) {
      return res.status(400).json({ error: 'No valid phone numbers provided', skipped });
    }

    try {
      // Verify each number is on WhatsApp before creating, and use the exact
      // jid WhatsApp returns (it can differ from the typed number, e.g.
      // Brazilian numbers with/without the extra 9). One-at-a-time keeps the
      // input-to-result mapping unambiguous; group creation is a rare,
      // small-batch operation so the extra round-trips don't matter.
      const participants = [];
      for (const n of numbers) {
        let entry = null;
        try {
          const results = await sock.onWhatsApp(n.digits);
          entry = Array.isArray(results) ? results[0] : null;
        } catch (lookupErr) {
          console.warn(`[Bridge] onWhatsApp lookup failed for ${n.digits}:`, lookupErr.message);
        }
        if (entry && entry.exists && entry.jid) {
          participants.push(entry.jid);
        } else {
          skipped.push({ input: n.input, reason: 'Not on WhatsApp' });
        }
      }
      if (!participants.length) {
        return res.status(400).json({ error: 'None of the numbers are on WhatsApp', skipped });
      }

      const result = await sock.groupCreate(name, participants);
      stores.groupStore[result.id] = result;
      io.emit('group_created', result);
      res.json({ ...result, added: participants.length, skipped });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/groups/:jid', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const { jid } = req.params;
    try {
      let group = stores.groupStore[jid];
      if (!group) {
        group = await sock.groupMetadata(jid);
        stores.groupStore[jid] = group;
      }
      if (group && group.participants) {
        const resolvedParticipants = await Promise.all(
          group.participants.map(async (p) => {
            let resolvedId = p.id;
            if (p.id && p.id.endsWith('@lid')) {
              let phoneJid = stores.lidToJid[p.id];
              if (!phoneJid) {
                phoneJid = await stores.resolveLidToPhoneAsync(p.id);
              }
              if (phoneJid) {
                resolvedId = phoneJid;
              }
            }
            return {
              ...p,
              id: resolvedId
            };
          })
        );
        group = {
          ...group,
          participants: resolvedParticipants
        };
      }
      res.json(group);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/:jid/participants', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const { jid } = req.params;
    const { action, participants } = req.body;
    if (!action || !participants || !Array.isArray(participants)) {
      return res.status(400).json({ error: 'Missing action or participants array' });
    }
    try {
      const response = await sock.groupParticipantsUpdate(jid, participants, action);
      const meta = await sock.groupMetadata(jid);
      stores.groupStore[jid] = meta;
      if (stores.chatStore[jid]) {
        stores.chatStore[jid].name = meta.subject;
        database.upsertChat(stores.chatStore[jid]);
      }
      io.emit('groups', Object.values(stores.groupStore));
      stores.broadcastChats();
      res.json({ success: true, response });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/:jid/update', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const { jid } = req.params;
    const { subject } = req.body;
    try {
      if (subject) {
        await sock.groupUpdateSubject(jid, subject);
      }
      const meta = await sock.groupMetadata(jid);
      stores.groupStore[jid] = meta;
      if (stores.chatStore[jid]) {
        stores.chatStore[jid].name = meta.subject;
        database.upsertChat(stores.chatStore[jid]);
      }
      io.emit('groups', Object.values(stores.groupStore));
      stores.broadcastChats();
      res.json({ success: true, meta });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/:jid/leave', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const { jid } = req.params;
    try {
      await sock.groupLeave(jid);
      delete stores.groupStore[jid];
      io.emit('groups', Object.values(stores.groupStore));
      stores.broadcastChats();
      res.json({ success: true });
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

    // The in-memory copy has raw stripped (see stores.addMessageToStore) to
    // keep the resident message cache small — fetch it from the database,
    // which still holds the full payload, when we actually need it.
    if (!msg.raw) {
      const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(id);
      if (row) {
        msg = stores.normalizeMessageRecord(JSON.parse(row.payload));
      }
    }

    if (!msg.raw) {
      return res.status(400).json({ error: 'Original message data not available in database' });
    }

    let refreshFailed = false;
    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');

      // Helper to recursively restore Buffers from JSON serialization
      const restoreBuffers = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
          return Buffer.from(obj.data);
        }
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            obj[key] = restoreBuffers(obj[key]);
          }
        }
        return obj;
      };

      // msg.raw only ever stores the message CONTENT (e.g. { imageMessage: ... }),
      // not a full WAMessage - see the `raw:` assignments in whatsapp.js. Both
      // sock.updateMediaMessage and downloadMediaMessage require the full
      // { key, message } shape (they read message.key and message.message
      // internally), so it has to be rebuilt here rather than passed as-is.
      const restoredContent = restoreBuffers(JSON.parse(JSON.stringify(msg.raw)));
      const restoredRaw = {
        key: {
          remoteJid: msg.jid || jid,
          id: msg.id || id,
          fromMe: Boolean(msg.fromMe),
          participant: msg.participant || undefined,
        },
        message: restoredContent,
        messageTimestamp: msg.timestamp,
      };

      const sock = whatsapp.getSock();

      // Step 1: Refresh the media URL via WhatsApp servers.
      // Old messages have expired CDN URLs (oe= timestamp). updateMediaMessage
      // asks WA to issue a fresh download URL before we attempt to fetch it.
      let rawToDownload = restoredRaw;
      if (sock && typeof sock.updateMediaMessage === 'function') {
        try {
          console.log(`[Bridge] Refreshing expired media URL for message ${id}...`);
          rawToDownload = await sock.updateMediaMessage(restoredRaw);
          console.log(`[Bridge] Media URL refreshed successfully for ${id}`);
        } catch (refreshErr) {
          console.warn(`[Bridge] updateMediaMessage failed for ${id}, trying original URL:`, refreshErr.message);
          rawToDownload = restoredRaw; // fall back to original
          refreshFailed = true;
        }
      }

      const buffer = await downloadMediaMessage(
        rawToDownload,
        'buffer',
        { reuploadRequest: sock ? sock.updateMediaMessage : undefined }
      );
      
      let ext = 'bin';
      if (msg.mimetype) {
        ext = mime.extension(msg.mimetype) || 'bin';
      } else {
        const mediaTypeToExt = {
          image: 'jpg',
          video: 'mp4',
          audio: 'ogg',
          voice: 'ogg',
          sticker: 'webp',
        };
        ext = mediaTypeToExt[msg.mediaType] || 'bin';
      }

      let filename;
      if (msg.mediaType === 'document') {
        const safeName = (msg.fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
        filename = `${Date.now()}-${safeName}`;
      } else {
        filename = `${Date.now()}.${ext}`;
      }

      fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
      const mediaUrl = `/media/${filename}`;

      // Update message in DB
      const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(id);
      if (row) {
        const dbPayload = JSON.parse(row.payload);
        dbPayload.mediaUrl = mediaUrl;
        database.upsertMessage(dbPayload);
      }

      // Update in stores.messageStore if it exists
      const threadJids = stores.getThreadJids(jid);
      for (const threadJid of threadJids) {
        const msgs = stores.messageStore[threadJid];
        if (msgs) {
          const found = msgs.find((m) => m.id === id);
          if (found) {
            found.mediaUrl = mediaUrl;
          }
        }
      }

      // Broadcast update via Socket.IO
      io.emit('message_media_updated', {
        jid,
        messageId: id,
        mediaUrl,
        fileName: msg.fileName,
        content: msg.content,
        mediaType: msg.mediaType,
      });

      res.json({
        success: true,
        mediaUrl,
        fileName: msg.fileName,
        content: msg.content,
      });
    } catch (e) {
      const statusCode = e?.output?.statusCode || e?.data?.statusCode;
      const isGone = statusCode === 410 || statusCode === 404 ||
        (e.message && (e.message.includes('re-upload') || e.message.includes('re-upl')));

      // If the URL refresh already failed AND the download also failed (any status),
      // the media is unreachable on WA servers — treat as permanently gone.
      if (isGone || refreshFailed) {
        console.warn(`[Bridge] Media permanently unavailable for ${id} (${statusCode || refreshFailed ? 'refresh-failed' : 'gone'}): ${e.message}`);
        return res.status(410).json({
          error: 'Media is no longer available on WhatsApp servers.',
          media_expired: true,
        });
      }

      console.error(`[Bridge] On-demand media download failed for ${id}:`, e);
      res.status(500).json({ error: `Failed to download media: ${e.message}` });
    }
  });

  // WebSocket (operator dashboard <-> server)
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
    if (whatsapp.getQrCodeData()) socket.emit('qr', whatsapp.getQrCodeData());
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

    socket.on('linking_whatsapp', ({ operatorId, operatorName }) => {
      stores.setLinkingOperator({ id: operatorId, name: operatorName });
      console.log(`[Bridge] Operator ${operatorName || operatorId} is scanning/linking WhatsApp`);
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
      console.log(`[Bridge] open_chat event received for JID: ${jid}`);
      socket.activeJid = jid;
      whatsapp.markChatAsRead(jid);

      // Reset unread count for the chat (including its alternate LID/phone JID)
      const preferredJid = stores.getPreferredJid(jid) || jid;
      const targetJids = [preferredJid];
      const mappedAltJid = preferredJid.endsWith('@lid') ? stores.lidToJid[preferredJid] : stores.jidToLid[preferredJid];
      if (mappedAltJid) targetJids.push(mappedAltJid);

      // Update operator's read pointer to latest message in this thread
      const latestMsg = stores.getMessagesForJid(jid).slice(-1)[0];
      const latestTimestamp = latestMsg ? stores.toTimestamp(latestMsg.timestamp) : Math.floor(Date.now() / 1000);
      const latestId = latestMsg ? latestMsg.id : null;
      
      for (const tJid of targetJids) {
        stores.setOperatorReadPointer(opId, tJid, latestId, latestTimestamp);
      }

      let chatUpdated = false;
      for (const tJid of targetJids) {
        const chat = stores.chatStore[tJid];
        if (chat && chat.unreadCount > 0) {
          chat.unreadCount = 0;
          database.upsertChat(chat);
          chatUpdated = true;
        }
      }
      if (chatUpdated) {
        stores.broadcastChats();
        stores.saveStore();
      } else {
        stores.broadcastChats();
      }

      if (jid.endsWith('@lid') && !stores.lidToJid[jid]) {
        stores.resolveLidToPhoneAsync(jid).then((pn) => {
          if (pn) {
            stores.broadcastChats();
          }
        });
      }

      // If in-memory store is cold (e.g. after a server restart) but SQLite has
      // persisted messages, hydrate the in-memory store from the DB now so the
      // operator sees chat history immediately on click.
      const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];

      const hydrate = (targetJid) => {
        if (!stores.messageStore[targetJid] || stores.messageStore[targetJid].length === 0) {
          try {
            const dbMsgsStmt = database.db.prepare(
              'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
            );
            const rows = dbMsgsStmt.all(targetJid, CONFIG.MAX_MESSAGES_PER_CHAT);
            if (rows.length > 0) {
              stores.messageStore[targetJid] = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
            }
          } catch (dbErr) {
            console.warn(`[Bridge] open_chat DB hydration error for ${targetJid}:`, dbErr.message);
          }
        }
      };

      hydrate(jid);
      if (altJid) hydrate(altJid);

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
      const preferredJid = stores.getPreferredJid(jid) || jid;
      const targetJids = [preferredJid];
      const mappedAltJid = preferredJid.endsWith('@lid') ? stores.lidToJid[preferredJid] : stores.jidToLid[preferredJid];
      if (mappedAltJid) targetJids.push(mappedAltJid);

      for (const tJid of targetJids) {
        stores.setOperatorReadPointer(opId, tJid, messageId, timestamp);
      }
      stores.broadcastChats();
    });

    socket.on('mark_chat_unread', ({ jid, scope }) => {
      const preferredJid = stores.getPreferredJid(jid) || jid;
      const targetJids = [preferredJid];
      const mappedAltJid = preferredJid.endsWith('@lid') ? stores.lidToJid[preferredJid] : stores.jidToLid[preferredJid];
      if (mappedAltJid) targetJids.push(mappedAltJid);

      if (scope === 'others' || scope === 'all') {
        for (const tJid of targetJids) {
          if (scope === 'others') {
            database.db.prepare('DELETE FROM operator_chat_reads WHERE chat_id = ? AND operator_id != ?').run(tJid, opId);
            for (const otherOpId of Object.keys(stores.operatorReads || {})) {
              if (otherOpId !== opId && stores.operatorReads[otherOpId]) {
                delete stores.operatorReads[otherOpId][tJid];
              }
            }
          } else {
            database.db.prepare('DELETE FROM operator_chat_reads WHERE chat_id = ?').run(tJid);
            for (const otherOpId of Object.keys(stores.operatorReads || {})) {
              if (stores.operatorReads[otherOpId]) {
                delete stores.operatorReads[otherOpId][tJid];
              }
            }
          }
          
          const chat = stores.chatStore[tJid];
          if (chat) {
            chat.unreadCount = 1;
            database.upsertChat(chat);
          }
        }
      } else if (scope === 'me') {
        for (const tJid of targetJids) {
          database.db.prepare('DELETE FROM operator_chat_reads WHERE chat_id = ? AND operator_id = ?').run(tJid, opId);
          if (stores.operatorReads[opId]) {
            delete stores.operatorReads[opId][tJid];
          }
          const chat = stores.chatStore[tJid];
          if (chat) {
            chat.unreadCount = 1;
            database.upsertChat(chat);
          }
        }
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

    socket.on('send_message', async (data) => {
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      let { jid, text, clientTempId, quotedMessageId } = data;
      if (jid) jid = stores.getPreferredJid(jid);
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);
      try {
        const quotedCtx = buildQuotedContext(jid, quotedMessageId);
        const options = quotedCtx ? { quoted: quotedCtx } : {};
        const result = await sock.sendMessage(jid, { text }, options);
        // Look up quoted message metadata for storage
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

    socket.on('edit_message', async (data) => {
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      let { jid, messageId, newContent } = data;
      if (jid) jid = stores.getPreferredJid(jid);
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);

      const eligibility = stores.canEditMessage(jid, messageId, { windowSeconds: EDIT_WINDOW_SECONDS });
      if (!eligibility.ok) {
        return socket.emit('error', {
          message: eligibility.message,
          jid,
          code: eligibility.code,
          windowSeconds: eligibility.windowSeconds,
          remainingSeconds: eligibility.remainingSeconds,
        });
      }

      try {
        const result = await sock.sendMessage(jid, { edit: { id: messageId, remoteJid: jid, fromMe: true }, text: newContent });
        const editMsgId = result?.key?.id;
        const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
        const targetJids = altJid ? [jid, altJid] : [jid];
        let updatedEdits = [];
        const editTimestamp = Date.now();
        for (const tJid of targetJids) {
          const msgs = stores.messageStore[tJid];
          if (msgs) {
            const found = msgs.find((msg) => msg.id === messageId);
            if (found) {
              found.content = newContent;
              found.editedAt = editTimestamp;
              if (editMsgId) {
                found.latestEditMsgId = editMsgId;
              }
              if (found.fromMe) {
                found.status = 2; // Reset status back to sent (SERVER_ACK) when edited
              }
              if (!found.edits) found.edits = [];
              const exists = found.edits.some((e) => e.editedAt === editTimestamp);
              if (!exists) {
                found.edits.push({
                  operatorId: operator?.id || 'unknown',
                  operatorName: operator?.name || 'Unknown',
                  editedAt: editTimestamp,
                  editMsgId: editMsgId || null,
                });
              }
              updatedEdits = found.edits;
              database.upsertMessage(found);
            }
          }
        }
        io.emit('message_edited', { jid, messageId, newContent, editedAt: editTimestamp, edits: updatedEdits });
        for (const tJid of targetJids) {
          io.emit('message_status_update', { jid: tJid, messageId, status: 2, fromMe: true });
        }
        stores.saveStore();
      } catch (e) {
        socket.emit('error', { message: e.message });
      }
    });

    socket.on('delete_message', async (data) => {
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      let { jid, messageId } = data;
      if (jid) jid = stores.getPreferredJid(jid);
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);

      const eligibility = stores.canDeleteForEveryone(jid, messageId, {
        windowSeconds: DELETE_FOR_EVERYONE_WINDOW_SECONDS,
      });
      if (!eligibility.ok) {
        return socket.emit('error', {
          message: eligibility.message,
          jid,
          code: eligibility.code,
          windowSeconds: eligibility.windowSeconds,
          remainingSeconds: eligibility.remainingSeconds,
        });
      }

      try {
        await sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe: true } });
        const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
        const targetJids = altJid ? [jid, altJid] : [jid];
        for (const tJid of targetJids) {
          const msgs = stores.messageStore[tJid];
          if (msgs) {
            const found = msgs.find((msg) => msg.id === messageId);
            if (found) {
              found.deleted = true;
              found.content = '';
              database.upsertMessage(found);
            }
          }
        }
        io.emit('message_deleted', { jid, messageId });
        stores.saveStore();
      } catch (e) {
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
}

module.exports = { registerRoutes };
