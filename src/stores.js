/**
 * In-memory chat/message/contact state and chat assignment (locking) logic.
 *
 * `database`, `io`, and `sock` are injected via setters rather than
 * required directly, since this module is constructed before the
 * WhatsApp socket exists and would otherwise form a require() cycle
 * with db.js (db.js needs normalizeChat/normalizeMessageRecord from here).
 */

const fs = require('fs');
const path = require('path');

let ROOT_DIR = null;
let CONFIG = null;
let io = null;
let database = null;
let sock = null;

const messageStore = {};
const groupStore = {};
const contactStore = {};
const chatStore = {};
const operatorReads = {};
const flaggedMessages = {};

let connectorOperatorId = null;
let connectorOperatorName = null;
let linkingOperator = null;

let saveTimer = null;

const syncState = {
  syncing: false,
};

function getSyncState() {
  return syncState;
}

function updateSyncState(updates) {
  Object.assign(syncState, updates);
  if (io) {
    io.emit('sync_status', syncState);
  }
}

function init({ rootDir, config }) {
  ROOT_DIR = rootDir;
  CONFIG = config;
}

function setIo(ioInstance) { io = ioInstance; }
function setDatabase(db) { database = db; }
function setSock(sockInstance) { sock = sockInstance; }
function getSock() { return sock; }

function getConnectorOperator() {
  return { id: connectorOperatorId, name: connectorOperatorName };
}
function setConnectorOperator(id, name) {
  connectorOperatorId = id;
  connectorOperatorName = name;
}
function getLinkingOperator() { return linkingOperator; }
function setLinkingOperator(operator) { linkingOperator = operator; }

function clearInMemoryStores() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  for (const key of Object.keys(messageStore)) delete messageStore[key];
  for (const key of Object.keys(groupStore)) delete groupStore[key];
  for (const key of Object.keys(contactStore)) delete contactStore[key];
  for (const key of Object.keys(chatStore)) delete chatStore[key];
}

function jidNormalizedUser(jid) {
  if (!jid) return jid;
  if (jid.includes('@')) {
    const [user, domain] = jid.split('@');
    const cleanUser = user.split(':')[0];
    return `${cleanUser}@${domain}`;
  }
  return jid.split(':')[0];
}

function cleanJidToPhone(jid) {
  if (!jid) return '';
  if (jid.includes('@')) {
    const parts = jid.split('@');
    const domain = parts[1];
    if (domain === 's.whatsapp.net') {
      const num = parts[0].split(':')[0];
      return num.startsWith('+') ? num : '+' + num;
    }
    return parts[0];
  }
  if (jid.includes(':')) {
    const num = jid.split(':')[0];
    return num.startsWith('+') ? num : '+' + num;
  }
  return jid.startsWith('+') ? jid : '+' + jid;
}

function toTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts.trim()) return Number(ts) || 0;
  if (typeof ts === 'object' && 'low' in ts) return ts.low + ts.high * 4294967296;
  return 0;
}

// Backfill lastHandledBy* for chats from before the feature existed: outgoing
// operator messages already carry operatorId/operatorName, so the most recent
// one tells us who last handled the chat. Scans only the newest 100 messages;
// once a value is found it's stored on the chat and never rescanned. Messages
// sent from the linked phone itself have no operator fields and don't count.
function resolveLastHandledFromHistory(chat) {
  if (!chat?.id || chat.lastHandledByOperatorName) return;
  const msgs = messageStore[chat.id];
  if (!msgs || msgs.length === 0) return;
  const stop = Math.max(0, msgs.length - 100);
  for (let i = msgs.length - 1; i >= stop; i--) {
    const m = msgs[i];
    if (m.fromMe && (m.operatorName || m.operatorId)) {
      chat.lastHandledByOperatorId = m.operatorId || null;
      chat.lastHandledByOperatorName = m.operatorName || m.operatorId;
      chat.lastHandledAt = toTimestamp(m.timestamp) * 1000;
      if (chatStore[chat.id] === chat) database.upsertChat(chat);
      return;
    }
  }
}

