/**
 * Meta Cloud API WhatsApp integration module.
 *
 * Replaces Baileys with the official WhatsApp Business Platform (Cloud API).
 * Authentication is via a permanent access token from Meta Developer Console.
 * Messages are sent via REST API and received via webhooks.
 *
 * Exposes the same interface shape as the old whatsapp.js so that bridge.js
 * and routes.js can swap in with minimal wiring changes.
 */

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const https = require('https');
const http = require('http');
const aiBot = require('./ai-bot');

let stores = null;
let database = null;
let io = null;
let ROOT_DIR = null;
let MEDIA_DIR = null;

// Cloud API configuration — injected from config.json or env vars.
let ACCESS_TOKEN = '';
let PHONE_NUMBER_ID = '';
let VERIFY_TOKEN = '';
let GRAPH_API_VERSION = 'v21.0';
let BUSINESS_ACCOUNT_ID = '';
let connectionStatus = 'disconnected'; // 'disconnected' | 'connected' | 'missing_config'

function init(deps) {
  ({ stores, database, io, ROOT_DIR, MEDIA_DIR } = deps);
  // Initialize AI Bot module
  aiBot.init({ rootDir: ROOT_DIR });
  aiBot.setStores(stores);
}

// ---------------------------------------------------------------------------
// HTTP helpers — uses built-in https module (no axios dependency)
// ---------------------------------------------------------------------------

function graphUrl(endpoint) {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${endpoint}`;
}

/**
 * Make an HTTPS request to the Graph API.
 * Returns { status, data } or throws on network error.
 */
function apiRequest(method, url, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...extraHeaders,
    };
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    if (body && Buffer.isBuffer(body)) {
      headers['Content-Length'] = body.length;
    } else if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Upload media (multipart/form-data) to the Cloud API.
 * Returns the media ID on success.
 */
async function uploadMedia(filePath, mimeType) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = `----CloudApiBoundary${Date.now()}`;

  let bodyParts = [];
  // messaging_product field
  bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp`);
  // type field
  bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType}`);
  // file field
  bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);

  const preFile = Buffer.from(bodyParts.join('\r\n') + '\r\n', 'utf8');
  const postFile = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const fullBody = Buffer.concat([preFile, fileBuffer, postFile]);

  const { status, data } = await apiRequest(
    'POST',
    graphUrl(`${PHONE_NUMBER_ID}/media`),
    fullBody,
    { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  );

  if (status !== 200 || !data?.id) {
    throw new Error(`Media upload failed: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/**
 * Download media from Cloud API given a media ID.
 * Returns { buffer, mimeType, extension }.
 */
async function downloadMedia(mediaId) {
  // Step 1: Get the media URL
  const { status, data } = await apiRequest('GET', graphUrl(mediaId));
  if (status !== 200 || !data?.url) {
    throw new Error(`Failed to get media URL for ${mediaId}: ${JSON.stringify(data)}`);
  }

  // Step 2: Download from the URL (requires auth header)
  const mediaBuffer = await new Promise((resolve, reject) => {
    const parsed = new URL(data.url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    };
    const req = https.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location);
        const rOpts = {
          hostname: redirected.hostname,
          path: redirected.pathname + redirected.search,
          method: 'GET',
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        };
        const rReq = https.request(rOpts, (rRes) => {
          const chunks = [];
          rRes.on('data', (c) => chunks.push(c));
          rRes.on('end', () => resolve(Buffer.concat(chunks)));
        });
        rReq.on('error', reject);
        rReq.end();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });

  const mimeType = data.mime_type || 'application/octet-stream';
  const extension = mime.extension(mimeType) || 'bin';
  return { buffer: mediaBuffer, mimeType, extension };
}

// ---------------------------------------------------------------------------
// Send helpers — each returns a Cloud API response object
// ---------------------------------------------------------------------------

function phoneToJid(phone) {
  // Cloud API uses raw phone numbers (e.g. "919876543210").
  // Convert to our internal JID format for store consistency.
  const clean = phone.replace(/[^0-9]/g, '');
  return `${clean}@s.whatsapp.net`;
}

function jidToPhone(jid) {
  if (!jid) return '';
  // Strip @s.whatsapp.net or @lid or any domain
  return jid.split('@')[0].split(':')[0];
}

