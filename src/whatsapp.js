/**
 * Baileys WhatsApp connection lifecycle: connect/reconnect, event wiring,
 * inbound message parsing (including media download), and group sync.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  aesDecryptGCM,
  hmacSign,
  proto,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

let stores = null;
let database = null;
let io = null;
let ROOT_DIR = null;
let MEDIA_DIR = null;

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 300000;
let reconnectTimer = null;
let isConnecting = false;
let isDisconnecting = false;
let activeHistorySyncs = 0;

// Retries unresolved @lid mappings periodically since Baileys' lid<->phone
// mapping store fills in lazily and a single attempt at connect time often
// misses LIDs that resolve only after more contact/history sync traffic.
const LID_RETRY_INTERVAL_MS = 10 * 60 * 1000;
let lidRetryTimer = null;

function stopLidRetryTimer() {
  if (lidRetryTimer) {
    clearInterval(lidRetryTimer);
    lidRetryTimer = null;
  }
}

function startLidRetryTimer() {
  stopLidRetryTimer();
  lidRetryTimer = setInterval(() => {
    stores.resolveAllLidsFromStore();
  }, LID_RETRY_INTERVAL_MS);
}

// Tracks in-flight on-demand history requests (sock.fetchMessageHistory) keyed
// by jid, so the 'messaging-history.set' handler can resolve the matching
// caller once WhatsApp sends the older messages back, instead of the caller
// having no way to know when/if the response arrived.
const pendingHistoryRequests = new Map(); // jid -> { resolve, timer }
const HISTORY_REQUEST_TIMEOUT_MS = 15000;
// Jids WhatsApp has told us (via an empty on-demand response) have no more
// history before our oldest known message. Avoids re-asking on every click.
const exhaustedHistoryJids = new Set();

function resolvePendingHistoryRequest(jid) {
  const pending = pendingHistoryRequests.get(jid);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingHistoryRequests.delete(jid);
  pending.resolve(true);
}

// Asks WhatsApp itself for older messages of `jid`, anchored on the oldest
// message we currently have locally. WhatsApp streams the result back through
// the same 'messaging-history.set' event used for the initial sync, which
// already persists everything it receives via addMessageToStore.
async function requestOlderHistory(jid, count = 50) {
  if (!sock || connectionStatus !== 'connected') {
    return { ok: false, message: 'Not connected to WhatsApp' };
  }
  if (exhaustedHistoryJids.has(jid)) {
    return { ok: true, added: 0, hasMore: false, exhausted: true };
  }
  if (pendingHistoryRequests.has(jid)) {
    return { ok: false, message: 'A history request for this chat is already in progress' };
  }
  const existing = stores.getMessagesForJid(jid);
  const oldest = existing[0];
  if (!oldest) {
    return { ok: false, message: 'No anchor message available for this chat' };
  }

  const countBefore = existing.length;
  const key = { remoteJid: jid, fromMe: Boolean(oldest.fromMe), id: oldest.id };
  const timestampMs = stores.toTimestamp(oldest.timestamp) * 1000;

  try {
    await sock.fetchMessageHistory(Math.min(count, 50), key, timestampMs);
  } catch (e) {
    console.error(`[Bridge] fetchMessageHistory request failed for ${jid}:`, e.message);
    return { ok: false, message: e.message };
  }

  const arrived = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingHistoryRequests.delete(jid);
      resolve(false);
    }, HISTORY_REQUEST_TIMEOUT_MS);
    pendingHistoryRequests.set(jid, { resolve, timer });
  });

  const countAfter = stores.getMessagesForJid(jid).length;
  const added = Math.max(0, countAfter - countBefore);
  if (added === 0) exhaustedHistoryJids.add(jid);
  return { ok: true, timedOut: !arrived, added, hasMore: added > 0 };
}

function init(deps) {
  ({ stores, database, io, ROOT_DIR, MEDIA_DIR } = deps);
}

function getThreadJids(jid) {
  if (!jid) return [];
  const preferred = stores.getPreferredJid(jid) || jid;
  const alt = preferred.endsWith('@lid') ? stores.lidToJid[preferred] : stores.jidToLid[preferred];
  return alt ? [preferred, alt] : [preferred];
}

function markMessageDeletedInStore(jid, messageId, options = {}) {
  if (!jid || !messageId) return false;
  console.log('[DEBUG-EDIT] markMessageDeletedInStore called:', { jid, messageId, options });
  const emitEvent = options.emitEvent !== false;
  const targetJids = getThreadJids(jid);
  let found = false;

  for (const threadJid of targetJids) {
    const thread = stores.messageStore[threadJid];
    if (!thread) continue;
    const msg = thread.find((item) => item.id === messageId);
    if (!msg) continue;
    msg.deleted = true;
    msg.content = '';
    msg.mediaUrl = null;
    database.upsertMessage(msg);
    found = true;

    const chat = stores.chatStore[threadJid];
    if (chat) {
      const messages = stores.getMessagesForJid(threadJid);
      const last = messages[messages.length - 1];
      chat.lastMsg = last?.deleted ? 'This message was deleted' : (last?.content || '');
      if (last?.timestamp) chat.timestamp = last.timestamp;
      database.upsertChat(chat);
    }
  }

  if (found) {
    if (emitEvent) io.emit('message_deleted', { jid: targetJids[0], messageId });
    stores.broadcastChats();
    stores.saveStore();
  }

  return found;
}

function handleMessageEditInStore(jid, messageId, newContent, options = {}) {
  if (!jid || !messageId) return false;
  console.log('[DEBUG-EDIT] handleMessageEditInStore called:', { jid, messageId, newContent: newContent?.substring(0, 80), options });
  const emitEvent = options.emitEvent !== false;
  const targetJids = getThreadJids(jid);
  let found = false;
  const editedAt = Math.floor(Date.now() / 1000);
  let updatedEdits = [];

  for (const threadJid of targetJids) {
    const thread = stores.messageStore[threadJid];
    let msg = null;
    if (thread) {
      msg = thread.find((item) => item.id === messageId);
    }

    if (!msg) {
      try {
        const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(messageId);
        if (row) {
          msg = stores.normalizeMessageRecord(JSON.parse(row.payload));
        }
      } catch (dbErr) {
        console.warn('[Bridge] Failed to find message in DB for edit:', dbErr.message);
      }
    }

    if (!msg) continue;
    // newContent === null means we know an edit happened but couldn't recover
    // the new text (e.g. missing/undecryptable messageSecret) - still mark it
    // edited so the UI reflects reality, without blanking the existing content.
    if (newContent !== null && msg.content === newContent) {
      continue;
    }
    if (newContent !== null) {
      msg.content = newContent;
    }
    msg.editedAt = editedAt;
    if (msg.fromMe) {
      msg.status = 2; // Reset status back to sent (SERVER_ACK) when edited
    }
    if (options.editMsgId) {
      msg.latestEditMsgId = options.editMsgId;
    }

    let editOperatorId = 'whatsapp-device';
    let editOperatorName = 'WhatsApp Device';

    if (options.isExternal) {
      if (!msg.fromMe) {
        editOperatorId = 'sender';
        editOperatorName = 'Sender';
      }
    } else {
      const { id: opId, name: opName } = stores.getConnectorOperator();
      if (opId) {
        editOperatorId = opId;
        editOperatorName = opName;
      }
    }

    if (!msg.edits) msg.edits = [];
    msg.edits.push({
      operatorId: editOperatorId,
      operatorName: editOperatorName,
      editedAt: editedAt * 1000,
      editMsgId: options.editMsgId || null,
    });
    updatedEdits = msg.edits;

    database.upsertMessage(msg);
    found = true;

    const chat = stores.chatStore[threadJid];
    if (chat) {
      const messages = stores.getMessagesForJid(threadJid);
      const last = messages[messages.length - 1];
      chat.lastMsg = last?.deleted ? 'This message was deleted' : (last?.content || '');
      if (last?.timestamp) chat.timestamp = last.timestamp;
      database.upsertChat(chat);
    }
  }

  if (found) {
    if (emitEvent) {
      io.emit('message_edited', { jid: targetJids[0], messageId, newContent, editedAt: editedAt * 1000, edits: updatedEdits });
      for (const threadJid of targetJids) {
        const thread = stores.messageStore[threadJid];
        const msg = thread?.find((item) => item.id === messageId);
        if (msg && msg.fromMe) {
          io.emit('message_status_update', { jid: threadJid, messageId: msg.id, status: 2, fromMe: true });
        }
      }
    }
    stores.broadcastChats();
    stores.saveStore();
  }

  return found;
}

function handleMessageStatusUpdateInStore(jid, messageId, status, fromMe) {
  if (!jid || !messageId) return false;
  const targetJids = getThreadJids(jid);
  let found = false;

  for (const threadJid of targetJids) {
    const thread = stores.messageStore[threadJid];
    if (!thread) continue;
    
    // Find message by its ID, OR by its latestEditMsgId, OR if one of its edits matches messageId
    const msg = thread.find((item) => 
      item.id === messageId || 
      item.latestEditMsgId === messageId || 
      (item.edits && item.edits.some(e => e.editMsgId === messageId))
    );
    if (!msg) continue;

    if (msg.status !== status) {
      msg.status = status;
      database.upsertMessage(msg);
      found = true;
    }
  }

  if (found) {
    for (const threadJid of targetJids) {
      const thread = stores.messageStore[threadJid];
      const msg = thread?.find((item) => 
        item.id === messageId || 
        item.latestEditMsgId === messageId || 
        (item.edits && item.edits.some(e => e.editMsgId === messageId))
      );
      if (msg) {
        io.emit('message_status_update', { jid: threadJid, messageId: msg.id, status, fromMe });
      }
    }
    stores.saveStore();
  }

  return found;
}

function isChatActive(jid) {
  if (!io) return false;
  const sockets = io.sockets.sockets;
  const targetJids = getThreadJids(jid);
  for (const s of sockets.values()) {
    if (s.activeJid && targetJids.includes(s.activeJid)) {
      return true;
    }
  }
  return false;
}

async function markChatAsRead(jid) {
  if (!sock || connectionStatus !== 'connected') return;
  try {
    const threadMsgs = stores.getMessagesForJid(jid);
    if (!threadMsgs || threadMsgs.length === 0) return;

    // Find the last incoming message (not from me)
    const lastIncoming = [...threadMsgs].reverse().find(m => !m.fromMe);
    if (lastIncoming) {
      const key = {
        remoteJid: lastIncoming.jid || jid,
        id: lastIncoming.id,
        fromMe: false,
        participant: lastIncoming.participant || undefined,
      };
      await sock.readMessages([key]);
    }
  } catch (err) {
    console.warn(`[Bridge] Failed to mark chat ${jid} as read:`, err.message);
  }
}

function getMessageSecret(raw) {
  if (!raw) return null;
  const m = stores.unwrapMessage(raw);
  if (!m) return null;

  if (m.messageContextInfo?.messageSecret) {
    return m.messageContextInfo.messageSecret;
  }

  for (const key of Object.keys(m)) {
    const sub = m[key];
    if (sub && typeof sub === 'object') {
      if (sub.messageContextInfo?.messageSecret) {
        return sub.messageContextInfo.messageSecret;
      }
      if (sub.contextInfo?.messageSecret) {
        return sub.contextInfo.messageSecret;
      }
    }
  }
  return null;
}

function decryptSecretEdit(sem, secretBuffer, originalId, originalSenderJid) {
  const jidsToTry = [originalSenderJid];
  const alternative = originalSenderJid.endsWith('@lid')
    ? stores.lidToJid[originalSenderJid]
    : stores.jidToLid[originalSenderJid];
  if (alternative) {
    jidsToTry.push(jidNormalizedUser(alternative));
  }

  const encPayload = sem.encPayload;
  const encIv = sem.encIv;

  for (const senderJid of jidsToTry) {
    try {
      const toBinary = (txt) => Buffer.from(txt);
      const senderBuf = toBinary(senderJid);
      
      const sign = Buffer.concat([ 
        toBinary(originalId), 
        senderBuf, 
        senderBuf, 
        toBinary('Message Edit'), 
        new Uint8Array([1]) 
      ]);
      
      const key = hmacSign(secretBuffer, new Uint8Array(32));
      const decKey = hmacSign(sign, key);
      const decrypted = aesDecryptGCM(encPayload, decKey, encIv, Buffer.alloc(0));
      
      const decoded = proto.Message.decode(decrypted);
      if (decoded) {
        return decoded;
      }
    } catch (err) {
      console.warn(`[DEBUG-EDIT] Decryption failed with sender JID ${senderJid}:`, err.message);
    }
  }
  return null;
}

function handleProtocolMessage(rawMsg, unwrappedMsg, options = {}) {
  // Handle secretEncryptedMessage edit
  if (unwrappedMsg?.secretEncryptedMessage) {
    const sem = unwrappedMsg.secretEncryptedMessage;
    // secretEncType can be 2 (MESSAGE_EDIT) or 'MESSAGE_EDIT'
    if (sem.secretEncType === 2 || sem.secretEncType === 'MESSAGE_EDIT' || sem.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) {
      const targetId = sem.targetMessageKey?.id;
      // rawMsg.key.remoteJid reflects our own thread-keying convention; the
      // embedded targetMessageKey.remoteJid is recorded from the original
      // sender's device perspective and is wrong (often our own jid) when the
      // edit comes from someone else.
      const targetJid = stores.getPreferredJid(rawMsg?.key?.remoteJid || sem.targetMessageKey?.remoteJid);
      if (targetId && targetJid) {
        console.log('[DEBUG-EDIT] Found secretEncryptedMessage of type MESSAGE_EDIT for target:', targetId);
        
        let origMsg = null;
        const thread = stores.messageStore[targetJid];
        if (thread) {
          origMsg = thread.find(m => m.id === targetId);
        }
        if (!origMsg) {
          try {
            const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(targetId);
            if (row) {
              origMsg = stores.normalizeMessageRecord(JSON.parse(row.payload));
            }
          } catch (dbErr) {
            console.warn('[Bridge] Failed to find message in DB for secretEncryptedMessage:', dbErr.message);
          }
        }
        
        if (origMsg) {
          const messageSecret = getMessageSecret(origMsg.raw);
          console.log('[DEBUG-EDIT] origMsg lookup:', {
            hasRaw: !!origMsg.raw,
            rawKeys: origMsg.raw ? Object.keys(origMsg.raw) : null,
            fromMe: origMsg.fromMe,
            hasMessageSecret: !!messageSecret,
          });
          if (messageSecret) {
            let secretBuffer = null;
            if (typeof messageSecret === 'string') {
              secretBuffer = Buffer.from(messageSecret, 'base64');
            } else if (Buffer.isBuffer(messageSecret) || messageSecret instanceof Uint8Array) {
              secretBuffer = Buffer.from(messageSecret);
            }
            
            if (secretBuffer) {
              const myJidNormalised = jidNormalizedUser(sock?.user?.id || '');
              const origSender = origMsg.fromMe
                ? myJidNormalised
                : (origMsg.participant || origMsg.jid || origMsg.from || '');
              const normalizedSender = jidNormalizedUser(origSender);
              
              const decryptedMessage = decryptSecretEdit(sem, secretBuffer, targetId, normalizedSender);
              if (decryptedMessage) {
                // The decrypted plaintext is a protocolMessage(MESSAGE_EDIT) wrapper,
                // same shape as the plaintext edit path below - not a bare Message.
                const editedContent =
                  decryptedMessage.protocolMessage?.editedMessage ||
                  decryptedMessage.editedMessage?.message ||
                  decryptedMessage;
                const unwrappedEdited = stores.unwrapMessage(editedContent);
                if (unwrappedEdited) {
                  const newContent =
                    unwrappedEdited.conversation ||
                    unwrappedEdited.extendedTextMessage?.text ||
                    unwrappedEdited.imageMessage?.caption ||
                    unwrappedEdited.videoMessage?.caption ||
                    '';
                  handleMessageEditInStore(targetJid, targetId, newContent, { ...options, editMsgId: rawMsg?.key?.id });
                }
              } else {
                // Couldn't decrypt the new text - still surface that an edit happened.
                console.warn('[DEBUG-EDIT] Failed to decrypt secretEncryptedMessage.');
                handleMessageEditInStore(targetJid, targetId, null, { ...options, editMsgId: rawMsg?.key?.id });
              }
            } else {
              console.warn('[DEBUG-EDIT] messageSecret present but in an unrecognized format.');
              handleMessageEditInStore(targetJid, targetId, null, { ...options, editMsgId: rawMsg?.key?.id });
            }
          } else {
            // No messageSecret available for the original message (e.g. it predates
            // edit support or arrived without one) - can't recover the new text, but
            // still flag the message as edited rather than silently dropping the event.
            console.warn('[DEBUG-EDIT] Original message found, but messageSecret is missing.');
            handleMessageEditInStore(targetJid, targetId, null, { ...options, editMsgId: rawMsg?.key?.id });
          }
        } else {
          console.warn('[DEBUG-EDIT] Original message not found in store or DB for ID:', targetId);
        }
      }
      return true; // Stop processing this secretEncryptedMessage as a new message
    }
  }

  // If it's an editedMessage container (decrypted edit update)
  if (unwrappedMsg?.editedMessage) {
    const targetId = rawMsg?.key?.id;
    const targetJid = stores.getPreferredJid(rawMsg?.key?.remoteJid);
    if (!targetId || !targetJid) return true;

    const editedMsg = unwrappedMsg.editedMessage.message;
    if (editedMsg) {
      const unwrappedEdited = stores.unwrapMessage(editedMsg);
      if (unwrappedEdited) {
        const newContent =
          unwrappedEdited.conversation ||
          unwrappedEdited.extendedTextMessage?.text ||
          unwrappedEdited.imageMessage?.caption ||
          unwrappedEdited.videoMessage?.caption ||
          '';
        handleMessageEditInStore(targetJid, targetId, newContent, { ...options, editMsgId: rawMsg?.key?.id });
      }
    }
    return true;
  }

  const protocol = unwrappedMsg?.protocolMessage;
  if (!protocol) return false;

  console.log('[DEBUG-EDIT] Received protocolMessage type:', protocol.type, 'for target key:', JSON.stringify(protocol.key), 'rawMsg.key:', JSON.stringify(rawMsg.key));

  // WhatsApp "Delete for everyone" arrives as protocolMessage(type=0)
  // referencing the target message key rather than a normal content message.
  if (protocol.type === 0) {
    const targetId = protocol.key?.id;
    const targetJid = stores.getPreferredJid(rawMsg?.key?.remoteJid || protocol.key?.remoteJid);
    if (!targetId || !targetJid) return true;
    markMessageDeletedInStore(targetJid, targetId, options);
    return true;
  }

  // WhatsApp Edit Message arrives as protocolMessage(type=14)
  if (protocol.type === 14) {
    const targetId = protocol.key?.id;
    const targetJid = stores.getPreferredJid(rawMsg?.key?.remoteJid || protocol.key?.remoteJid);
    if (!targetId || !targetJid) return true;
    
    // Extract new edited text content
    const editedMsg = protocol.editedMessage;
    if (editedMsg) {
      const unwrappedEdited = stores.unwrapMessage(editedMsg);
      if (unwrappedEdited) {
        const newContent =
          unwrappedEdited.conversation ||
          unwrappedEdited.extendedTextMessage?.text ||
          unwrappedEdited.imageMessage?.caption ||
          unwrappedEdited.videoMessage?.caption ||
          '';
        handleMessageEditInStore(targetJid, targetId, newContent, { ...options, editMsgId: rawMsg?.key?.id });
      }
    }
    return true;
  }

  return false;
}

function setSock(newSock) {
  sock = newSock;
  stores.setSock(newSock);
}

function getSock() { return sock; }
function getStatus() { return connectionStatus; }
function getQrCodeData() { return qrCodeData; }

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[Bridge] Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

async function disconnectWhatsApp() {
  // sock.logout() below triggers Baileys' own 'connection.update' close handler
  // (reason: loggedOut), which calls disconnectWhatsApp() again re-entrantly.
  // Without this guard, that second call races the first and force-ends the
  // socket (sock.end()) while the original logout request is still in flight,
  // aborting it before WhatsApp's servers process the unlink - leaving the
  // device shown as still linked even though the app cleared its local state.
  if (isDisconnecting) return;
  isDisconnecting = true;
  try {
    console.log('[Bridge] Disconnecting WhatsApp session...');
    stopLidRetryTimer();
    exhaustedHistoryJids.clear();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.error('[Bridge] Error during sock.logout():', err.message);
        try {
          sock.end();
        } catch (e) {
          console.error('[Bridge] Error ending socket:', e.message);
        }
      }
      setSock(null);
    }

    const authPaths = [
      path.join(ROOT_DIR, 'auth_info'),
      path.resolve('./auth_info')
    ];
    for (const authPath of authPaths) {
      if (fs.existsSync(authPath)) {
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
          console.log(`[Bridge] Cleared credentials directory at ${authPath}`);
        } catch (e) {
          console.error(`[Bridge] Error clearing directory ${authPath}:`, e.message);
        }
      }
    }

    // Clear database and in-memory caches
    database.clearAllData();
    stores.clearInMemoryStores();

    // Clear connector operator
    stores.setConnectorOperator(null, null);
    stores.setLinkingOperator(null);

    connectionStatus = 'disconnected';
    qrCodeData = null;
    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    io.emit('status', { status: 'disconnected', connectorOperatorId, connectorOperatorName, myJid: sock?.user?.id || null });
    io.emit('qr', null);
    io.emit('chats', []);
    io.emit('groups', []);

    console.log('[Bridge] Restarting connection after disconnect to prepare QR code...');
    await connectToWhatsApp();
  } finally {
    isDisconnecting = false;
  }
}

// WhatsApp connection
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('[Bridge] Connection attempt already in progress.');
    return;
  }
  isConnecting = true;
  try {
    if (sock) {
      console.log('[Bridge] Closing existing socket before connecting...');
      try { sock.end(); } catch (e) { }
      setSock(null);
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    let version;
    try {
      const waVersion = await fetchLatestWaWebVersion();
      version = waVersion.version;
    } catch (e) {
      console.warn('[Bridge] Failed to fetch latest WA web version, using fallback:', e.message);
      version = [2, 3000, 1015901307];
    }
    console.log(`[Bridge] Using WA version: ${version.join('.')}`);
    setSock(makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      getMessage: async (key) => {
        try {
          const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(key.id);
          if (row) {
            const parsed = JSON.parse(row.payload);
            return parsed.raw || undefined;
          }
        } catch (e) {
          console.warn('[Bridge] getMessage failed:', e.message);
        }
        return undefined;
      }
    }));
    sock.ev.on('creds.update', saveCreds);

    const { messageStore, groupStore, contactStore, chatStore } = stores;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        connectionStatus = 'qr_ready';
        io.emit('qr', qrCodeData);
      }

      if (connection === 'close') {
        stopLidRetryTimer();
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        connectionStatus = 'disconnected';
        const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
        io.emit('status', { status: 'disconnected', reason, connectorOperatorId, connectorOperatorName, myJid: sock?.user?.id || null });
        if (reason === DisconnectReason.loggedOut) {
          console.log('[Bridge] Connection closed due to logout. Cleaning up session...');
          await disconnectWhatsApp();
        } else {
          scheduleReconnect();
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeData = null;
        reconnectDelay = 5000;

        const currentLoggedJid = sock.user?.id ? stores.cleanJidToPhone(sock.user.id) : null;
        if (currentLoggedJid) {
          const storedJid = database.getMetadata('current_logged_jid');
          if (storedJid && storedJid !== currentLoggedJid) {
            console.log(`[Bridge] Detected number change! Stored: ${storedJid}, New: ${currentLoggedJid}. Clearing all old data.`);
            database.clearAllData();
            stores.clearInMemoryStores();
            io.emit('chats', []);
            io.emit('groups', []);
          }
          database.setMetadata('current_logged_jid', currentLoggedJid);
        }

        const linkingOperator = stores.getLinkingOperator();
        if (linkingOperator) {
          database.setMetadata('connector_operator_id', linkingOperator.id);
          database.setMetadata('connector_operator_name', linkingOperator.name);
          stores.setConnectorOperator(linkingOperator.id, linkingOperator.name);
          stores.setLinkingOperator(null);
        }

        const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
        io.emit('status', { status: 'connected', connectorOperatorId, connectorOperatorName, myJid: sock?.user?.id || null });
        console.log('[Bridge] Connected to WhatsApp!');
        await loadGroups();
        stores.backfillContactNames();
        stores.resolveAllLidsFromStore();
        startLidRetryTimer();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const isHistory = type === 'append';
      if (type !== 'notify' && !isHistory) return;
      for (const msg of messages) {
        if (!msg.message) continue;

        if (msg.key?.fromMe) {
          console.log('[DEBUG-EDIT-UPSERT] fromMe msg keys:', Object.keys(msg), 'message keys:', Object.keys(msg.message || {}), 'messageContextInfo:', JSON.stringify(msg.messageContextInfo || msg.message?.messageContextInfo || null), 'messageSecret:', msg.messageSecret ? 'exists' : 'missing');
        }

        const unwrapped = stores.unwrapMessage(msg.message);
        if (handleProtocolMessage(msg, unwrapped, { isExternal: true })) continue;

        const parsedRaw = await parseMessage(msg, isHistory);
        if (!parsedRaw) continue;

        // Upsert verified name and push name into contactStore BEFORE normalizing
        const isGroup = parsedRaw.jid?.endsWith('@g.us');
        if (parsedRaw.jid && !isGroup) {
          const verifiedName = msg.verifiedBizName || msg.verifiedName || parsedRaw.verifiedBizName || parsedRaw.verifiedName;
          const pushName = msg.pushName || parsedRaw.pushName;
          if (verifiedName || pushName) {
            if (!contactStore[parsedRaw.jid]) {
              contactStore[parsedRaw.jid] = { id: parsedRaw.jid };
            }
            let contactUpdated = false;
            if (verifiedName && contactStore[parsedRaw.jid] && contactStore[parsedRaw.jid].verifiedName !== verifiedName) {
              contactStore[parsedRaw.jid].verifiedName = verifiedName;
              contactUpdated = true;
            }
            if (pushName && !contactStore[parsedRaw.jid].name && contactStore[parsedRaw.jid].notify !== pushName) {
              contactStore[parsedRaw.jid].notify = pushName;
              contactUpdated = true;
            }
            if (contactUpdated) {
              database.upsertContact(contactStore[parsedRaw.jid]);
            }
          }
        }

        const parsed = stores.normalizeMessageRecord(parsedRaw);
        parsed.jid = stores.getPreferredJid(parsed.jid);
        parsed.from = parsed.jid;
        const thread = messageStore[parsed.jid] || [];
        if (thread.some((existing) => existing.id === parsed.id)) continue;
        stores.addMessageToStore(parsed);
        io.emit('message', parsed);

        if (!parsed.fromMe && isChatActive(parsed.jid)) {
          markChatAsRead(parsed.jid);
        }
        if (!chatStore[parsed.jid]) {
          const resolved = stores.resolveContactName(parsed.jid);
          chatStore[parsed.jid] = stores.normalizeChat({
            id: parsed.jid,
            name: resolved || stores.chatDisplayName(parsed.jid),
            type: stores.getChatType(parsed.jid),
            unreadCount: (parsed.fromMe || isChatActive(parsed.jid)) ? 0 : 1,
            timestamp: parsed.timestamp,
            lastMsg: parsed.content,
          });
        } else {
          chatStore[parsed.jid].lastMsg = parsed.content;
          chatStore[parsed.jid].timestamp = parsed.timestamp;
          if (!parsed.fromMe && !isChatActive(parsed.jid)) {
            chatStore[parsed.jid].unreadCount = (chatStore[parsed.jid].unreadCount || 0) + 1;
          }
          const resolved = stores.resolveContactName(parsed.jid);
          if (resolved) {
            chatStore[parsed.jid].name = resolved;
          } else {
            const currentName = chatStore[parsed.jid].name;
            const cleanJid = parsed.jid?.split('@')[0];
            if (!currentName || currentName === cleanJid || currentName === '+' + cleanJid) {
              chatStore[parsed.jid].name = stores.chatDisplayName(parsed.jid);
            }
          }
        }
        database.upsertChat(chatStore[parsed.jid]);
        stores.broadcastChats();
        stores.saveStore();
      }
    });

    sock.ev.on('messages.update', (updates = []) => {
      for (const item of updates) {
        const key = item?.key;
        if (!key || !key.remoteJid || !key.id) continue;

        const update = item?.update || {};

        // If it's a message status/ack update
        if (update.status !== undefined) {
          handleMessageStatusUpdateInStore(key.remoteJid, key.id, update.status, key.fromMe);
        }

        // Handle "delete for everyone" (REVOKE) from regular WhatsApp users.
        // Baileys' processMessage converts protocolMessage.type === REVOKE into a
        // messages.update with { message: null, messageStubType: 1 (REVOKE) }.
        // The old code only checked `update.message` which is null for revokes.
        if (update.messageStubType === 1 /* WAMessageStubType.REVOKE */) {
          const targetJid = stores.getPreferredJid(key.remoteJid);
          if (targetJid) {
            console.log('[DEBUG-EDIT] messages.update REVOKE (delete for everyone):', JSON.stringify(key));
            markMessageDeletedInStore(targetJid, key.id);
          }
          continue;
        }

        const rawMessage = update.message || item?.message;
        if (rawMessage) {
          console.log('[DEBUG-EDIT] messages.update has message, keys:', Object.keys(rawMessage), 'key:', JSON.stringify(key));
          const unwrapped = stores.unwrapMessage(rawMessage);
          handleProtocolMessage({ key, message: rawMessage }, unwrapped, { isExternal: true });
        }
      }
    });

    sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        if (groupStore[update.id]) groupStore[update.id] = { ...groupStore[update.id], ...update };
        const meta = groupStore[update.id];
        if (meta && chatStore[update.id]) {
          const type = (meta.isCommunity || meta.isCommunityAnnounce) ? 'community' : 'group';
          if (chatStore[update.id].type !== type) {
            chatStore[update.id].type = type;
            database.upsertChat(chatStore[update.id]);
            stores.broadcastChats();
          }
        }
        io.emit('group_update', update);
      }
    });

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      try {
        const meta = await sock.groupMetadata(id);
        groupStore[id] = meta;
        io.emit('groups', Object.values(groupStore));
        stores.broadcastChats();
      } catch (e) {
        console.error('[Bridge] Failed to fetch group metadata on update:', e);
        const meta = groupStore[id];
        if (meta) {
          if (!meta.participants) meta.participants = [];
          if (action === 'add') {
            for (const p of participants) {
              if (!meta.participants.some(x => x.id === p)) {
                meta.participants.push({ id: p, admin: null });
              }
            }
          } else if (action === 'remove') {
            meta.participants = meta.participants.filter(p => !participants.includes(p.id));
          } else if (action === 'promote') {
            for (const p of participants) {
              const found = meta.participants.find(x => x.id === p);
              if (found) found.admin = 'admin';
            }
          } else if (action === 'demote') {
            for (const p of participants) {
              const found = meta.participants.find(x => x.id === p);
              if (found) found.admin = null;
            }
          }
          io.emit('groups', Object.values(groupStore));
          stores.broadcastChats();
        }
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        contactStore[contact.id] = { ...contactStore[contact.id], ...contact };
        // Track @lid <-> phone JID cross-reference mappings.
        stores.addLidMapping(contactStore[contact.id]);
        database.upsertContact(contactStore[contact.id]);
      }
      stores.backfillContactNames();
      stores.saveStore();
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        if (contactStore[update.id]) Object.assign(contactStore[update.id], update);
        else contactStore[update.id] = update;
        // Track @lid <-> phone JID mappings from the lid field.
        stores.addLidMapping(contactStore[update.id]);
        database.upsertContact(contactStore[update.id]);
      }
      stores.backfillContactNames();
      stores.saveStore();
    });

    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
      activeHistorySyncs++;
      stores.updateSyncState({ syncingHistory: true });
      try {
        // On-demand responses (from requestOlderHistory / "load older messages")
        // are flagged by Baileys with isLatest === undefined, unlike regular
        // connect-time syncs which always pass a boolean. Use that to keep the
        // MAX_MESSAGES_PER_CHAT cap for bulk initial sync while not discarding
        // history a user explicitly asked to backfill.
        const isOnDemand = isLatest === undefined;
        // --- Process contacts and build lid<->jid map ---
        for (const contact of contacts || []) {
          contactStore[contact.id] = { ...contactStore[contact.id], ...contact };
          // Track @lid <-> phone JID cross-reference mappings.
          stores.addLidMapping(contactStore[contact.id]);
          database.upsertContact(contactStore[contact.id]);
        }
        // --- Process chats ---
        for (const chat of chats || []) {
          const ts = stores.toTimestamp(chat.conversationTimestamp);
          chatStore[chat.id] = stores.normalizeChat({
            ...chatStore[chat.id],
            id: chat.id,
            name: chat.name || stores.chatDisplayName(chat.id),
            type: stores.getChatType(chat.id),
            unreadCount: chat.unreadCount || 0,
            timestamp: ts,
            lastMsg: chatStore[chat.id]?.lastMsg || '',
          });
          database.upsertChat(chatStore[chat.id]);
        }
        // --- Process history messages (this was the missing piece!) ---
        let historyMsgCount = 0;
        const touchedJids = new Set();
        for (const rawMsg of messages || []) {
          try {
            // History messages arrive pre-parsed; they have a .message field like live messages.
            if (!rawMsg?.message) continue;
            const key = rawMsg.key || {};
            const rawJid = key.remoteJid;
            if (!rawJid) continue;
            const jid = stores.getPreferredJid(rawJid);
            let m = stores.unwrapMessage(rawMsg.message);
            if (!m) continue;

            if (handleProtocolMessage(rawMsg, m, { emitEvent: false, isExternal: true })) {
              touchedJids.add(jid);
              continue;
            }

            // History messages can also carry verified business name certs;
            // capture them the same way the live messages.upsert handler does,
            // otherwise business contacts backfilled via history never get a name.
            if (!jid.endsWith('@g.us')) {
              const verifiedName = rawMsg.verifiedBizName || rawMsg.verifiedName;
              const pushName = rawMsg.pushName;
              if (verifiedName || pushName) {
                if (!contactStore[jid]) contactStore[jid] = { id: jid };
                let contactUpdated = false;
                if (verifiedName && contactStore[jid].verifiedName !== verifiedName) {
                  contactStore[jid].verifiedName = verifiedName;
                  contactUpdated = true;
                }
                if (pushName && !contactStore[jid].name && contactStore[jid].notify !== pushName) {
                  contactStore[jid].notify = pushName;
                  contactUpdated = true;
                }
                if (contactUpdated) database.upsertContact(contactStore[jid]);
              }
            }

            // Check if this is an ignored message type
            const keys = Object.keys(m);
            if (keys.length === 0) continue;
            const isIgnored = keys.length === 1 && (
              keys[0] === 'senderKeyDistributionMessage' ||
              keys[0] === 'protocolMessage' ||
              keys[0] === 'reactionMessage' ||
              keys[0] === 'peerDataOperationRequestMessage' ||
              keys[0] === 'emptyMessage'
            );
            if (isIgnored) continue;

            let content = '';
            let mediaType = 'text';
            let mediaUrl = null;
            // Extract text content from the most common history message shapes.
            // Media is only downloaded for on-demand requests (user clicked "load
            // older messages") - the bulk initial sync can cover thousands of
            // messages and would be too slow/heavy to fetch media for.
            if (m.conversation) {
              content = m.conversation;
            } else if (m.extendedTextMessage?.text) {
              content = m.extendedTextMessage.text;
            } else if (m.imageMessage) {
              content = m.imageMessage.caption || '';
              mediaType = 'image';
              if (isOnDemand) {
                try {
                  const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                  const ext = mime.extension(m.imageMessage.mimetype) || 'jpg';
                  const filename = `${Date.now()}.${ext}`;
                  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                  mediaUrl = `/media/${filename}`;
                } catch (e) {
                  console.error('[Bridge] History image download failed:', e.message);
                }
              }
            } else if (m.videoMessage) {
              content = m.videoMessage.caption || '';
              mediaType = 'video';
              if (isOnDemand) {
                try {
                  const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                  const ext = mime.extension(m.videoMessage.mimetype) || 'mp4';
                  const filename = `${Date.now()}.${ext}`;
                  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                  mediaUrl = `/media/${filename}`;
                } catch (e) {
                  console.error('[Bridge] History video download failed:', e.message);
                }
              }
            } else if (m.audioMessage) {
              content = m.audioMessage.ptt ? 'Voice message' : 'Audio file';
              mediaType = m.audioMessage.ptt ? 'voice' : 'audio';
              if (isOnDemand) {
                try {
                  const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                  const ext = mime.extension(m.audioMessage.mimetype) || 'ogg';
                  const filename = `${Date.now()}.${ext}`;
                  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                  mediaUrl = `/media/${filename}`;
                } catch (e) {
                  console.error('[Bridge] History audio download failed:', e.message);
                }
              }
            } else if (m.documentMessage) {
              content = `Document: ${m.documentMessage.fileName || 'file'}`;
              mediaType = 'document';
              if (isOnDemand) {
                try {
                  const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                  const safeName = (m.documentMessage.fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
                  const filename = `${Date.now()}-${safeName}`;
                  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                  mediaUrl = `/media/${filename}`;
                } catch (e) {
                  console.error('[Bridge] History document download failed:', e.message);
                }
              }
            } else if (m.stickerMessage) {
              content = 'Sticker';
              mediaType = 'sticker';
              if (isOnDemand) {
                try {
                  const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                  const filename = `${Date.now()}.webp`;
                  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                  mediaUrl = `/media/${filename}`;
                } catch (e) {
                  console.error('[Bridge] History sticker download failed:', e.message);
                }
              }
            } else if (m.locationMessage) {
              content = m.locationMessage.name || 'Shared location';
              mediaType = 'location';
            } else if (m.contactMessage) {
              content = `[Contact Card] ${m.contactMessage.displayName || 'Contact'}`;
            } else if (m.contactsArrayMessage) {
              const names = (m.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
              content = `[Contacts] ${names || 'multiple contacts'}`;
            } else if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
              const pollName = m.pollCreationMessage?.name || m.pollCreationMessageV2?.name || m.pollCreationMessageV3?.name || 'Poll';
              content = `[Poll] Question: ${pollName}`;
            } else if (m.groupInviteMessage) {
              content = `[Group Invite] Group: ${m.groupInviteMessage.groupName || 'invite link'}`;
            } else if (m.buttonsMessage || m.templateMessage || m.interactiveMessage || m.listMessage || m.highlyStructuredMessage || m.templateButtonReplyMessage) {
              content = stores.parseInteractiveMessageText(m);
            } else {
              content = '[Unsupported message type]';
            }
            const rawMsgMinimized = rawMsg.message ? {
              ...rawMsg.message,
              messageContextInfo: rawMsg.messageContextInfo || rawMsg.message?.messageContextInfo || null
            } : null;

            const msgRecord = {
              id: key.id,
              from: jid,
              jid,
              fromMe: Boolean(key.fromMe),
              participant: rawMsg.participant || key.participant || null,
              sender: rawMsg.pushName || rawMsg.participant || key.participant || null,
              operatorId: null,
              operatorName: null,
              content,
              mediaType,
              mediaUrl,
              fileName: m.documentMessage?.fileName || null,
              mimetype: m.imageMessage?.mimetype || m.videoMessage?.mimetype || m.audioMessage?.mimetype || m.documentMessage?.mimetype || null,
              timestamp: stores.toTimestamp(rawMsg.messageTimestamp),
              isGroup: jid.endsWith('@g.us'),
              editedAt: null,
              deleted: Boolean(rawMsg.message?.protocolMessage?.type === 0),
              clientTempId: null,
              status: rawMsg.status !== undefined ? rawMsg.status : null,
              raw: rawMsgMinimized,
            };
            if (!msgRecord.id || !msgRecord.jid) continue;
            // addMessageToStore deduplicates, sorts, trims, and persists to DB.
            stores.addMessageToStore(msgRecord, { skipTrim: isOnDemand });
            touchedJids.add(jid);
            historyMsgCount++;
          } catch (histErr) {
            // Don't let one bad history message crash the entire sync.
            console.warn('[Bridge] Skipping bad history message:', histErr.message);
          }
        }
        stores.broadcastChats();
        stores.backfillContactNames();
        stores.saveStore();
        console.log(`[Bridge] History sync: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${historyMsgCount} messages (isLatest=${isLatest})`);
        // Resolve any on-demand history requests (from "load older messages")
        // waiting on one of the jids that just received new messages.
        for (const jid of touchedJids) {
          resolvePendingHistoryRequest(jid);
        }
      } finally {
        activeHistorySyncs--;
        if (activeHistorySyncs <= 0) {
          activeHistorySyncs = 0;
          stores.updateSyncState({ syncingHistory: false });
        }
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        chatStore[chat.id] = stores.normalizeChat({
          ...chatStore[chat.id],
          id: chat.id,
          name: chat.name || stores.chatDisplayName(chat.id),
          type: stores.getChatType(chat.id),
          unreadCount: chat.unreadCount || 0,
          timestamp: stores.toTimestamp(chat.conversationTimestamp),
        });
        database.upsertChat(chatStore[chat.id]);
      }
      stores.broadcastChats();
      stores.saveStore();
    });
  } catch (err) {
    console.error('[Bridge] Error in connectToWhatsApp:', err.message);
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

// Parse message with media
async function parseMessage(raw, skipMedia = false) {
  let m = stores.unwrapMessage(raw.message);
  if (!m) return null;

  console.log('[DEBUG-EDIT] parseMessage incoming keys:', Object.keys(m), 'message.id:', raw.key?.id);

  const isIgnored = m.protocolMessage || m.senderKeyDistributionMessage || m.reactionMessage || m.peerDataOperationRequestMessage || m.emptyMessage || m.secretEncryptedMessage;
  if (isIgnored) return null;

  let content = '';
  let mediaUrl = null;
  let mediaType = 'text';
  let fileName = null;
  let mimetype = null;

  // --- Extract reply/quoted context from WhatsApp contextInfo ---
  // contextInfo is present on extendedTextMessage for text replies, and on
  // media message types for media replies. stanzaId = the quoted message ID.
  const contextInfo =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    null;

  let quotedMessageId = null;
  let quotedContent = null;
  let quotedSender = null;
  let quotedMediaType = null;

  if (contextInfo?.stanzaId) {
    quotedMessageId = contextInfo.stanzaId;
    quotedSender = contextInfo.participant || contextInfo.remoteJid || null;
    const qm = contextInfo.quotedMessage;
    if (qm) {
      const unwrappedQm = stores.unwrapMessage(qm);
      if (unwrappedQm) {
        quotedContent =
          unwrappedQm.conversation ||
          unwrappedQm.extendedTextMessage?.text ||
          unwrappedQm.imageMessage?.caption ||
          unwrappedQm.videoMessage?.caption ||
          unwrappedQm.documentMessage?.fileName ||
          null;
        if (unwrappedQm.imageMessage) quotedMediaType = 'image';
        else if (unwrappedQm.videoMessage) quotedMediaType = 'video';
        else if (unwrappedQm.audioMessage) quotedMediaType = unwrappedQm.audioMessage.ptt ? 'voice' : 'audio';
        else if (unwrappedQm.documentMessage) quotedMediaType = 'document';
        else if (unwrappedQm.stickerMessage) quotedMediaType = 'sticker';
        else if (unwrappedQm.locationMessage) quotedMediaType = 'location';
        else quotedMediaType = 'text';
      }
    }
  }

  if (m.conversation || m.extendedTextMessage) {
    content = m.conversation || m.extendedTextMessage?.text;
    mediaType = 'text';
  } else if (m.imageMessage) {
    content = m.imageMessage.caption || '';
    mediaType = 'image';
    mimetype = m.imageMessage.mimetype;
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const ext = mime.extension(mimetype) || 'jpg';
        const filename = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Image download failed:', e.message);
      }
    }
  } else if (m.videoMessage) {
    content = m.videoMessage.caption || '';
    mediaType = 'video';
    mimetype = m.videoMessage.mimetype;
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const ext = mime.extension(mimetype) || 'mp4';
        const filename = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Video download failed:', e.message);
      }
    }
  } else if (m.audioMessage) {
    mediaType = m.audioMessage.ptt ? 'voice' : 'audio';
    mimetype = m.audioMessage.mimetype;
    content = m.audioMessage.ptt ? 'Voice message' : 'Audio file';
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const ext = mime.extension(mimetype) || 'ogg';
        const filename = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Audio download failed:', e.message);
      }
    }
  } else if (m.documentMessage) {
    mediaType = 'document';
    mimetype = m.documentMessage.mimetype;
    fileName = m.documentMessage.fileName || 'document';
    content = `Document: ${fileName}`;
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Document download failed:', e.message);
      }
    }
  } else if (m.stickerMessage) {
    mediaType = 'sticker';
    content = 'Sticker';
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const filename = `${Date.now()}.webp`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Sticker download failed:', e.message);
      }
    }
  } else if (m.locationMessage) {
    mediaType = 'location';
    const { degreesLatitude: lat, degreesLongitude: lng, name } = m.locationMessage;
    content = name || 'Shared location';
    mediaUrl = `https://maps.google.com/?q=${lat},${lng}`;
  } else if (m.contactMessage) {
    content = `[Contact Card] ${m.contactMessage.displayName || 'Contact'}`;
  } else if (m.contactsArrayMessage) {
    const names = (m.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
    content = `[Contacts] ${names || 'multiple contacts'}`;
  } else if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    const pollName = m.pollCreationMessage?.name || m.pollCreationMessageV2?.name || m.pollCreationMessageV3?.name || 'Poll';
    content = `[Poll] Question: ${pollName}`;
  } else if (m.groupInviteMessage) {
    content = `[Group Invite] Group: ${m.groupInviteMessage.groupName || 'invite link'}`;
  } else if (m.buttonsMessage || m.templateMessage || m.interactiveMessage || m.listMessage || m.highlyStructuredMessage || m.templateButtonReplyMessage) {
    content = stores.parseInteractiveMessageText(m);
  } else {
    content = '[Unsupported message type]';
  }

  return {
    id: raw.key.id,
    from: raw.key.remoteJid,
    jid: raw.key.remoteJid,
    fromMe: raw.key.fromMe,
    participant: raw.participant || raw.key.participant,
    sender: raw.verifiedBizName || raw.verifiedName || raw.pushName || raw.participant || raw.key.participant || null,
    verifiedBizName: raw.verifiedBizName || null,
    verifiedName: raw.verifiedName || null,
    operatorId: null,
    operatorName: null,
    content,
    mediaType,
    mediaUrl,
    fileName,
    mimetype,
    timestamp: raw.messageTimestamp,
    isGroup: raw.key.remoteJid?.endsWith('@g.us'),
    quotedMessageId,
    quotedContent,
    quotedSender,
    quotedMediaType,
    status: raw.status !== undefined ? raw.status : null,
    raw: raw.message ? {
      ...raw.message,
      messageContextInfo: raw.messageContextInfo || raw.message?.messageContextInfo || null
    } : null,
  };
}

async function loadGroups() {
  const { groupStore, chatStore } = stores;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [id, meta] of Object.entries(groups)) {
      groupStore[id] = meta;
      const type = (meta.isCommunity || meta.isCommunityAnnounce) ? 'community' : 'group';
      if (!chatStore[id]) {
        chatStore[id] = stores.normalizeChat({
          id,
          name: meta.subject,
          type: type,
          unreadCount: 0,
          timestamp: meta.creation || 0,
          lastMsg: '',
        });
      } else {
        chatStore[id].name = meta.subject;
        chatStore[id].type = type;
      }
      database.upsertChat(chatStore[id]);
    }
    io.emit('groups', Object.values(groupStore));
    stores.migrateChatTypes();
    stores.broadcastChats();
    stores.saveStore();
    console.log(`[Bridge] Loaded ${Object.keys(groupStore).length} groups`);
  } catch (e) {
    console.error('[Bridge] Failed to load groups:', e);
  }
}

module.exports = {
  init,
  getSock,
  getStatus,
  getQrCodeData,
  connectToWhatsApp,
  disconnectWhatsApp,
  loadGroups,
  requestOlderHistory,
  markChatAsRead,
};