function normalizeChat(chat = {}, operatorId = null) {
  resolveLastHandledFromHistory(chat);
  let phone = null;
  const id = chat.id;
  if (id && id.endsWith('@s.whatsapp.net')) {
    phone = id.split('@')[0].split(':')[0];
  }

  // Resolve verifiedName from contactStore if not already set on chat
  let verifiedName = chat.verifiedName || null;
  if (id && !verifiedName) {
    const contact = contactStore[id];
    if (contact?.verifiedName) {
      verifiedName = contact.verifiedName;
    }
  }

  // Refresh name if it's currently numeric/ambiguous or missing
  let currentName = chat.name;
  const isAmbiguous = !currentName || /^\+?\d+$/.test(currentName) || currentName.includes('@');
  if (isAmbiguous && id) {
    currentName = chatDisplayName(id);
  }

  const isGroup = chat.type === 'group' || chat.type === 'community' || (id && id.endsWith('@g.us'));
  let participants = chat.participants || [];
  let readOnly = Boolean(chat.readOnly || chat.isReadOnly || chat.left);

  if (isGroup && id) {
    if (groupStore[id]) {
      const g = groupStore[id];
      readOnly = g.readOnly !== undefined ? Boolean(g.readOnly) : false;
      if (Array.isArray(g.participants)) {
        participants = g.participants;
        if (participants.length === 0) {
          readOnly = true;
        }
      }
    } else if (Object.keys(groupStore).length > 0) {
      readOnly = true;
    }
  }

  const finalUnreadCount = operatorId && id ? getUnreadCountForOperator(id, operatorId) : Number(chat.unreadCount || 0);

  return {
    ...chat,
    phone: phone || chat.phone || null,
    unreadCount: finalUnreadCount,
    timestamp: toTimestamp(chat.timestamp),
    lastMsg: chat.lastMsg || '',
    name: currentName,
    verifiedName: verifiedName,
    assignedOperatorId: chat.assignedOperatorId || null,
    assignedOperatorName: chat.assignedOperatorName || null,
    assignedAt: chat.assignedAt || null,
    participants: participants,
    readOnly: readOnly,
    left: readOnly,
    awaitingManualReply: Boolean(chat.awaitingManualReply),
  };
}

function normalizeMessageRecord(msg = {}) {
  const participantJid = msg.participant || msg.sender;
  let resolvedSender = msg.sender;
  if (participantJid) {
    resolvedSender = resolveContactName(participantJid) || msg.sender;
    if (!resolvedSender || resolvedSender === participantJid || resolvedSender.endsWith('@s.whatsapp.net') || resolvedSender.includes(':')) {
      resolvedSender = cleanJidToPhone(participantJid);
    }
  }
  if (resolvedSender && (resolvedSender.endsWith('@s.whatsapp.net') || resolvedSender.includes(':') || /^\+?\d+$/.test(resolvedSender))) {
    resolvedSender = cleanJidToPhone(resolvedSender);
  }

  const flag = flaggedMessages[msg.id];
  return {
    ...msg,
    id: msg.id,
    from: msg.from || msg.jid,
    jid: msg.from || msg.jid,
    fromMe: Boolean(msg.fromMe),
    participant: msg.participant || null,
    sender: resolvedSender || msg.sender || null,
    operatorId: msg.operatorId || null,
    operatorName: msg.operatorName || null,
    content: msg.content || '',
    mediaType: msg.mediaType || 'text',
    mediaUrl: msg.mediaUrl || null,
    fileName: msg.fileName || null,
    mimetype: msg.mimetype || null,
    timestamp: toTimestamp(msg.timestamp),
    isGroup: Boolean(msg.isGroup),
    editedAt: msg.editedAt ? toTimestamp(msg.editedAt) : null,
    deleted: Boolean(msg.deleted),
    clientTempId: msg.clientTempId || null,
    quotedMessageId: msg.quotedMessageId || null,
    quotedContent: msg.quotedContent || null,
    quotedSender: msg.quotedSender || null,
    quotedMediaType: msg.quotedMediaType || null,
    status: msg.status !== undefined ? msg.status : null,
    edits: msg.edits ? [...msg.edits] : [],
    raw: msg.raw || null,
    isFlagged: Boolean(flag),
    flaggedByOperatorId: flag ? flag.flaggedByOperatorId : null,
    flaggedByOperatorName: flag ? flag.flaggedByOperatorName : null,
    flaggedNote: flag ? flag.note : null,
    flaggedAt: flag ? flag.flaggedAt : null,
  };
}

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