async function sendText(to, text, options = {}) {
  const phone = jidToPhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { body: text },
  };

  // Reply / quote support
  if (options.quotedMessageId) {
    payload.context = { message_id: options.quotedMessageId };
  }

  const { status, data } = await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), payload);
  if (status !== 200 || !data?.messages?.[0]?.id) {
    throw new Error(`Send text failed: ${JSON.stringify(data)}`);
  }
  return {
    key: { id: data.messages[0].id, remoteJid: to, fromMe: true },
    status: 1, // PENDING
    message: { conversation: text },
  };
}

async function sendImage(to, filePath, caption = '', mimeType = 'image/jpeg') {
  const mediaId = await uploadMedia(filePath, mimeType);
  const phone = jidToPhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'image',
    image: { id: mediaId, caption },
  };
  const { status, data } = await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), payload);
  if (status !== 200 || !data?.messages?.[0]?.id) {
    throw new Error(`Send image failed: ${JSON.stringify(data)}`);
  }
  return {
    key: { id: data.messages[0].id, remoteJid: to, fromMe: true },
    status: 1,
  };
}

async function sendVideo(to, filePath, caption = '', mimeType = 'video/mp4') {
  const mediaId = await uploadMedia(filePath, mimeType);
  const phone = jidToPhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'video',
    video: { id: mediaId, caption },
  };
  const { status, data } = await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), payload);
  if (status !== 200 || !data?.messages?.[0]?.id) {
    throw new Error(`Send video failed: ${JSON.stringify(data)}`);
  }
  return {
    key: { id: data.messages[0].id, remoteJid: to, fromMe: true },
    status: 1,
  };
}

async function sendAudio(to, filePath, mimeType = 'audio/ogg') {
  const mediaId = await uploadMedia(filePath, mimeType);
  const phone = jidToPhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'audio',
    audio: { id: mediaId },
  };
  const { status, data } = await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), payload);
  if (status !== 200 || !data?.messages?.[0]?.id) {
    throw new Error(`Send audio failed: ${JSON.stringify(data)}`);
  }
  return {
    key: { id: data.messages[0].id, remoteJid: to, fromMe: true },
    status: 1,
  };
}

async function sendDocument(to, filePath, fileName, mimeType = 'application/octet-stream') {
  const mediaId = await uploadMedia(filePath, mimeType);
  const phone = jidToPhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'document',
    document: { id: mediaId, filename: fileName },
  };
  const { status, data } = await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), payload);
  if (status !== 200 || !data?.messages?.[0]?.id) {
    throw new Error(`Send document failed: ${JSON.stringify(data)}`);
  }
  return {
    key: { id: data.messages[0].id, remoteJid: to, fromMe: true },
    status: 1,
  };
}

async function sendLocation(to, latitude, longitude, name = '') {
  const phone = jidToPhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'location',
    location: { latitude, longitude, name },
  };
  const { status, data } = await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), payload);
  if (status !== 200 || !data?.messages?.[0]?.id) {
    throw new Error(`Send location failed: ${JSON.stringify(data)}`);
  }
  return {
    key: { id: data.messages[0].id, remoteJid: to, fromMe: true },
    status: 1,
  };
}

/**
 * Mark a message as read on Cloud API.
 */