function parseInteractiveMessageText(m) {
  if (!m) return '';

  if (m.buttonsMessage) {
    let txt = m.buttonsMessage.contentText || '';
    const btns = (m.buttonsMessage.buttons || []).map(b => `[${b.buttonText?.displayText || ''}]`).join(' ');
    if (btns) txt += `\n\n${btns}`;
    return txt;
  }

  if (m.templateMessage) {
    let txt = m.templateMessage.hydratedTemplate?.hydratedContentText || '';
    const btns = (m.templateMessage.hydratedTemplate?.hydratedButtons || []).map(b => {
      const t = b.quickReplyButton?.displayText || b.urlButton?.displayText || b.callButton?.displayText || '';
      return t ? `[${t}]` : '';
    }).filter(Boolean).join(' ');
    if (btns) txt += `\n\n${btns}`;
    return txt;
  }

  if (m.interactiveMessage) {
    let txt = m.interactiveMessage.body?.text || '';
    let btnList = [];
    if (m.interactiveMessage.nativeFlowMessage?.buttons) {
      for (const btn of m.interactiveMessage.nativeFlowMessage.buttons) {
        try {
          const params = typeof btn.buttonParamsJson === 'string' ? JSON.parse(btn.buttonParamsJson) : btn.buttonParamsJson;
          const label = params?.display_text || btn.name;
          if (label) btnList.push(`[${label}]`);
        } catch {}
      }
    }
    if (btnList.length > 0) txt += `\n\n${btnList.join(' ')}`;
    return txt;
  }

  if (m.listMessage) {
    let txt = m.listMessage.description || m.listMessage.title || '';
    if (m.listMessage.buttonText) {
      txt += `\n\n[Menu: ${m.listMessage.buttonText}]`;
    }
    return txt;
  }

  if (m.highlyStructuredMessage) {
    return parseInteractiveMessageText({ templateMessage: m.highlyStructuredMessage.hydratedHsm });
  }

  if (m.templateButtonReplyMessage) {
    return m.templateButtonReplyMessage.selectedDisplayText || m.templateButtonReplyMessage.selectedId || '';
  }

  return '';
}

function loadStore() {
  try {
    const STORE_FILE = path.join(ROOT_DIR, 'store.json');
    const counts = database.counts();
    if (!counts.contacts && !counts.chats && !counts.messages && fs.existsSync(STORE_FILE)) {
      database.importLegacyStore(STORE_FILE);
      console.log('[Bridge] Migrated legacy store.json into SQLite');
    }

    // Load operator reads
    try {
      const reads = database.getAllOperatorReadPointers();
      for (const row of reads) {
        if (!operatorReads[row.operator_id]) {
          operatorReads[row.operator_id] = {};
        }
        operatorReads[row.operator_id][row.chat_id] = {
          messageId: row.last_read_message_id,
          timestamp: row.last_read_timestamp
        };
      }
    } catch (e) {
      console.error('[Bridge] Failed to load operator reads:', e.message);
    }

    // Load flagged messages
    try {
      const flags = database.getAllFlaggedMessages();
      for (const row of flags) {
        flaggedMessages[row.message_id] = {
          messageId: row.message_id,
          jid: row.jid,
          flaggedByOperatorId: row.flagged_by_operator_id,
          flaggedByOperatorName: row.flagged_by_operator_name,
          note: row.note,
          flaggedAt: row.flagged_at
        };
      }
    } catch (e) {
      console.error('[Bridge] Failed to load flagged messages:', e.message);
    }

    const state = database.loadState();
    for (const contact of state.contacts) {
      if (contact?.id) {
        contactStore[contact.id] = contact;
      }
    }
    for (const chat of state.chats) {
      if (chat?.id) chatStore[chat.id] = normalizeChat(chat);
    }
    for (const msg of state.messages) {
      if (!msg?.jid) continue;
      if (!messageStore[msg.jid]) messageStore[msg.jid] = [];
      msg.raw = null;
      messageStore[msg.jid].push(msg);
    }

    for (const jid of Object.keys(messageStore)) {
      syncChatPreviewFromLastMessage(jid);
    }
    connectorOperatorId = database.getMetadata('connector_operator_id');
    connectorOperatorName = database.getMetadata('connector_operator_name');
    migrateChatTypes();

    const storedOwnJid = database.getMetadata('current_logged_jid');
    if (storedOwnJid) {
      cleanupOwnNameFromContacts(storedOwnJid, 'Jafar Beldar');
    }

    console.log(
      `[Bridge] Loaded SQLite store: ${Object.keys(chatStore).length} chats, ${Object.keys(contactStore).length} contacts, ${Object.keys(messageStore).length} message threads`
    );
    if (connectorOperatorId) {
      console.log(`[Bridge] Loaded connector operator: ${connectorOperatorName} (${connectorOperatorId})`);
    }
  } catch (e) {
    console.error('[Bridge] Failed to load store:', e.message);
  }
}

function sortedChats(operatorId = null) {
  const chats = Object.values(chatStore).map(chat => normalizeChat(chat, operatorId));
  return chats.sort((a, b) => toTimestamp(b.timestamp) - toTimestamp(a.timestamp));
}

function resolveContactName(jid) {
  if (!jid) return null;
  const contact = contactStore[jid];
  if (contact?.name || contact?.verifiedName || contact?.notify) {
    return contact.name || contact.verifiedName || contact.notify;
  }
  return null;
}

function cleanupOwnNameFromContacts(ownPhone, ownName) {
  const ownPhoneClean = ownPhone ? cleanJidToPhone(ownPhone).replace(/^\+/, '') : '917262067842';
  const ownNames = new Set([ownName, 'Jafar Beldar'].filter(Boolean));
  console.log(`[Bridge] Cleaning up incorrect notify/name entries matching:`, Array.from(ownNames), `(ownPhone: ${ownPhoneClean})`);
  let updated = false;

  for (const [jid, contact] of Object.entries(contactStore)) {
    const contactPhoneClean = cleanJidToPhone(jid).replace(/^\+/, '');
    const isSelf = contactPhoneClean === ownPhoneClean;
    
    if (!isSelf) {
      let contactUpdated = false;
      if (ownNames.has(contact.notify)) {
        delete contact.notify;
        contactUpdated = true;
      }
      if (ownNames.has(contact.name)) {
        delete contact.name;
        contactUpdated = true;
      }
      if (contactUpdated) {
        database.upsertContact(contact);
        updated = true;
      }
    }
  }

  for (const [jid, chat] of Object.entries(chatStore)) {
    const chatPhoneClean = cleanJidToPhone(jid).replace(/^\+/, '');
    const isSelf = chatPhoneClean === ownPhoneClean;
    
    if (!isSelf && ownNames.has(chat.name)) {
      chat.name = null;
      const correctName = resolveContactName(jid) || chatDisplayName(jid);
      chat.name = correctName;
      database.upsertChat(chat);
      updated = true;
    }
  }

  if (updated) {
    console.log('[Bridge] Finished cleaning up incorrect names. Broadcasting updated chats.');
    broadcastChats();
    saveStore();
  }
}

function resolveChatStorageId(jid) {
  return jid;
}

function getPreferredJid(jid) {
  return jid;
}

function getChatType(jid) {
  if (!jid) return 'personal';
  if (jid.endsWith('@g.us')) {
    const groupMeta = groupStore[jid];
    if (groupMeta?.isCommunity || groupMeta?.isCommunityAnnounce) {
      return 'community';
    }
    return 'group';
  }
  if (jid.endsWith('@newsletter')) return 'channel';
  if (jid.endsWith('@broadcast')) return 'status';
  return 'personal';
}

function migrateChatTypes() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    const correctType = getChatType(jid);
    if (chat.type !== correctType) {
      chat.type = correctType;
      database.upsertChat(chat);
      updated = true;
    }
  }
  if (updated) {
    console.log('[Bridge] Migrated/corrected types for some chats');
    broadcastChats();
  }
}

function getMessagesForJid(jid) {
  return messageStore[jid] || [];
}

function toUnixSeconds(ts) {
  const normalized = toTimestamp(ts);
  if (!normalized) return 0;
  if (normalized > 100000000000) return Math.floor(normalized / 1000);
  return normalized;
}

function getThreadJids(jid) {
  return jid ? [jid] : [];
}