async function markAsRead(messageId) {
  if (!messageId || !isReady()) return;
  try {
    await apiRequest('POST', graphUrl(`${PHONE_NUMBER_ID}/messages`), {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (err) {
    console.warn('[CloudAPI] Failed to mark message as read:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Webhook handling — called from routes
// ---------------------------------------------------------------------------

/**
 * Verify the webhook during setup.
 * Meta sends a GET with hub.mode, hub.verify_token, and hub.challenge.
 */
function handleWebhookVerification(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[CloudAPI] Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    console.warn('[CloudAPI] Webhook verification failed. Token mismatch.');
    res.status(403).send('Verification failed');
  }
}

/**
 * Process an incoming webhook POST from Meta.
 * Parses messages, status updates, and errors.
 */
async function handleWebhookPayload(body) {
  if (!body?.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value) continue;

      const metadata = value.metadata || {};
      const contacts = value.contacts || [];
      const messages = value.messages || [];
      const statuses = value.statuses || [];
      const errors = value.errors || [];

      // Process incoming messages
      for (const msg of messages) {
        try {
          await processIncomingMessage(msg, contacts, metadata);
        } catch (err) {
          console.error('[CloudAPI] Failed to process incoming message:', err.message);
        }
      }

      // Process status updates (sent, delivered, read)
      for (const status of statuses) {
        try {
          processStatusUpdate(status);
        } catch (err) {
          console.error('[CloudAPI] Failed to process status update:', err.message);
        }
      }

      // Log errors
      for (const error of errors) {
        console.error('[CloudAPI] Webhook error:', JSON.stringify(error));
      }
    }
  }
}

/**
 * Process a single incoming message from the webhook.
 */
async function processIncomingMessage(msg, contacts, metadata) {
  const senderPhone = msg.from; // e.g. "919876543210"
  const senderJid = phoneToJid(senderPhone);
  const messageId = msg.id; // wamid.xxx
  const timestamp = Number(msg.timestamp); // Unix seconds

  // Resolve sender name from contacts array
  const contactInfo = contacts.find((c) => c.wa_id === senderPhone);
  const senderName = contactInfo?.profile?.name || senderPhone;

  // Update contact store
  if (!stores.contactStore[senderJid]) {
    stores.contactStore[senderJid] = { id: senderJid };
  }
  if (senderName && senderName !== senderPhone) {
    stores.contactStore[senderJid].notify = senderName;
    database.upsertContact(stores.contactStore[senderJid]);
  }

  let content = '';
  let mediaType = 'text';
  let mediaUrl = null;
  let fileName = null;
  let mimetype = null;
  let quotedMessageId = null;
  let quotedContent = null;
  let quotedSender = null;
  let quotedMediaType = null;

  // Handle reply context
  if (msg.context?.id) {
    quotedMessageId = msg.context.id;
    // Try to find the quoted message in our store
    const quotedMsg = stores.findMessageInThread(senderJid, quotedMessageId);
    if (quotedMsg) {
      quotedContent = quotedMsg.content || null;
      quotedSender = quotedMsg.sender || null;
      quotedMediaType = quotedMsg.mediaType || null;
    }
  }

  switch (msg.type) {
    case 'text':
      content = msg.text?.body || '';
      mediaType = 'text';
      break;

    case 'image':
      content = msg.image?.caption || '';
      mediaType = 'image';
      mimetype = msg.image?.mime_type || 'image/jpeg';
      if (msg.image?.id) {
        try {
          const media = await downloadMedia(msg.image.id);
          const ext = media.extension || 'jpg';
          const localName = `${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(MEDIA_DIR, localName), media.buffer);
          mediaUrl = `/media/${localName}`;
        } catch (e) {
          console.error('[CloudAPI] Image download failed:', e.message);
        }
      }
      break;

    case 'video':
      content = msg.video?.caption || '';
      mediaType = 'video';
      mimetype = msg.video?.mime_type || 'video/mp4';
      if (msg.video?.id) {
        try {
          const media = await downloadMedia(msg.video.id);
          const ext = media.extension || 'mp4';
          const localName = `${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(MEDIA_DIR, localName), media.buffer);
          mediaUrl = `/media/${localName}`;
        } catch (e) {
          console.error('[CloudAPI] Video download failed:', e.message);
        }
      }
      break;

    case 'audio':
      mediaType = msg.audio?.voice ? 'voice' : 'audio';
      mimetype = msg.audio?.mime_type || 'audio/ogg';
      content = msg.audio?.voice ? 'Voice message' : 'Audio file';
      if (msg.audio?.id) {
        try {
          const media = await downloadMedia(msg.audio.id);
          const ext = media.extension || 'ogg';
          const localName = `${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(MEDIA_DIR, localName), media.buffer);
          mediaUrl = `/media/${localName}`;
        } catch (e) {
          console.error('[CloudAPI] Audio download failed:', e.message);
        }
      }
      break;

    case 'document':
      fileName = msg.document?.filename || 'document';
      content = `Document: ${fileName}`;
      mediaType = 'document';
      mimetype = msg.document?.mime_type || 'application/octet-stream';
      if (msg.document?.id) {
        try {
          const media = await downloadMedia(msg.document.id);
          const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const localName = `${Date.now()}-${safeName}`;
          fs.writeFileSync(path.join(MEDIA_DIR, localName), media.buffer);
          mediaUrl = `/media/${localName}`;
        } catch (e) {
          console.error('[CloudAPI] Document download failed:', e.message);
        }
      }
      break;

    case 'sticker':
      content = 'Sticker';
      mediaType = 'sticker';
      mimetype = msg.sticker?.mime_type || 'image/webp';
      if (msg.sticker?.id) {
        try {
          const media = await downloadMedia(msg.sticker.id);
          const localName = `${Date.now()}.webp`;
          fs.writeFileSync(path.join(MEDIA_DIR, localName), media.buffer);
          mediaUrl = `/media/${localName}`;
        } catch (e) {
          console.error('[CloudAPI] Sticker download failed:', e.message);
        }
      }
      break;

    case 'location':
      mediaType = 'location';
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;
      content = msg.location?.name || 'Shared location';
      mediaUrl = `https://maps.google.com/?q=${lat},${lng}`;
      break;

    case 'contacts':
      const names = (msg.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ');
      content = `[Contacts] ${names || 'contact'}`;
      break;

    case 'button':
      content = msg.button?.text || '[Button response]';
      break;

    case 'interactive':
      if (msg.interactive?.type === 'button_reply') {
        content = msg.interactive.button_reply?.title || '[Button reply]';
      } else if (msg.interactive?.type === 'list_reply') {
        content = msg.interactive.list_reply?.title || '[List reply]';
      } else {
        content = '[Interactive message]';
      }
      break;

    case 'reaction':
      console.log(`[CloudAPI] Reaction from ${senderPhone}: ${msg.reaction?.emoji} on ${msg.reaction?.message_id}`);
      return;

    default:
      content = `[${msg.type || 'Unknown'} message]`;
      break;
  }

  // Check for active chat view (for auto-read)
  const isChatActive = checkIfChatActive(senderJid);

  const parsed = stores.normalizeMessageRecord({
    id: messageId,
    from: senderJid,
    jid: senderJid,
    fromMe: false,
    participant: null,
    sender: senderName,
    operatorId: null,
    operatorName: null,
    content,
    mediaType,
    mediaUrl,
    fileName,
    mimetype,
    timestamp,
    isGroup: false,
    editedAt: null,
    deleted: false,
    clientTempId: null,
    quotedMessageId,
    quotedContent,
    quotedSender,
    quotedMediaType,
    status: null,
    raw: null,
  });

  // Deduplicate
  const thread = stores.messageStore[senderJid] || [];
  if (thread.some((existing) => existing.id === parsed.id)) return;

  stores.addMessageToStore(parsed);
  io.emit('message', parsed);
  stores.scheduleStatsEmit();

  // ── AI Bot: fire-and-forget processing ──
  aiBot.handleIncomingMessage(parsed).catch((err) => {
    console.error('[AI-Bot] Background processing error:', err.message);
  });

  // Auto-read if chat is active in dashboard
  if (isChatActive) {
    markAsRead(messageId);
  }

  // Update chat store
  if (!stores.chatStore[senderJid]) {
    const resolved = stores.resolveContactName(senderJid);
    stores.chatStore[senderJid] = stores.normalizeChat({
      id: senderJid,
      name: resolved || senderName || stores.chatDisplayName(senderJid),
      type: 'individual',
      unreadCount: isChatActive ? 0 : 1,
      timestamp,
      lastMsg: content,
      lastMsgFromMe: false,
      lastMsgStatus: null,
    });
  } else {
    stores.chatStore[senderJid].lastMsg = content;
    stores.chatStore[senderJid].timestamp = timestamp;
    stores.chatStore[senderJid].lastMsgFromMe = false;
    stores.chatStore[senderJid].lastMsgStatus = null;
    if (!isChatActive) {
      stores.chatStore[senderJid].unreadCount = (stores.chatStore[senderJid].unreadCount || 0) + 1;
    }
    // Update name if we have a better one
    const resolved = stores.resolveContactName(senderJid);
    if (resolved) {
      stores.chatStore[senderJid].name = resolved;
    } else if (senderName && senderName !== senderPhone) {
      stores.chatStore[senderJid].name = senderName;
    }
  }
  database.upsertChat(stores.chatStore[senderJid]);
  stores.scheduleBroadcastChats();
  stores.saveStore();
}

/**
 * Process a status update (sent, delivered, read, failed).
 */
function processStatusUpdate(status) {
  const messageId = status.id;
  const recipientPhone = status.recipient_id;
  const recipientJid = phoneToJid(recipientPhone);
  const statusValue = status.status;
  const timestamp = Number(status.timestamp);

  // Map Cloud API status strings to our numeric status codes:
  // 0 = ERROR/failed, 1 = PENDING, 2 = SERVER_ACK (sent), 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED
  const statusMap = {
    sent: 2,
    delivered: 3,
    read: 4,
    failed: 0,
  };

  const numericStatus = statusMap[statusValue];
  if (numericStatus === undefined) return;

  // Find and update the message in our store
  const threadJids = [recipientJid];
  let found = false;

  for (const threadJid of threadJids) {
    const thread = stores.messageStore[threadJid];
    if (!thread) continue;
    const msg = thread.find((item) => item.id === messageId);
    if (!msg) continue;
    if (msg.status === numericStatus) continue;

    // Only upgrade, never downgrade (except for failures)
    if (numericStatus !== 0 && msg.status !== null && msg.status >= numericStatus) continue;

    msg.status = numericStatus;
    database.upsertMessage(msg);
    found = true;
    io.emit('message_status_update', { jid: threadJid, messageId, status: numericStatus, fromMe: true });

    // Update chat preview tick
    if (thread[thread.length - 1] === msg && stores.chatStore[threadJid]) {
      stores.chatStore[threadJid].lastMsgStatus = msg.fromMe ? (msg.status ?? null) : null;
    }
  }

  if (found) {
    stores.broadcastChats();
    stores.saveStore();
  }

  // Log failures with details
  if (statusValue === 'failed' && status.errors) {
    for (const err of status.errors) {
      console.error(`[CloudAPI] Message ${messageId} failed:`, {
        code: err.code,
        title: err.title,
        message: err.message,
        href: err.error_data?.details,
      });
    }
  }
}

function checkIfChatActive(jid) {
  if (!io) return false;
  const sockets = io.sockets.sockets;
  for (const s of sockets.values()) {
    if (s.activeJid === jid) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function configure(config = {}) {
  ACCESS_TOKEN = config.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || process.env.WA_PERMANENT_TOKEN || process.env.WA_TOKEN || '';
  PHONE_NUMBER_ID = config.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WA_PHONE_ID || process.env.PHONE_NUMBER_ID || '';
  VERIFY_TOKEN = config.WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'my_verify_token_123';
  GRAPH_API_VERSION = config.GRAPH_API_VERSION || process.env.GRAPH_API_VERSION || 'v21.0';
  BUSINESS_ACCOUNT_ID = config.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WA_WABA_ID || process.env.WABA_ID || '';

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || ACCESS_TOKEN === 'your_meta_system_user_access_token_here') {
    connectionStatus = 'missing_config';
    console.warn('[CloudAPI] ⚠️ WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set in .env.');
    console.warn('[CloudAPI] Set them in your .env file to enable WhatsApp Cloud API sending and receiving.');
    if (io) {
      io.emit('status', {
        status: 'missing_config',
        message: 'WhatsApp Cloud API credentials not configured in .env',
        connectorOperatorId: null,
        connectorOperatorName: null,
        myJid: null,
      });
    }
    aiBot.setSock(getSock());
    return false;
  }

  connectionStatus = 'connected';
  console.log('[CloudAPI] ✅ Configured successfully.');
  console.log(`[CloudAPI] Phone Number ID: ${PHONE_NUMBER_ID}`);
  console.log(`[CloudAPI] Graph API Version: ${GRAPH_API_VERSION}`);

  // Restore connector operator from database
  if (database) {
    const storedOpId = database.getMetadata('connector_operator_id');
    const storedOpName = database.getMetadata('connector_operator_name');
    if (storedOpId) {
      stores.setConnectorOperator(storedOpId, storedOpName);
    }
  }

  aiBot.setSock(getSock());

  if (io) {
    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    io.emit('status', {
      status: 'connected',
      connectorOperatorId,
      connectorOperatorName,
      myJid: PHONE_NUMBER_ID,
    });
  }
  return true;
}

/**
 * Verify the access token by making a test API call.
 * Returns true if the token is valid.
 */
async function verifyToken() {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || ACCESS_TOKEN === 'your_meta_system_user_access_token_here') return false;
  try {
    const { status, data } = await apiRequest('GET', graphUrl(PHONE_NUMBER_ID));
    if (status === 200 && data?.id) {
      console.log(`[CloudAPI] Token verified. Phone number: ${data.display_phone_number || data.id}`);
      return true;
    }
    console.warn('[CloudAPI] Token verification failed:', data?.error?.message || 'Unknown error');
    return false;
  } catch (err) {
    console.error('[CloudAPI] Token verification error:', err.message);
    return false;
  }
}

/**
 * Initialize the Cloud API.
 */
async function connectToWhatsApp() {
  configure(getConfig());
  if (connectionStatus === 'connected') {
    const valid = await verifyToken();
    if (!valid) {
      connectionStatus = 'missing_config';
      if (io) {
        io.emit('status', {
          status: 'missing_config',
          message: 'Access token is invalid or expired. Please update WHATSAPP_ACCESS_TOKEN in .env',
        });
      }
    }
  }
}

/**
 * Disconnect — resets the session and state.
 */
async function disconnectWhatsApp() {
  console.log('[CloudAPI] Disconnecting session...');
  ACCESS_TOKEN = '';
  PHONE_NUMBER_ID = '';
  connectionStatus = 'disconnected';

  database.clearAllData();
  stores.clearInMemoryStores();
  stores.setConnectorOperator(null, null);

  io.emit('status', { status: 'disconnected', connectorOperatorId: null, connectorOperatorName: null, myJid: null });
  io.emit('chats', []);
  io.emit('groups', []);

  console.log('[CloudAPI] Disconnected and cleared local data.');
}

// Read config from file or env
function getConfig() {
  const configPath = ROOT_DIR ? path.join(ROOT_DIR, 'config.json') : null;
  let config = {};
  if (configPath && fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('[CloudAPI] Failed to read config.json:', e.message);
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Public API — matches the interface expected by routes.js and bridge.js
// ---------------------------------------------------------------------------

function getStatus() { return connectionStatus; }
function isReady() { return connectionStatus === 'connected' && ACCESS_TOKEN && PHONE_NUMBER_ID && ACCESS_TOKEN !== 'your_meta_system_user_access_token_here'; }
function getPhoneNumberId() { return PHONE_NUMBER_ID; }

// Compatibility: routes.js calls whatsapp.getSock() to check readiness.
function getSock() {
  if (!isReady()) return null;
  return {
    user: { id: PHONE_NUMBER_ID },
    sendMessage: async (jid, payload, options = {}) => {
      if (payload.text !== undefined) {
        return sendText(jid, payload.text, { quotedMessageId: options?.quotedMessageId || options?.quoted?.key?.id });
      }
      if (payload.image) {
        const tmpPath = path.join(MEDIA_DIR, `upload-${Date.now()}.jpg`);
        fs.writeFileSync(tmpPath, payload.image);
        return await sendImage(jid, tmpPath, payload.caption || '', payload.mimetype || 'image/jpeg');
      }
      if (payload.video) {
        const tmpPath = path.join(MEDIA_DIR, `upload-${Date.now()}.mp4`);
        fs.writeFileSync(tmpPath, payload.video);
        return await sendVideo(jid, tmpPath, payload.caption || '', payload.mimetype || 'video/mp4');
      }
      if (payload.audio) {
        const tmpPath = path.join(MEDIA_DIR, `upload-${Date.now()}.ogg`);
        fs.writeFileSync(tmpPath, payload.audio);
        return await sendAudio(jid, tmpPath, payload.mimetype || 'audio/ogg; codecs=opus');
      }
      if (payload.document) {
        const tmpPath = path.join(MEDIA_DIR, `upload-${Date.now()}-${(payload.fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        fs.writeFileSync(tmpPath, payload.document);
        return await sendDocument(jid, tmpPath, payload.fileName || 'document', payload.mimetype || 'application/octet-stream');
      }
      if (payload.location) {
        return sendLocation(jid, payload.location.degreesLatitude, payload.location.degreesLongitude, payload.location.name);
      }
      throw new Error(`Unsupported message payload: ${Object.keys(payload).join(', ')}`);
    },
    readMessages: async (keys) => {
      for (const key of keys) {
        if (key.id) await markAsRead(key.id);
      }
    },
    onWhatsApp: async (number) => {
      const clean = String(number).replace(/[^0-9]/g, '');
      return [{ jid: `${clean}@s.whatsapp.net`, exists: true }];
    },
    updateMediaMessage: async (raw) => raw,
  };
}

function markChatAsRead(jid) {
  const threadMsgs = stores.getMessagesForJid(jid);
  if (!threadMsgs || threadMsgs.length === 0) return;
  const lastIncoming = [...threadMsgs].reverse().find((m) => !m.fromMe);
  if (lastIncoming) {
    markAsRead(lastIncoming.id);
  }
}

module.exports = {
  init,
  configure,
  getSock,
  getStatus,
  isReady,
  getPhoneNumberId,
  connectToWhatsApp,
  disconnectWhatsApp,
  markChatAsRead,
  markAsRead,
  handleWebhookVerification,
  handleWebhookPayload,
  sendText,
  sendImage,
  sendVideo,
  sendAudio,
  sendDocument,
  sendLocation,
  downloadMedia,
  phoneToJid,
  jidToPhone,
};