function findMessageInThread(jid, messageId) {
  if (!jid || !messageId) return null;
  const msgs = messageStore[jid];
  if (!msgs) return null;
  return msgs.find((msg) => msg.id === messageId) || null;
}

function backfillContactNames() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    if (chat.type !== 'personal') continue;
    const name = resolveContactName(jid);
    if (name) {
      if (chat.name !== name) {
        chat.name = name;
        updated = true;
      }
    } else {
      const normalized = normalizeChat(chat);
      if (chat.name !== normalized.name || chat.phone !== normalized.phone) {
        chat.name = normalized.name;
        chat.phone = normalized.phone;
        updated = true;
      }
    }
  }
  if (updated) {
    io.emit('chats', sortedChats());
    saveStore();
  }
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      for (const chat of Object.values(chatStore)) {
        chat.timestamp = toTimestamp(chat.timestamp);
      }
      for (const jid of Object.keys(messageStore)) {
        if (messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
          messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
        }
      }
      database.saveContacts(Object.values(contactStore).filter((contact) => contact?.id));
      database.saveChats(Object.values(chatStore).filter((chat) => chat?.id).map(normalizeChat));
    } catch (e) {
      console.error('[Bridge] Failed to save store:', e.message);
    }
  }, CONFIG.SAVE_DEBOUNCE_MS);
}

function addMessageToStore(msg, options = {}) {
  const normalized = normalizeMessageRecord(msg);
  const jid = normalized.jid;
  if (!jid || !normalized.id) return normalized;
  if (!messageStore[jid]) messageStore[jid] = [];
  const existingIndex = messageStore[jid].findIndex((item) => item.id === normalized.id);
  let finalMsg = normalized;
  if (existingIndex >= 0) {
    const existing = messageStore[jid][existingIndex];
    finalMsg = {
      ...normalized,
      operatorId: existing.operatorId || normalized.operatorId,
      operatorName: existing.operatorName || normalized.operatorName,
      edits: (existing.edits && existing.edits.length > 0) ? existing.edits : normalized.edits,
      clientTempId: existing.clientTempId || normalized.clientTempId,
    };
  }

  if (!options.skipDbWrite) {
    database.upsertMessage(finalMsg);
  }

  const memoryMsg = finalMsg.raw !== null ? { ...finalMsg, raw: null } : finalMsg;
  if (existingIndex >= 0) {
    messageStore[jid][existingIndex] = memoryMsg;
  } else {
    messageStore[jid].push(memoryMsg);
  }
  messageStore[jid].sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));

  if (!options.skipTrim && messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
    messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
  }
  return finalMsg;
}

function broadcastChats() {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const opId = socket.handshake?.query?.operatorId || 'default';
    socket.emit('chats', sortedChats(opId));
  }
}

let broadcastChatsTimer = null;
function scheduleBroadcastChats(delay = 200) {
  if (broadcastChatsTimer) return;
  broadcastChatsTimer = setTimeout(() => {
    broadcastChatsTimer = null;
    broadcastChats();
  }, delay);
}

let statsEmitTimer = null;
function scheduleStatsEmit(delay = 1000) {
  if (statsEmitTimer) return;
  statsEmitTimer = setTimeout(() => {
    statsEmitTimer = null;
    if (io && database) io.emit('stats', database.counts());
  }, delay);
}

function chatDisplayName(jid) {
  const resolvedName = resolveContactName(jid);
  const formattedPhone = cleanJidToPhone(jid);

  if (resolvedName) {
    const isAmbiguous = !resolvedName || resolvedName.length <= 2 || /^\+?\d+$/.test(resolvedName);
    if (isAmbiguous && jid && !jid.endsWith('@g.us')) {
      return `${resolvedName} (${formattedPhone})`;
    }
    return resolvedName;
  }

  if (jid.endsWith('@s.whatsapp.net')) {
    return formattedPhone;
  }

  return jid?.split('@')[0]?.split(':')[0] || jid;
}

function ensureChatExists(jid) {
  if (!chatStore[jid]) {
    chatStore[jid] = normalizeChat({
      id: jid,
      name: chatDisplayName(jid),
      type: getChatType(jid),
      unreadCount: 0,
      timestamp: 0,
      lastMsg: '',
    });
  }
  return chatStore[jid];
}

function isAssignableChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us');
}

function assignChat(jid, operator, options = {}) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  if (!operator?.id) return { ok: false, status: 400, message: 'Operator identity missing' };
  const chat = ensureChatExists(jid);
  const alreadyOwnedByOther = chat.assignedOperatorId && chat.assignedOperatorId !== operator.id;
  if (alreadyOwnedByOther && !options.force) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  chat.assignedOperatorId = operator.id;
  chat.assignedOperatorName = operator.name || operator.id;
  chat.assignedAt = new Date().toISOString();
  saveStore();
  broadcastChats();
  io.emit('assignment_updated', { jid, chat, action: 'assigned' });
  return { ok: true, chat };
}

function releaseChat(jid, operator, options = {}) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  const chat = chatStore[jid];
  if (!chat) return { ok: false, status: 404, message: 'Chat not found' };
  if (
    chat.assignedOperatorId &&
    operator?.id &&
    chat.assignedOperatorId !== operator.id &&
    !options.force
  ) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  chat.assignedOperatorId = null;
  chat.assignedOperatorName = null;
  chat.assignedAt = null;
  saveStore();
  broadcastChats();
  io.emit('assignment_updated', { jid, chat, action: 'released' });
  return { ok: true, chat };
}

function ensureChatLockForOperator(jid, operator) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  const chat = ensureChatExists(jid);
  if (!chat.assignedOperatorId) return assignChat(jid, operator);
  if (chat.assignedOperatorId !== operator?.id) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  return { ok: true, chat };
}

function updateChatPreview(jid, lastMsg, timestamp, fromMe = true, status = null) {
  const chat = ensureChatExists(jid);
  const resolved = resolveContactName(jid);
  if (resolved) {
    chat.name = resolved;
  }
  chat.lastMsg = lastMsg || '';
  chat.timestamp = toTimestamp(timestamp);
  chat.unreadCount = 0;
  chat.lastMsgFromMe = Boolean(fromMe);
  chat.lastMsgStatus = fromMe ? (status ?? null) : null;
  return chat;
}

function syncChatPreviewFromLastMessage(jid) {
  const msgs = messageStore[jid];
  if (!msgs || msgs.length === 0) return;
  const last = msgs[msgs.length - 1];
  const chat = ensureChatExists(jid);
  chat.lastMsg = last.content || '';
  chat.timestamp = toTimestamp(last.timestamp);
  chat.lastMsgFromMe = Boolean(last.fromMe);
  chat.lastMsgStatus = last.fromMe ? (last.status ?? null) : null;
  database.upsertChat(chat);
}

async function recordOutboundMessage({ jid, operator, result, message }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sentMsg = addMessageToStore({
    id: result?.key?.id || `sent-${Date.now()}`,
    from: jid,
    jid,
    fromMe: true,
    participant: null,
    sender: operator?.name || operator?.id || 'Unknown',
    operatorId: operator?.id || null,
    operatorName: operator?.name || operator?.id || null,
    content: message.content || '',
    mediaType: message.mediaType || 'text',
    mediaUrl: message.mediaUrl || null,
    fileName: message.fileName || null,
    mimetype: message.mimetype || null,
    timestamp,
    isGroup: jid?.endsWith('@g.us'),
    editedAt: null,
    deleted: false,
    clientTempId: message.clientTempId || null,
    quotedMessageId: message.quotedMessageId || null,
    quotedContent: message.quotedContent || null,
    quotedSender: message.quotedSender || null,
    quotedMediaType: message.quotedMediaType || null,
    status: result?.status !== undefined ? result.status : 1,
    raw: result?.message || null,
  });
  const chat = ensureChatExists(jid);
  chat.awaitingManualReply = false;
  if (operator?.id || operator?.name) {
    chat.lastHandledByOperatorId = operator.id || null;
    chat.lastHandledByOperatorName = operator.name || operator.id;
    chat.lastHandledAt = Date.now();
  }
  database.upsertChat(chat);
  updateChatPreview(jid, sentMsg.content, timestamp, true, sentMsg.status);
  saveStore();
  broadcastChats();
  io.emit('message', sentMsg);
  io.emit('stats', database.counts());
  return sentMsg;
}

function sendLockError(target, result) {
  const payload = {
    message: result.message,
    jid: target?.jid || null,
    assignedOperatorId: result.chat?.assignedOperatorId || null,
    assignedOperatorName: result.chat?.assignedOperatorName || null,
  };
  if (typeof target?.emit === 'function') target.emit('error', payload);
  return payload;
}

// --- Operator Reads ---
function setOperatorReadPointer(operatorId, chatId, messageId, timestamp) {
  if (!operatorId || !chatId) return;
  if (!operatorReads[operatorId]) {
    operatorReads[operatorId] = {};
  }
  operatorReads[operatorId][chatId] = { messageId, timestamp };
  database.setOperatorReadPointer(operatorId, chatId, messageId, timestamp);
}

function getOperatorReadPointer(operatorId, chatId) {
  if (operatorReads[operatorId] && operatorReads[operatorId][chatId]) {
    return operatorReads[operatorId][chatId];
  }
  return null;
}

// --- Message Flagging ---
function flagMessage(messageId, jid, operatorId, operatorName, note, timestamp) {
  flaggedMessages[messageId] = {
    messageId,
    jid,
    flaggedByOperatorId: operatorId,
    flaggedByOperatorName: operatorName,
    note,
    flaggedAt: timestamp
  };
  database.flagMessage(messageId, jid, operatorId, operatorName, note, timestamp);
}

function unflagMessage(messageId) {
  delete flaggedMessages[messageId];
  database.unflagMessage(messageId);
}

function getFlaggedMessages() {
  return Object.values(flaggedMessages)
    .sort((a, b) => b.flaggedAt - a.flaggedAt)
    .map((flag) => {
      let msg = findMessageInThread(flag.jid, flag.messageId);
      if (!msg) {
        try {
          const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(flag.messageId);
          if (row) msg = JSON.parse(row.payload);
        } catch (e) {
          // Non-critical
        }
      }
      return {
        ...flag,
        content: msg?.content || null,
        mediaType: msg?.mediaType || null,
        sender: msg?.sender || null,
        deleted: Boolean(msg?.deleted),
      };
    });
}

function getMessageFlag(messageId) {
  return flaggedMessages[messageId] || null;
}

function getUnreadCountForOperator(chatId, operatorId) {
  const chat = chatStore[chatId];
  if (!chat) return 0;

  let lastReadTimestamp = -1;
  let hasPointer = false;

  for (const reads of Object.values(operatorReads)) {
    const ptr = reads[chatId];
    if (ptr && ptr.timestamp > lastReadTimestamp) {
      lastReadTimestamp = ptr.timestamp;
      hasPointer = true;
    }
  }

  if (!hasPointer) {
    return Number(chat.unreadCount || 0);
  }

  return database.getUnreadCountForOperator(chatId, lastReadTimestamp);
}

module.exports = {
  setOperatorReadPointer,
  getOperatorReadPointer,
  flagMessage,
  unflagMessage,
  getFlaggedMessages,
  getMessageFlag,
  getUnreadCountForOperator,
  init,
  setIo,
  setDatabase,
  setSock,
  getSock,
  getConnectorOperator,
  setConnectorOperator,
  getLinkingOperator,
  setLinkingOperator,

  messageStore,
  groupStore,
  contactStore,
  chatStore,
  operatorReads,

  clearInMemoryStores,
  cleanJidToPhone,
  toTimestamp,
  findMessageInThread,
  normalizeChat,
  normalizeMessageRecord,
  unwrapMessage,
  parseInteractiveMessageText,
  loadStore,
  sortedChats,
  resolveContactName,
  cleanupOwnNameFromContacts,
  getPreferredJid,
  resolveChatStorageId,
  getChatType,
  migrateChatTypes,
  getMessagesForJid,
  backfillContactNames,
  saveStore,
  addMessageToStore,
  broadcastChats,
  scheduleBroadcastChats,
  scheduleStatsEmit,
  chatDisplayName,
  ensureChatExists,
  isAssignableChat,
  assignChat,
  releaseChat,
  ensureChatLockForOperator,
  updateChatPreview,
  syncChatPreviewFromLastMessage,
  recordOutboundMessage,
  sendLockError,
  getSyncState,
  updateSyncState,
  getThreadJids,
};
